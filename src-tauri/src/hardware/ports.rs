//! Listening TCP ports mapped to their owning process (GetExtendedTcpTable
//! under the hood via the `listeners` crate).

use std::collections::{HashMap, HashSet};
use std::net::IpAddr;
use std::sync::Mutex;

use crate::types::{PortListener, PortsStatus};

/// (port, pid) -> when this process first saw the socket. Lives outside the
/// payload so "listening since" survives polls but not a HUD restart.
#[derive(Default)]
pub struct PortsSeen(pub Mutex<HashMap<(u16, u32), i64>>);

/// How far a bound socket is reachable. An unspecified bind (0.0.0.0 / ::)
/// answers on every interface, so it counts as public even though the address
/// itself is neither routable nor private.
pub fn classify_exposure(ip: IpAddr) -> &'static str {
    if ip.is_loopback() {
        return "loopback";
    }
    if ip.is_unspecified() {
        return "public";
    }
    match ip {
        IpAddr::V4(v4) => {
            // 100.64/10 is CGNAT space, which on this class of machine means
            // Tailscale: reachable from the tailnet, not from the internet.
            // Calling it public would put a scary badge on every tailnet socket.
            let octets = v4.octets();
            let cgnat = octets[0] == 100 && (64..128).contains(&octets[1]);
            if v4.is_private() || v4.is_link_local() || cgnat {
                "lan"
            } else {
                "public"
            }
        }
        IpAddr::V6(v6) => {
            // ::ffff:a.b.c.d is a v4 socket wearing a v6 hat.
            if let Some(v4) = v6.to_ipv4_mapped() {
                return classify_exposure(IpAddr::V4(v4));
            }
            let seg = v6.segments();
            let unique_local = seg[0] & 0xfe00 == 0xfc00;
            let link_local = seg[0] & 0xffc0 == 0xfe80;
            if unique_local || link_local {
                "lan"
            } else {
                "public"
            }
        }
    }
}

pub fn status(seen: &PortsSeen) -> PortsStatus {
    let mut out = PortsStatus::default();
    let all = match listeners::get_all() {
        Ok(all) => all,
        Err(e) => {
            out.error = Some(e.to_string());
            return out;
        }
    };

    let now = chrono::Utc::now().timestamp();
    let mut first_seen = seen.0.lock().expect("ports seen");
    let mut live: HashSet<(u16, u32)> = HashSet::new();
    for l in all {
        let ip = l.socket.ip();
        let key = (l.socket.port(), l.process.pid);
        live.insert(key);
        out.listeners.push(PortListener {
            port: key.0,
            pid: key.1,
            process: l.process.name.clone(),
            // The crate only enumerates TCP; claiming UDP too would be a lie.
            proto: "tcp".into(),
            family: if l.socket.is_ipv4() { "v4" } else { "v6" }.into(),
            bind_addr: ip.to_string(),
            exposure: classify_exposure(ip).into(),
            first_seen_unix: *first_seen.entry(key).or_insert(now),
        });
    }
    // Sockets that stopped listening must not accumulate in the map.
    first_seen.retain(|k, _| live.contains(k));
    drop(first_seen);

    out.listeners.sort_by_key(|l| l.port);
    out.listeners.dedup_by(|a, b| a.port == b.port && a.pid == b.pid);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_exposure() {
        let cases = [
            ("127.0.0.1", "loopback"),
            ("::1", "loopback"),
            ("0.0.0.0", "public"),
            ("::", "public"),
            ("192.168.1.10", "lan"),
            ("10.0.0.4", "lan"),
            ("172.16.5.1", "lan"),
            ("169.254.1.1", "lan"),
            ("fd00::1", "lan"),
            ("fe80::1", "lan"),
            ("203.0.113.7", "public"),
            ("2606:4700::1111", "public"),
            // v4-mapped forms follow the v4 rules.
            ("::ffff:127.0.0.1", "loopback"),
            ("::ffff:192.168.1.10", "lan"),
        ];
        for (addr, want) in cases {
            let ip: IpAddr = addr.parse().expect(addr);
            assert_eq!(classify_exposure(ip), want, "{addr}");
        }
    }
}
