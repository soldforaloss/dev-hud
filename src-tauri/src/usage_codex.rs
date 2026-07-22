//! Codex usage: token totals and rate-limit snapshots from
//! `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`.
//!
//! Each rollout file logs `event_msg`/`token_count` events whose last
//! occurrence carries the session's cumulative `total_token_usage` and the
//! freshest `rate_limits` snapshot (used percent + reset time per window) —
//! the same local source CodexBar's cost scanner uses.

use std::collections::HashMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use chrono::{DateTime, Datelike, Local};
use walkdir::WalkDir;

use crate::fsutil::{extract_last_json_str, path_basename, read_head};
use crate::types::{ActiveSession, CodexUsage, RateWindow};

const SCAN_WINDOW_DAYS: u64 = 3;
const TAIL_BYTES: u64 = 256 * 1024;
/// A rollout touched within this window counts as an active session.
const ACTIVE_SESSION_SECS: u64 = 600;

#[derive(Clone, Default)]
struct SessionInfo {
    mtime_ms: u128,
    size: u64,
    total_tokens: u64,
    last_event_unix: i64,
    plan: Option<String>,
    primary: Option<RateWindow>,
    secondary: Option<RateWindow>,
    /// Working directory from the session_meta header line, parsed once.
    cwd: Option<String>,
}

#[derive(Default)]
pub struct CodexCache {
    files: HashMap<PathBuf, SessionInfo>,
}

pub type CodexShared = Arc<Mutex<CodexCache>>;

fn window_label(minutes: i64) -> String {
    match minutes {
        300 => "5h".into(),
        10_080 => "Weekly".into(),
        m if m > 0 && m % 1440 == 0 => format!("{}d", m / 1440),
        m if m > 0 && m % 60 == 0 => format!("{}h", m / 60),
        m => format!("{m}m"),
    }
}

fn parse_rate_window(v: &serde_json::Value) -> Option<RateWindow> {
    let used = v.get("used_percent")?.as_f64()?;
    let minutes = v.get("window_minutes").and_then(|m| m.as_i64()).unwrap_or(0);
    let resets = v.get("resets_at").and_then(|r| r.as_i64()).unwrap_or(0);
    Some(RateWindow {
        label: window_label(minutes),
        used_percent: used,
        resets_at_unix: resets,
        window_minutes: minutes,
    })
}

/// Read the tail of the file and parse the last `token_count` event.
/// Falls back to a full read when the tail contains none (tiny files).
fn parse_session(path: &PathBuf) -> Option<SessionInfo> {
    let mut file = fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let mut buf = String::new();
    if len > TAIL_BYTES {
        file.seek(SeekFrom::Start(len - TAIL_BYTES)).ok()?;
        file.read_to_string(&mut buf).ok().or_else(|| {
            // Seek landed mid-UTF-8 sequence; retry from the start.
            buf.clear();
            file.seek(SeekFrom::Start(0)).ok()?;
            file.read_to_string(&mut buf).ok()
        })?;
    } else {
        file.read_to_string(&mut buf).ok()?;
    }
    let mut last: Option<&str> = None;
    for line in buf.lines() {
        if line.contains("\"token_count\"") {
            last = Some(line);
        }
    }
    let line = last?;
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    let payload = v.get("payload")?;
    if payload.get("type")?.as_str()? != "token_count" {
        return None;
    }
    let total_tokens = payload
        .pointer("/info/total_token_usage/total_tokens")
        .and_then(|t| t.as_u64())
        .unwrap_or(0);
    let last_event_unix = v
        .get("timestamp")
        .and_then(|t| t.as_str())
        .and_then(|t| DateTime::parse_from_rfc3339(t).ok())
        .map(|d| d.timestamp())
        .unwrap_or(0);
    let limits = payload.get("rate_limits");
    let plan = limits
        .and_then(|l| l.get("plan_type"))
        .and_then(|p| p.as_str())
        .map(|p| p.to_string());
    let primary = limits
        .and_then(|l| l.get("primary"))
        .and_then(parse_rate_window);
    let secondary = limits
        .and_then(|l| l.get("secondary"))
        .and_then(parse_rate_window);
    Some(SessionInfo {
        mtime_ms: 0,
        size: len,
        total_tokens,
        last_event_unix,
        plan,
        primary,
        secondary,
        cwd: None, // filled by the caller, which caches it across re-parses
    })
}

pub fn compute(cache: &CodexShared) -> CodexUsage {
    let mut usage = CodexUsage::default();
    let Some(home) = dirs::home_dir() else {
        return usage;
    };
    let root = home.join(".codex").join("sessions");
    if !root.is_dir() {
        return usage;
    }
    usage.available = true;

    let cutoff = SystemTime::now() - std::time::Duration::from_secs(SCAN_WINDOW_DAYS * 86_400);
    let mut cache = cache.lock().expect("codex cache poisoned");
    let mut live: Vec<PathBuf> = Vec::new();

    for entry in WalkDir::new(&root)
        .max_depth(4)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let Ok(mtime) = meta.modified() else { continue };
        if mtime < cutoff {
            continue;
        }
        let mtime_ms = mtime
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let size = meta.len();
        let path_buf = path.to_path_buf();
        live.push(path_buf.clone());
        let stale = match cache.files.get(&path_buf) {
            Some(info) => info.mtime_ms != mtime_ms || info.size != size,
            None => true,
        };
        if stale {
            if let Some(mut info) = parse_session(&path_buf) {
                info.mtime_ms = mtime_ms;
                info.size = size;
                // cwd lives in the session_meta header; parse it once and
                // carry it forward on re-parses.
                info.cwd = cache
                    .files
                    .get(&path_buf)
                    .and_then(|old| old.cwd.clone())
                    .or_else(|| {
                        read_head(&path_buf, 16 * 1024)
                            .and_then(|head| extract_last_json_str(&head, "cwd"))
                    });
                cache.files.insert(path_buf, info);
            }
        }
    }
    cache.files.retain(|path, _| live.contains(path));

    let today = Local::now();
    let (ty, tm, td) = (today.year(), today.month(), today.day());
    let mut freshest: Option<&SessionInfo> = None;
    for info in cache.files.values() {
        if info.last_event_unix > 0 {
            let dt = Local
                .timestamp_opt(info.last_event_unix, 0)
                .single()
                .unwrap_or_else(|| Local::now());
            if dt.year() == ty && dt.month() == tm && dt.day() == td {
                usage.today_tokens_total += info.total_tokens;
                usage.today_sessions += 1;
            }
        }
        if freshest.map_or(true, |f| info.last_event_unix > f.last_event_unix) {
            freshest = Some(info);
        }
    }
    if let Some(f) = freshest {
        usage.plan = f.plan.clone();
        usage.primary = f.primary.clone();
        usage.secondary = f.secondary.clone();
        usage.last_event_unix = f.last_event_unix;
    }

    // Active sessions: rollouts touched in the last few minutes, deduped by cwd.
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let mut by_cwd: std::collections::HashMap<String, ActiveSession> =
        std::collections::HashMap::new();
    for (path, info) in cache.files.iter() {
        let age = ((now_ms.saturating_sub(info.mtime_ms)) / 1000) as u64;
        if age > ACTIVE_SESSION_SECS {
            continue;
        }
        let key = info
            .cwd
            .clone()
            .unwrap_or_else(|| path.to_string_lossy().into_owned());
        let name = info
            .cwd
            .as_deref()
            .map(path_basename)
            .unwrap_or_else(|| "session".into());
        let entry = by_cwd.entry(key).or_insert(ActiveSession {
            name,
            cwd: info.cwd.clone(),
            age_secs: age,
            // Codex rollouts name no model and report no cost — the card says
            // so rather than showing a plausible-looking blank.
            model: None,
            tokens: Some(info.total_tokens),
            cost_usd: None,
        });
        if age < entry.age_secs {
            entry.age_secs = age;
            entry.tokens = Some(info.total_tokens);
        }
    }
    let mut sessions: Vec<ActiveSession> = by_cwd.into_values().collect();
    sessions.sort_by_key(|s| s.age_secs);
    sessions.truncate(5);
    usage.active_sessions = sessions;
    usage
}

use chrono::TimeZone;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_labels() {
        assert_eq!(window_label(300), "5h");
        assert_eq!(window_label(10_080), "Weekly");
        assert_eq!(window_label(2880), "2d");
        assert_eq!(window_label(90), "90m");
    }

    #[test]
    fn parses_rate_window_json() {
        let v: serde_json::Value = serde_json::json!({
            "used_percent": 18.0,
            "window_minutes": 10080,
            "resets_at": 1784952203i64
        });
        let w = parse_rate_window(&v).unwrap();
        assert_eq!(w.label, "Weekly");
        assert!((w.used_percent - 18.0).abs() < 1e-9);
        assert_eq!(w.resets_at_unix, 1784952203);
    }
}
