//! OpenClaw gateway health.
//!
//! Polls the documented `GET /health` endpoint (instant, no session created —
//! the docs explicitly recommend it for monitors) and pairs that with process
//! stats for the gateway's node process from the shared scanner snapshot.
//! Port resolution mirrors OpenClaw: env `OPENCLAW_GATEWAY_PORT` →
//! `gateway.port` in `~/.openclaw/openclaw.json` → 18789.

use std::fs;
use std::sync::{Arc, Mutex};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use crate::scanner::Scanner;
use crate::types::OpenClawStatus;

const DEFAULT_PORT: u16 = 18789;

fn resolve_port() -> (bool, u16) {
    let installed = dirs::home_dir()
        .map(|h| h.join(".openclaw").is_dir())
        .unwrap_or(false);
    if let Ok(env_port) = std::env::var("OPENCLAW_GATEWAY_PORT") {
        if let Ok(p) = env_port.trim().parse::<u16>() {
            return (installed, p);
        }
    }
    let port = dirs::home_dir()
        .map(|h| h.join(".openclaw").join("openclaw.json"))
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|v| v.pointer("/gateway/port").and_then(|p| p.as_u64()))
        .map(|p| p as u16)
        .unwrap_or(DEFAULT_PORT);
    (installed, port)
}

/// Key match ignoring case and separators, so `p95_ms`, `p95Ms` and `P95`
/// all hit the same alias.
fn norm(key: &str) -> String {
    key.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_lowercase())
        .collect()
}

/// Depth-limited search for the first value under any of `aliases`.
///
/// `/health` is the gateway's contract, not ours, and it is free to nest or
/// rename these. Searching a few levels for known aliases means a schema
/// change degrades to "not reported" instead of to a wrong number.
fn find<'a>(v: &'a serde_json::Value, aliases: &[&str], depth: u8) -> Option<&'a serde_json::Value> {
    let obj = v.as_object()?;
    for (k, val) in obj {
        if aliases.contains(&norm(k).as_str()) && !val.is_null() {
            return Some(val);
        }
    }
    if depth == 0 {
        return None;
    }
    obj.values().find_map(|val| find(val, aliases, depth - 1))
}

fn find_f64(v: &serde_json::Value, aliases: &[&str]) -> Option<f64> {
    find(v, aliases, 3).and_then(|x| x.as_f64().or_else(|| x.as_str()?.parse().ok()))
}

fn find_u64(v: &serde_json::Value, aliases: &[&str]) -> Option<u64> {
    find_f64(v, aliases).filter(|n| *n >= 0.0).map(|n| n as u64)
}

fn find_str(v: &serde_json::Value, aliases: &[&str]) -> Option<String> {
    let s = find(v, aliases, 3)?.as_str()?.trim();
    if s.is_empty() {
        return None;
    }
    Some(s.chars().take(200).collect())
}

/// Fill whatever `/health` chose to report. Anything absent stays `None` — the
/// card says "not reported" rather than drawing a zero.
fn apply_health_metrics(out: &mut OpenClawStatus, v: &serde_json::Value) {
    out.requests_per_min = find_f64(v, &["requestsperminute", "requestspermin", "rpm", "requestrate"]);
    out.active_requests = find_u64(v, &["activerequests", "inflightrequests", "inflight", "active"]);
    out.queued_requests = find_u64(v, &["queuedrequests", "queuelength", "queued", "pending"]);
    out.connected_clients = find_u64(v, &["connectedclients", "clients", "connections"]);
    out.p50_ms = find_f64(v, &["p50ms", "p50", "latencyp50", "p50latency"]);
    out.p95_ms = find_f64(v, &["p95ms", "p95", "latencyp95", "p95latency"]);
    out.p99_ms = find_f64(v, &["p99ms", "p99", "latencyp99", "p99latency"]);
    out.version = find_str(v, &["version", "gatewayversion", "buildversion"]);
    out.last_error = find_str(v, &["lasterror", "lasterrormessage"]);
    // Error rate is reported either as a fraction or a percentage depending on
    // the emitter; normalise to a fraction so the threshold means one thing.
    out.error_rate = find_f64(v, &["errorrate", "errorratio", "errorpercent"])
        .map(|n| if n > 1.0 { n / 100.0 } else { n })
        .filter(|n| (0.0..=1.0).contains(n));
}

pub async fn status(http: &reqwest::Client, scanner: &Arc<Mutex<Scanner>>) -> OpenClawStatus {
    let (installed, port) = resolve_port();
    let mut out = OpenClawStatus {
        installed,
        port,
        ..Default::default()
    };

    let url = format!("http://127.0.0.1:{port}/health");
    let started = Instant::now();
    match http
        .get(&url)
        .timeout(std::time::Duration::from_secs(2))
        .send()
        .await
    {
        Ok(resp) => {
            // Any HTTP response means the gateway (or something) is listening.
            out.reachable = true;
            out.http_status = Some(resp.status().as_u16());
            out.latency_ms = Some(started.elapsed().as_millis() as u64);
            if let Ok(body) = resp.text().await {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&body) {
                    apply_health_metrics(&mut out, &v);
                }
            }
        }
        Err(_) => {
            out.reachable = false;
        }
    }

    // Process stats from the shared long-lived scanner (meaningful CPU deltas).
    // Brief sync lock; the probe above already completed, no await inside.
    if let Ok(scanner) = scanner.lock() {
        let sys = scanner.system();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let mut best: Option<(&sysinfo::Process, bool)> = None;
        let mut count = 0u32;
        for p in sys.processes().values() {
            let name = p.name().to_string_lossy().to_ascii_lowercase();
            if !matches!(name.as_str(), "node.exe" | "bun.exe" | "deno.exe") {
                continue;
            }
            let cmd = p
                .cmd()
                .iter()
                .map(|c| c.to_string_lossy().to_ascii_lowercase())
                .collect::<Vec<_>>()
                .join(" ");
            if !cmd.contains("openclaw") {
                continue;
            }
            count += 1;
            let is_gateway = cmd.contains("gateway");
            let better = match best {
                None => true,
                Some((cur, cur_gw)) => {
                    (is_gateway && !cur_gw) || (is_gateway == cur_gw && p.memory() > cur.memory())
                }
            };
            if better {
                best = Some((p, is_gateway));
            }
        }
        out.process_count = count;
        if let Some((p, _)) = best {
            out.pid = Some(p.pid().as_u32());
            out.uptime_secs = Some(now.saturating_sub(p.start_time()));
            out.mem_bytes = Some(p.memory());
            out.cpu_percent = Some(p.cpu_usage());
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::OpenClawStatus;

    fn apply(raw: &str) -> OpenClawStatus {
        let mut out = OpenClawStatus::default();
        apply_health_metrics(&mut out, &serde_json::from_str(raw).unwrap());
        out
    }

    #[test]
    fn reads_flat_and_nested_shapes_alike() {
        let flat = apply(r#"{"rpm": 42.5, "p95_ms": 310, "connectedClients": 3}"#);
        assert_eq!(flat.requests_per_min, Some(42.5));
        assert_eq!(flat.p95_ms, Some(310.0));
        assert_eq!(flat.connected_clients, Some(3));

        let nested = apply(r#"{"metrics":{"latency":{"p95":310},"requestsPerMinute":42.5}}"#);
        assert_eq!(nested.p95_ms, Some(310.0));
        assert_eq!(nested.requests_per_min, Some(42.5));
    }

    #[test]
    fn normalises_error_rate_whether_fraction_or_percent() {
        assert_eq!(apply(r#"{"errorRate": 0.07}"#).error_rate, Some(0.07));
        assert_eq!(apply(r#"{"errorPercent": 7}"#).error_rate, Some(0.07));
        // Out-of-range values are a schema mismatch, not a 900% error rate.
        assert_eq!(apply(r#"{"errorRate": 900}"#).error_rate, None);
    }

    #[test]
    fn absent_fields_stay_none_rather_than_zero() {
        let out = apply(r#"{"status":"ok"}"#);
        assert!(out.requests_per_min.is_none());
        assert!(out.p95_ms.is_none());
        assert!(out.active_requests.is_none());
        assert!(out.error_rate.is_none());
        assert!(out.version.is_none());
    }

    #[test]
    fn null_and_empty_values_are_not_treated_as_answers() {
        let out = apply(r#"{"version": "", "lastError": null, "p50": null}"#);
        assert!(out.version.is_none());
        assert!(out.last_error.is_none());
        assert!(out.p50_ms.is_none());
    }

    #[test]
    fn numeric_strings_are_accepted() {
        assert_eq!(apply(r#"{"queued": "5"}"#).queued_requests, Some(5));
    }

    #[test]
    fn key_matching_ignores_case_and_separators() {
        assert_eq!(norm("P95_Ms"), "p95ms");
        assert_eq!(norm("requests-per-minute"), "requestsperminute");
    }
}
