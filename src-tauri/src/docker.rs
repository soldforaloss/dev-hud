//! Docker containers via `docker ps --format "{{json .}}"` — one JSON object
//! per line. Distinguishes "not installed" from "daemon not running".
//! Live stats and inspect details are layered on afterwards, best-effort: when
//! those calls fail the base list still renders with the extras left `None`.

use std::time::Duration;

use chrono::DateTime;

use crate::cli::{is_not_found, run_silent, run_silent_timeout};
use crate::types::{ContainerInfo, DockerStatus, PortMapping};

/// The enrichment calls are secondary — never let them stall a poll cycle.
const ENRICH_TIMEOUT: Duration = Duration::from_secs(4);

pub fn status() -> DockerStatus {
    let mut out = DockerStatus::default();
    let result = run_silent("docker", &["ps", "--format", "{{json .}}"]);
    let output = match result {
        Err(e) if is_not_found(&e) => {
            out.installed = false;
            return out;
        }
        Err(e) => {
            out.installed = true;
            out.error = Some(e.to_string());
            return out;
        }
        Ok(o) => o,
    };
    out.installed = true;
    if !output.status.success() {
        // Typical failure: engine/daemon not running.
        let stderr = String::from_utf8_lossy(&output.stderr);
        let first = stderr.lines().next().unwrap_or("docker error");
        out.daemon_up = false;
        out.error = Some(if first.to_ascii_lowercase().contains("cannot connect") {
            "daemon not running".into()
        } else {
            first.chars().take(80).collect()
        });
        return out;
    }
    out.daemon_up = true;
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let g = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
        let ports = g("Ports");
        out.containers.push(ContainerInfo {
            id: g("ID"),
            name: g("Names"),
            image: g("Image"),
            state: g("State"),
            status: g("Status"),
            port_list: parse_port_mappings(&ports),
            ports: if ports.is_empty() { None } else { Some(ports) },
            health: None,
            restart_count: None,
            created_unix: None,
            cpu_percent: None,
            mem_bytes: None,
            mem_limit_bytes: None,
            net_rx_bytes: None,
            net_tx_bytes: None,
            block_read_bytes: None,
            block_write_bytes: None,
        });
    }
    // Nothing running means nothing to enrich — skip both extra spawns.
    if !out.containers.is_empty() {
        apply_stats(&mut out.containers);
        apply_inspect(&mut out.containers);
    }
    out.containers.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

// ---------- ports ----------

/// Parse the `Ports` column into structured mappings. Docker renders each
/// binding as `hostIp:hostPort->containerPort/proto`, comma-separated, and a
/// bare `containerPort/proto` when nothing is published to the host.
/// Port ranges (`8000-8002->8000-8002/tcp`) don't parse as a single port and
/// are dropped rather than guessed at.
fn parse_port_mappings(s: &str) -> Vec<PortMapping> {
    let mut out = Vec::new();
    for part in s.split(',') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        let (host, container) = match part.split_once("->") {
            Some((h, c)) => (Some(h.trim()), c.trim()),
            None => (None, part),
        };
        let (port_text, proto) = match container.split_once('/') {
            Some((p, proto)) => (p.trim(), proto.trim()),
            None => (container, "tcp"),
        };
        let Ok(container_port) = port_text.parse::<u16>() else {
            continue;
        };
        let (host_ip, host_port) = match host {
            Some(h) => parse_host_binding(h),
            None => (None, None),
        };
        out.push(PortMapping {
            container_port,
            host_port,
            host_ip,
            proto: proto.to_ascii_lowercase(),
        });
    }
    out
}

/// Split `0.0.0.0:5432`, `[::]:5432` or `:::5432` into address and port. The
/// port is always after the last colon; IPv6 shows up bracketed or bare.
fn parse_host_binding(s: &str) -> (Option<String>, Option<u16>) {
    match s.rsplit_once(':') {
        Some((ip, port)) => {
            let ip = ip.trim_start_matches('[').trim_end_matches(']');
            let ip = if ip.is_empty() { None } else { Some(ip.to_string()) };
            (ip, port.parse().ok())
        }
        None => (None, s.parse().ok()),
    }
}

// ---------- stats ----------

/// `docker stats` prints human-formatted sizes with either SI (kB/MB/GB) or
/// binary (KiB/MiB/GiB) suffixes. Unknown or absent values yield `None`, which
/// the UI must render as "not measured" rather than zero.
fn parse_size(s: &str) -> Option<u64> {
    let s = s.trim();
    let split = s.find(|c: char| c.is_ascii_alphabetic()).unwrap_or(s.len());
    let (number, unit) = s.split_at(split);
    let value: f64 = number.trim().parse().ok()?;
    let mult: f64 = match unit.trim().to_ascii_lowercase().as_str() {
        "" | "b" => 1.0,
        "kb" => 1e3,
        "mb" => 1e6,
        "gb" => 1e9,
        "tb" => 1e12,
        "kib" => 1024.0,
        "mib" => 1024f64.powi(2),
        "gib" => 1024f64.powi(3),
        "tib" => 1024f64.powi(4),
        _ => return None,
    };
    let scaled = value * mult;
    if !scaled.is_finite() || scaled < 0.0 {
        return None;
    }
    Some(scaled as u64)
}

/// `MemUsage`/`NetIO`/`BlockIO` are "left / right" pairs. Either side can be
/// `--` when the daemon has no figure, and that stays `None`.
fn parse_size_pair(s: &str) -> (Option<u64>, Option<u64>) {
    match s.split_once('/') {
        Some((a, b)) => (parse_size(a), parse_size(b)),
        None => (parse_size(s), None),
    }
}

fn parse_percent(s: &str) -> Option<f32> {
    s.trim().trim_end_matches('%').trim().parse().ok()
}

fn apply_stats(containers: &mut [ContainerInfo]) {
    let args = ["stats", "--no-stream", "--format", "{{json .}}"];
    let Ok(output) = run_silent_timeout("docker", &args, ENRICH_TIMEOUT) else {
        return;
    };
    if !output.status.success() {
        return;
    }
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let g = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("");
        // `ID` is the short id `docker ps` prints; `Container` is the full one.
        let Some(c) = find_by_id(containers, g("ID"), g("Container")) else {
            continue;
        };
        c.cpu_percent = parse_percent(g("CPUPerc"));
        let (used, limit) = parse_size_pair(g("MemUsage"));
        c.mem_bytes = used;
        c.mem_limit_bytes = limit;
        let (rx, tx) = parse_size_pair(g("NetIO"));
        c.net_rx_bytes = rx;
        c.net_tx_bytes = tx;
        let (read, write) = parse_size_pair(g("BlockIO"));
        c.block_read_bytes = read;
        c.block_write_bytes = write;
    }
}

// ---------- inspect ----------

fn apply_inspect(containers: &mut [ContainerInfo]) {
    let ids: Vec<String> = containers
        .iter()
        .map(|c| c.id.clone())
        .filter(|id| !id.is_empty())
        .collect();
    if ids.is_empty() {
        return;
    }
    // Batched over an argv array — never a joined shell string.
    let mut args: Vec<&str> = vec!["inspect", "--format", "{{json .}}"];
    args.extend(ids.iter().map(|s| s.as_str()));
    let Ok(output) = run_silent_timeout("docker", &args, ENRICH_TIMEOUT) else {
        return;
    };
    // Exit status is ignored on purpose: one container disappearing between
    // `ps` and `inspect` fails the whole call while the others still print.
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let full = v.get("Id").and_then(|x| x.as_str()).unwrap_or("");
        let Some(c) = find_by_id(containers, "", full) else {
            continue;
        };
        // An absent `State.Health` means the image declares no healthcheck.
        // That is "unknown", never "unhealthy".
        c.health = v
            .pointer("/State/Health/Status")
            .and_then(|x| x.as_str())
            .map(String::from);
        c.restart_count = v
            .get("RestartCount")
            .and_then(|x| x.as_u64())
            .and_then(|n| u32::try_from(n).ok());
        c.created_unix = v
            .get("Created")
            .and_then(|x| x.as_str())
            .and_then(parse_rfc3339_unix);
    }
}

/// Match a stats/inspect row back to a listed container. `docker ps` ids are
/// the 12-char prefix of the full id the other commands report.
fn find_by_id<'a>(
    containers: &'a mut [ContainerInfo],
    short: &str,
    full: &str,
) -> Option<&'a mut ContainerInfo> {
    containers.iter_mut().find(|c| {
        !c.id.is_empty() && ((!short.is_empty() && c.id == short) || full.starts_with(&c.id))
    })
}

fn parse_rfc3339_unix(s: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(s).ok().map(|t| t.timestamp())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_published_ipv4_and_ipv6_bindings() {
        let list = parse_port_mappings("0.0.0.0:5432->5432/tcp, :::5432->5432/tcp");
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].host_ip.as_deref(), Some("0.0.0.0"));
        assert_eq!(list[0].host_port, Some(5432));
        assert_eq!(list[0].container_port, 5432);
        assert_eq!(list[0].proto, "tcp");
        // The bare `:::` form and the bracketed form both mean "all IPv6".
        assert_eq!(list[1].host_ip.as_deref(), Some("::"));
        let bracketed = parse_port_mappings("[::]:5434->5432/tcp");
        assert_eq!(bracketed[0].host_ip.as_deref(), Some("::"));
        assert_eq!(bracketed[0].host_port, Some(5434));
    }

    #[test]
    fn bare_container_port_has_no_host_binding() {
        let list = parse_port_mappings("3000/tcp");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].container_port, 3000);
        assert_eq!(list[0].host_port, None);
        assert_eq!(list[0].host_ip, None);
        assert_eq!(list[0].proto, "tcp");
    }

    #[test]
    fn port_edge_cases_never_invent_entries() {
        assert!(parse_port_mappings("").is_empty());
        // Ranges can't collapse to one port — dropped rather than guessed.
        assert!(parse_port_mappings("0.0.0.0:8000-8002->8000-8002/tcp").is_empty());
        let udp = parse_port_mappings("0.0.0.0:53->53/udp");
        assert_eq!(udp[0].proto, "udp");
        // Host port lost to an odd render still keeps the container port.
        let odd = parse_port_mappings("0.0.0.0:->5432/tcp");
        assert_eq!(odd[0].container_port, 5432);
        assert_eq!(odd[0].host_port, None);
    }

    #[test]
    fn parses_si_and_binary_sizes() {
        assert_eq!(parse_size("126B"), Some(126));
        assert_eq!(parse_size("221kB"), Some(221_000));
        assert_eq!(parse_size("41.3MB"), Some(41_300_000));
        assert_eq!(parse_size("2GB"), Some(2_000_000_000));
        assert_eq!(parse_size("1TB"), Some(1_000_000_000_000));
        assert_eq!(parse_size("1.5KiB"), Some(1536));
        assert_eq!(parse_size("29.7MiB"), Some(31_142_707));
        assert_eq!(parse_size("15.6GiB"), Some(16_750_372_454));
        assert_eq!(parse_size("1TiB"), Some(1_099_511_627_776));
        assert_eq!(parse_size(" 12 "), Some(12));
    }

    #[test]
    fn unmeasured_sizes_are_none_not_zero() {
        assert_eq!(parse_size("--"), None);
        assert_eq!(parse_size(""), None);
        assert_eq!(parse_size("N/A"), None);
        assert_eq!(parse_size("12 furlongs"), None);
    }

    #[test]
    fn splits_stats_pairs() {
        assert_eq!(parse_size_pair("1.5GiB / 15.6GiB").0, Some(1_610_612_736));
        assert_eq!(parse_size_pair("1.75kB / 126B"), (Some(1750), Some(126)));
        // A missing right-hand side stays None rather than mirroring the left.
        assert_eq!(parse_size_pair("41.3MB"), (Some(41_300_000), None));
        assert_eq!(parse_size_pair("-- / --"), (None, None));
    }

    #[test]
    fn parses_cpu_percent_and_created() {
        assert_eq!(parse_percent("1.23%"), Some(1.23));
        assert_eq!(parse_percent("0.00%"), Some(0.0));
        assert_eq!(parse_percent("--"), None);
        assert_eq!(
            parse_rfc3339_unix("2026-07-02T22:13:28.918082702Z"),
            Some(1_783_030_408)
        );
        assert_eq!(parse_rfc3339_unix("not a time"), None);
    }
}
