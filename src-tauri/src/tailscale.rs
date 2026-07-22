//! Tailscale status via `tailscale status --json` — backend state, this
//! machine's tailnet IP/hostname, the path this node takes to the tailnet,
//! and the peer list.

use chrono::DateTime;
use serde_json::Value;

use crate::cli::{is_not_found, run_silent};
use crate::types::{TailscalePeer, TailscaleStatus};

/// Peer lists can run to hundreds on a shared tailnet; the card only ever
/// shows the top of the list.
const MAX_PEERS: usize = 50;

pub fn status() -> TailscaleStatus {
    let mut out = TailscaleStatus::default();
    let result = run_silent("tailscale", &["status", "--json"]);
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
        let stderr = String::from_utf8_lossy(&output.stderr);
        out.error = Some(stderr.lines().next().unwrap_or("tailscale error").to_string());
        return out;
    }
    let Ok(v) = serde_json::from_slice::<serde_json::Value>(&output.stdout) else {
        out.error = Some("unparseable tailscale status".into());
        return out;
    };
    out.state = v
        .get("BackendState")
        .and_then(|s| s.as_str())
        .map(String::from);
    out.magic_dns = v
        .get("MagicDNSSuffix")
        .and_then(|s| s.as_str())
        .map(String::from);
    if let Some(self_node) = v.get("Self") {
        out.hostname = self_node
            .get("HostName")
            .and_then(|h| h.as_str())
            .map(String::from);
        out.ip = first_tailscale_ip(self_node);
        out.relay = non_empty(self_node.get("Relay"));
        // A non-empty CurAddr is a peer-to-peer endpoint actually in use;
        // Relay stays populated as the DERP fallback either way.
        out.self_direct = non_empty(self_node.get("CurAddr")).is_some();
        out.key_expiry_unix = self_node
            .get("KeyExpiry")
            .and_then(|k| k.as_str())
            .and_then(parse_rfc3339_unix);
        out.advertised_routes = advertised_routes(self_node);
    }
    if let Some(peers) = v.get("Peer").and_then(|p| p.as_object()) {
        out.peers_total = peers.len() as u32;
        out.peers_online = peers
            .values()
            .filter(|p| p.get("Online").and_then(|o| o.as_bool()).unwrap_or(false))
            .count() as u32;
        // The exit node in use is whichever peer carries the flag.
        out.exit_node_active = peers
            .values()
            .find(|p| p.get("ExitNode").and_then(|e| e.as_bool()).unwrap_or(false))
            .and_then(|p| p.get("DNSName").and_then(|d| d.as_str()))
            .map(trim_dns_name)
            .filter(|n| !n.is_empty());
        let mut list: Vec<TailscalePeer> = peers.values().map(build_peer).collect();
        sort_peers(&mut list);
        list.truncate(MAX_PEERS);
        out.peers = list;
    }
    out
}

fn build_peer(v: &Value) -> TailscalePeer {
    let host = v.get("HostName").and_then(|h| h.as_str()).unwrap_or("");
    let dns = v.get("DNSName").and_then(|d| d.as_str()).unwrap_or("");
    let name = if host.is_empty() {
        trim_dns_name(dns)
    } else {
        host.to_string()
    };
    TailscalePeer {
        name,
        os: non_empty(v.get("OS")),
        online: v.get("Online").and_then(|o| o.as_bool()).unwrap_or(false),
        relay: non_empty(v.get("Relay")),
        direct: non_empty(v.get("CurAddr")).is_some(),
        last_seen: v
            .get("LastSeen")
            .and_then(|l| l.as_str())
            .and_then(last_seen),
        ip: first_tailscale_ip(v),
        exit_node: v.get("ExitNode").and_then(|e| e.as_bool()).unwrap_or(false),
    }
}

/// Online peers first, then alphabetical — the card is read top-down and the
/// reachable machines are what anyone is looking for.
fn sort_peers(peers: &mut [TailscalePeer]) {
    peers.sort_by(|a, b| {
        (!a.online, a.name.to_ascii_lowercase()).cmp(&(!b.online, b.name.to_ascii_lowercase()))
    });
}

/// Prefer the IPv4 — it's the address people actually type.
fn first_tailscale_ip(node: &Value) -> Option<String> {
    node.get("TailscaleIPs")
        .and_then(|ips| ips.as_array())
        .and_then(|ips| {
            ips.iter()
                .filter_map(|i| i.as_str())
                .find(|i| !i.contains(':'))
                .or_else(|| ips.first().and_then(|i| i.as_str()))
                .map(String::from)
        })
}

/// Subnets this node advertises. `PrimaryRoutes` is the authoritative list but
/// is omitted entirely when nothing is advertised; `AllowedIPs` is the
/// fallback, minus the node's own host routes — those are always present and
/// would otherwise show up as a subnet that was never advertised.
fn advertised_routes(node: &Value) -> Vec<String> {
    let primary = str_array(node.get("PrimaryRoutes"));
    if !primary.is_empty() {
        return primary;
    }
    let own = str_array(node.get("TailscaleIPs"));
    str_array(node.get("AllowedIPs"))
        .into_iter()
        .filter(|route| {
            let addr = route.split('/').next().unwrap_or(route);
            !own.iter().any(|ip| ip == addr)
        })
        .collect()
}

fn str_array(v: Option<&Value>) -> Vec<String> {
    v.and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str()).map(String::from).collect())
        .unwrap_or_default()
}

fn non_empty(v: Option<&Value>) -> Option<String> {
    v.and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
}

fn trim_dns_name(s: &str) -> String {
    s.trim().trim_end_matches('.').to_string()
}

/// Tailscale writes the zero time for peers it is currently connected to.
/// That means "not applicable", not a timestamp from year 1.
fn last_seen(s: &str) -> Option<String> {
    let s = s.trim();
    if s.is_empty() || s.starts_with("0001-01-01") {
        None
    } else {
        Some(s.to_string())
    }
}

fn parse_rfc3339_unix(s: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(s).ok().map(|t| t.timestamp())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn builds_peer_from_real_field_names() {
        let peer = build_peer(&json!({
            "HostName": "OSRS2",
            "DNSName": "osrs2.taild18f25.ts.net.",
            "OS": "windows",
            "Online": true,
            "Relay": "lax",
            "CurAddr": "192.168.0.251:41641",
            "LastSeen": "0001-01-01T00:00:00Z",
            "TailscaleIPs": ["100.77.17.117", "fd7a:115c:a1e0::1"],
            "ExitNode": false
        }));
        assert_eq!(peer.name, "OSRS2");
        assert_eq!(peer.os.as_deref(), Some("windows"));
        assert!(peer.online && peer.direct && !peer.exit_node);
        assert_eq!(peer.relay.as_deref(), Some("lax"));
        assert_eq!(peer.ip.as_deref(), Some("100.77.17.117"));
        // Connected peers carry the zero time — that is not a "last seen".
        assert_eq!(peer.last_seen, None);
    }

    #[test]
    fn peer_falls_back_to_dns_name_and_survives_missing_fields() {
        let peer = build_peer(&json!({ "DNSName": "anon.taild18f25.ts.net." }));
        assert_eq!(peer.name, "anon.taild18f25.ts.net");
        assert!(!peer.online && !peer.direct);
        assert_eq!(peer.relay, None);
        assert_eq!(peer.ip, None);
        // An entry with nothing usable must still not panic.
        let empty = build_peer(&json!({}));
        assert_eq!(empty.name, "");
    }

    #[test]
    fn relayed_peer_is_not_direct() {
        let peer = build_peer(&json!({
            "HostName": "iphone", "Relay": "lax", "CurAddr": "", "Online": true
        }));
        assert!(!peer.direct);
        assert_eq!(peer.relay.as_deref(), Some("lax"));
    }

    #[test]
    fn sorts_online_first_then_by_name() {
        let mk = |name: &str, online: bool| TailscalePeer {
            name: name.into(),
            os: None,
            online,
            relay: None,
            direct: false,
            last_seen: None,
            ip: None,
            exit_node: false,
        };
        let mut peers = vec![
            mk("zeta", true),
            mk("alpha", false),
            mk("Beta", true),
            mk("omega", false),
        ];
        sort_peers(&mut peers);
        let names: Vec<&str> = peers.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, ["Beta", "zeta", "alpha", "omega"]);
    }

    #[test]
    fn advertised_routes_prefer_primary_and_drop_own_host_routes() {
        let with_primary = json!({
            "PrimaryRoutes": ["10.0.0.0/24"],
            "AllowedIPs": ["100.87.125.15/32", "10.0.0.0/24"],
            "TailscaleIPs": ["100.87.125.15"]
        });
        assert_eq!(advertised_routes(&with_primary), ["10.0.0.0/24"]);

        // No PrimaryRoutes key at all — the shape this machine actually emits.
        let bare = json!({
            "AllowedIPs": ["100.87.125.15/32", "fd7a:115c:a1e0::2e36:7d0f/128"],
            "TailscaleIPs": ["100.87.125.15", "fd7a:115c:a1e0::2e36:7d0f"]
        });
        assert!(advertised_routes(&bare).is_empty());

        let subnet_router = json!({
            "AllowedIPs": ["100.87.125.15/32", "192.168.1.0/24"],
            "TailscaleIPs": ["100.87.125.15"]
        });
        assert_eq!(advertised_routes(&subnet_router), ["192.168.1.0/24"]);
    }

    #[test]
    fn parses_key_expiry_and_trims_dns_names() {
        assert_eq!(
            parse_rfc3339_unix("2026-10-28T21:33:57Z"),
            Some(1_793_223_237)
        );
        assert_eq!(parse_rfc3339_unix(""), None);
        assert_eq!(trim_dns_name("exit.taild18f25.ts.net."), "exit.taild18f25.ts.net");
    }
}
