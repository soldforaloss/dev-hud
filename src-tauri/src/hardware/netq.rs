//! Network quality: ping latency/jitter/loss with a TCP-connect fallback for
//! ICMP-blocked networks, plus Wi-Fi info from `netsh wlan`.
//!
//! `ping.exe` output is localized, so parsing keys off the universal
//! `<number>ms` shape rather than the word "time".

use std::collections::VecDeque;
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::cli::run_silent_timeout;
use crate::types::NetQuality;

const WINDOW: usize = 20;
/// Resolving on every poll would mostly time the OS resolver cache and cost a
/// process spawn's worth of work for nothing.
const DNS_EVERY: u32 = 4;
/// Used when the probe host is a bare IP, so there is no name to resolve.
const DNS_FALLBACK_HOST: &str = "cloudflare.com:443";

#[derive(Default)]
pub struct NetqState {
    /// Recent samples, -1.0 = lost probe.
    samples: VecDeque<f32>,
    consecutive_icmp_failures: u32,
    polls: u32,
}

pub type NetqShared = Mutex<NetqState>;

/// Extract latency from a single-probe ping output, any locale:
/// "Reply from 1.1.1.1: bytes=32 time=12ms TTL=58" / "Zeit=12ms" / "time<1ms".
pub fn parse_ping_ms(stdout: &str) -> Option<f32> {
    for line in stdout.lines() {
        let lower = line.to_ascii_lowercase();
        if !lower.contains("ttl") {
            continue;
        }
        // Find a `=Nms` or `<Nms` fragment.
        for token in lower.split_whitespace() {
            if let Some(ms_pos) = token.find("ms") {
                let head = &token[..ms_pos];
                let digits: String = head
                    .chars()
                    .rev()
                    .take_while(|c| c.is_ascii_digit())
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect();
                if !digits.is_empty() {
                    let value: f32 = digits.parse().ok()?;
                    // "time<1ms" means sub-millisecond.
                    return Some(if head.contains('<') { 0.5 } else { value });
                }
            }
        }
    }
    None
}

fn probe_icmp(host: &str) -> Option<f32> {
    let out = run_silent_timeout("ping", &["-n", "1", "-w", "1500", host], Duration::from_secs(4)).ok()?;
    if !out.status.success() {
        return None;
    }
    parse_ping_ms(&String::from_utf8_lossy(&out.stdout))
}

fn probe_tcp(host: &str) -> Option<f32> {
    let addr = format!("{host}:443");
    let resolved = addr.parse().ok().or_else(|| {
        use std::net::ToSocketAddrs;
        addr.to_socket_addrs().ok()?.next()
    })?;
    let started = Instant::now();
    TcpStream::connect_timeout(&resolved, Duration::from_millis(1500)).ok()?;
    Some(started.elapsed().as_secs_f32() * 1000.0)
}

pub fn parse_netsh(stdout: &str) -> (Option<String>, Option<u32>, Option<f32>) {
    let mut ssid = None;
    let mut signal = None;
    let mut rate = None;
    for line in stdout.lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let key = key.trim().to_ascii_lowercase();
        let value = value.trim();
        if key == "ssid" && ssid.is_none() && !value.is_empty() {
            ssid = Some(value.to_string());
        } else if key.starts_with("signal") {
            signal = value.trim_end_matches('%').trim().parse().ok();
        } else if key.contains("receive rate") {
            rate = value
                .split_whitespace()
                .next()
                .and_then(|v| v.parse().ok());
        }
    }
    (ssid, signal, rate)
}

/// The wlan adapter's own name, e.g. "Wi-Fi". Sits next to `parse_netsh`
/// because it reads the same block, but the SSID line would shadow it.
pub fn parse_netsh_wlan_name(stdout: &str) -> Option<String> {
    stdout.lines().find_map(|line| {
        let (key, value) = line.split_once(':')?;
        let key = key.trim().to_ascii_lowercase();
        (key == "name" && !value.trim().is_empty()).then(|| value.trim().to_string())
    })
}

/// First connected adapter from `netsh interface show interface`. Columns are
/// space-aligned and the header is localized, so rows are matched on the
/// untranslated-in-practice state words and the name is taken as the tail.
pub fn parse_netsh_interface(stdout: &str) -> Option<String> {
    for line in stdout.lines() {
        let cols: Vec<&str> = line
            .split("  ")
            .map(str::trim)
            .filter(|c| !c.is_empty())
            .collect();
        if cols.len() < 4 {
            continue;
        }
        let connected = cols[1].eq_ignore_ascii_case("Connected");
        let dedicated = cols[2].eq_ignore_ascii_case("Dedicated");
        if connected && dedicated {
            return Some(cols[3].to_string());
        }
    }
    None
}

/// `to_socket_addrs` is the same resolver path the rest of the app uses, so it
/// measures what the app would actually wait for — cache hits included.
fn probe_dns(host: &str) -> Option<f32> {
    let target = if host.parse::<std::net::IpAddr>().is_ok() {
        DNS_FALLBACK_HOST.to_string()
    } else {
        format!("{host}:443")
    };
    let started = Instant::now();
    let mut addrs = target.to_socket_addrs().ok()?;
    addrs.next()?;
    Some(started.elapsed().as_secs_f32() * 1000.0)
}

pub fn poll(state: &NetqShared, host: &str) -> NetQuality {
    let measure_dns = {
        let mut st = state.lock().expect("netq state");
        let due = st.polls % DNS_EVERY == 0;
        st.polls = st.polls.wrapping_add(1);
        due
    };
    let dns_ms = if measure_dns { probe_dns(host) } else { None };

    let mut mode = "icmp";
    let latency = {
        let icmp = probe_icmp(host);
        let mut st = state.lock().expect("netq state");
        match icmp {
            Some(ms) => {
                st.consecutive_icmp_failures = 0;
                Some(ms)
            }
            None => {
                st.consecutive_icmp_failures += 1;
                if st.consecutive_icmp_failures >= 2 {
                    mode = "tcp";
                    probe_tcp(host)
                } else {
                    None
                }
            }
        }
    };

    let mut st = state.lock().expect("netq state");
    st.samples.push_back(latency.unwrap_or(-1.0));
    while st.samples.len() > WINDOW {
        st.samples.pop_front();
    }
    let good: Vec<f32> = st.samples.iter().copied().filter(|v| *v >= 0.0).collect();
    let avg = if good.is_empty() {
        None
    } else {
        Some(good.iter().sum::<f32>() / good.len() as f32)
    };
    let jitter = if good.len() >= 2 {
        let diffs: Vec<f32> = good.windows(2).map(|w| (w[1] - w[0]).abs()).collect();
        Some(diffs.iter().sum::<f32>() / diffs.len() as f32)
    } else {
        None
    };
    let loss = if st.samples.is_empty() {
        0.0
    } else {
        st.samples.iter().filter(|v| **v < 0.0).count() as f32 / st.samples.len() as f32 * 100.0
    };
    if latency.is_none() && mode == "tcp" {
        mode = "none";
    }

    let wlan = match run_silent_timeout(
        "netsh",
        &["wlan", "show", "interfaces"],
        Duration::from_secs(4),
    ) {
        Ok(out) if out.status.success() => Some(String::from_utf8_lossy(&out.stdout).into_owned()),
        _ => None,
    };
    let (wifi_ssid, wifi_signal, link_mbps) = match &wlan {
        Some(text) => parse_netsh(text),
        None => (None, None, None),
    };

    // An associated SSID is the only proof the wlan block describes a live
    // link; the command succeeds with an empty block when the radio is off.
    let (interface_name, link_type) = match (&wlan, &wifi_ssid) {
        (Some(text), Some(_)) => (parse_netsh_wlan_name(text), Some("wifi".to_string())),
        _ => {
            let wired = run_silent_timeout(
                "netsh",
                &["interface", "show", "interface"],
                Duration::from_secs(4),
            )
            .ok()
            .filter(|o| o.status.success())
            .and_then(|o| parse_netsh_interface(&String::from_utf8_lossy(&o.stdout)));
            match wired {
                Some(name) => (Some(name), Some("ethernet".to_string())),
                None => (None, None),
            }
        }
    };

    NetQuality {
        mode: mode.into(),
        latency_ms: latency,
        avg_ms: avg,
        jitter_ms: jitter,
        loss_percent: loss,
        samples: st.samples.iter().copied().collect(),
        wifi_ssid,
        wifi_signal,
        link_mbps,
        dns_ms,
        interface_name,
        link_type,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_english_and_german_ping() {
        let en = "Reply from 1.1.1.1: bytes=32 time=12ms TTL=58";
        let de = "Antwort von 1.1.1.1: Bytes=32 Zeit=9ms TTL=58";
        let sub = "Reply from 1.1.1.1: bytes=32 time<1ms TTL=58";
        assert_eq!(parse_ping_ms(en), Some(12.0));
        assert_eq!(parse_ping_ms(de), Some(9.0));
        assert_eq!(parse_ping_ms(sub), Some(0.5));
        assert_eq!(parse_ping_ms("Request timed out."), None);
    }

    #[test]
    fn parses_netsh_wlan() {
        let sample = "    SSID                   : HomeNet\n    Signal                 : 86%\n    Receive rate (Mbps)    : 573.5\n";
        let (ssid, signal, rate) = parse_netsh(sample);
        assert_eq!(ssid.as_deref(), Some("HomeNet"));
        assert_eq!(signal, Some(86));
        assert_eq!(rate, Some(573.5));
    }

    #[test]
    fn parses_wlan_adapter_name() {
        let sample = "\nThere is 1 interface on the system:\n\n    Name                   : Wi-Fi\n    Description            : Intel(R) Wi-Fi 6 AX201\n    State                  : connected\n    SSID                   : HomeNet\n";
        assert_eq!(parse_netsh_wlan_name(sample).as_deref(), Some("Wi-Fi"));
        assert_eq!(parse_netsh_wlan_name("    SSID   : HomeNet\n"), None);
    }

    #[test]
    fn picks_first_connected_dedicated_interface() {
        let sample = "\nAdmin State    State          Type             Interface Name\n-------------------------------------------------------------------------\nEnabled        Disconnected   Dedicated        Wi-Fi\nEnabled        Connected      Dedicated        Ethernet 2\nEnabled        Connected      Loopback         Loopback Pseudo-Interface 1\n";
        assert_eq!(
            parse_netsh_interface(sample).as_deref(),
            Some("Ethernet 2")
        );
        let none_connected = "Enabled        Disconnected   Dedicated        Wi-Fi\n";
        assert_eq!(parse_netsh_interface(none_connected), None);
    }
}
