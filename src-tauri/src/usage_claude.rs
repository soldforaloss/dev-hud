//! Claude Code usage.
//!
//! Two independent sources, merged into one payload:
//! 1. Local transcript scan: `~/.claude/projects/**/*.jsonl` assistant entries
//!    with `message.usage`, deduped by (message.id, requestId) — the same rule
//!    ccusage/CodexBar use, because resumed sessions copy history into new
//!    files. Gives tokens, estimated cost, hourly sparkline, 5h block.
//! 2. OAuth usage API: `GET https://api.anthropic.com/api/oauth/usage` with the
//!    token from `~/.claude/.credentials.json` — gives the real 5h/weekly
//!    utilization percentages. Optional; absence degrades gracefully.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use chrono::{DateTime, Local, TimeZone};
use walkdir::WalkDir;

use crate::fsutil::{extract_last_json_str, path_basename, read_tail};
use crate::types::{ActiveSession, ClaudeUsage, HourBucket, ModelUsage, RateWindow, TokenTotals};

const SCAN_WINDOW_DAYS: u64 = 8;
const BLOCK_SECS: i64 = 5 * 3600;
/// A transcript touched within this window counts as an active session.
const ACTIVE_SESSION_SECS: u64 = 600;

#[derive(Clone)]
struct Entry {
    key: u64,
    hour: i64,
    model: String,
    tokens: TokenTotals,
}

#[derive(Default)]
struct FileCache {
    mtime_ms: u128,
    size: u64,
    entries: Vec<Entry>,
}

#[derive(Default)]
pub struct ClaudeCache {
    files: HashMap<PathBuf, FileCache>,
}

pub type ClaudeShared = Arc<Mutex<ClaudeCache>>;

fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// $/MTok: (input, output, cache write, cache read). Unknown models fall back
/// to Opus-tier rates; the UI labels every cost figure as an estimate.
fn pricing(model: &str) -> (f64, f64, f64, f64) {
    let m = model.to_ascii_lowercase();
    if m.contains("haiku") {
        (1.0, 5.0, 1.25, 0.10)
    } else if m.contains("sonnet") {
        (3.0, 15.0, 3.75, 0.30)
    } else {
        // opus / fable / unknown top-tier
        (15.0, 75.0, 18.75, 1.50)
    }
}

fn cost_of(model: &str, t: &TokenTotals) -> f64 {
    let (i, o, w, r) = pricing(model);
    (t.input as f64 * i
        + t.output as f64 * o
        + t.cache_write as f64 * w
        + t.cache_read as f64 * r)
        / 1_000_000.0
}

fn hash_key(a: &str, b: &str) -> u64 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut h = DefaultHasher::new();
    a.hash(&mut h);
    b.hash(&mut h);
    h.finish()
}

fn parse_file(path: &PathBuf) -> Vec<Entry> {
    let Ok(file) = fs::File::open(path) else {
        return vec![];
    };
    let reader = BufReader::new(file);
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for line in reader.lines() {
        let Ok(line) = line else { break };
        // Cheap pre-filter before JSON parsing.
        if !line.contains("\"usage\"") || !line.contains("\"assistant\"") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if v.get("type").and_then(|t| t.as_str()) != Some("assistant") {
            continue;
        }
        let Some(msg) = v.get("message") else { continue };
        let Some(usage) = msg.get("usage") else { continue };
        let model = msg
            .get("model")
            .and_then(|m| m.as_str())
            .unwrap_or("unknown");
        if model == "<synthetic>" {
            continue;
        }
        let id = msg
            .get("id")
            .and_then(|i| i.as_str())
            .or_else(|| v.get("uuid").and_then(|u| u.as_str()))
            .unwrap_or("");
        let req = v.get("requestId").and_then(|r| r.as_str()).unwrap_or("");
        let key = hash_key(id, req);
        if !seen.insert(key) {
            continue; // streamed chunks repeat the same message usage
        }
        let Some(ts) = v
            .get("timestamp")
            .and_then(|t| t.as_str())
            .and_then(|t| DateTime::parse_from_rfc3339(t).ok())
        else {
            continue;
        };
        let epoch = ts.timestamp();
        let g = |k: &str| usage.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
        out.push(Entry {
            key,
            hour: epoch - epoch.rem_euclid(3600),
            model: model.to_string(),
            tokens: TokenTotals {
                input: g("input_tokens"),
                output: g("output_tokens"),
                cache_write: g("cache_creation_input_tokens"),
                cache_read: g("cache_read_input_tokens"),
            },
        });
    }
    out
}

/// Scan/refresh the per-file cache, then aggregate with global dedupe.
pub fn compute_local(cache: &ClaudeShared) -> ClaudeUsage {
    let mut usage = ClaudeUsage::default();
    let Some(home) = dirs::home_dir() else {
        return usage;
    };
    let root = home.join(".claude").join("projects");
    if !root.is_dir() {
        return usage;
    }
    usage.available = true;

    let now = unix_now();
    let cutoff = SystemTime::now() - std::time::Duration::from_secs(SCAN_WINDOW_DAYS * 86_400);

    let mut live: HashSet<PathBuf> = HashSet::new();
    let mut recent_files: Vec<(PathBuf, u64)> = Vec::new();
    {
        let mut cache = cache.lock().expect("claude cache poisoned");
        for entry in WalkDir::new(&root)
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
            live.insert(path_buf.clone());
            let age = (now as u64).saturating_sub((mtime_ms / 1000) as u64);
            if age <= ACTIVE_SESSION_SECS {
                recent_files.push((path_buf.clone(), age));
            }
            let stale = match cache.files.get(&path_buf) {
                Some(fc) => fc.mtime_ms != mtime_ms || fc.size != size,
                None => true,
            };
            if stale {
                let entries = parse_file(&path_buf);
                cache.files.insert(
                    path_buf,
                    FileCache {
                        mtime_ms,
                        size,
                        entries,
                    },
                );
            }
        }
        cache.files.retain(|path, _| live.contains(path));

        // Aggregate: global dedupe across files (resume copies history).
        let mut seen: HashSet<u64> = HashSet::new();
        let mut buckets: HashMap<(i64, String), TokenTotals> = HashMap::new();
        let mut paths: Vec<&PathBuf> = cache.files.keys().collect();
        paths.sort();
        for path in paths {
            for e in &cache.files[path].entries {
                if !seen.insert(e.key) {
                    continue;
                }
                buckets
                    .entry((e.hour, e.model.clone()))
                    .or_default()
                    .add(&e.tokens);
            }
        }

        let today_start = Local::now()
            .date_naive()
            .and_hms_opt(0, 0, 0)
            .and_then(|dt| Local.from_local_datetime(&dt).single())
            .map(|dt| dt.timestamp())
            .unwrap_or(now - 86_400);
        let week_start = now - 7 * 86_400;

        let mut models_today: HashMap<String, (u64, f64)> = HashMap::new();
        let mut hourly: HashMap<i64, (u64, f64)> = HashMap::new();
        let mut active_hours: Vec<i64> = Vec::new();

        for ((hour, model), tokens) in &buckets {
            let cost = cost_of(model, tokens);
            let total = tokens.total();
            if *hour >= week_start {
                usage.week_tokens_total += total;
                usage.week_cost_usd += cost;
            }
            if *hour >= today_start {
                usage.today_tokens.add(tokens);
                usage.today_cost_usd += cost;
                let m = models_today.entry(model.clone()).or_default();
                m.0 += total;
                m.1 += cost;
            }
            if *hour >= now - 24 * 3600 {
                let h = hourly.entry(*hour).or_default();
                h.0 += total;
                h.1 += cost;
            }
            active_hours.push(*hour);
        }

        // Active 5h block, ccusage-style: block starts at the first entry hour,
        // a new block begins when an entry lands past block start + 5h or after
        // a 5h idle gap.
        active_hours.sort_unstable();
        active_hours.dedup();
        let mut block_start: Option<i64> = None;
        let mut last_hour: Option<i64> = None;
        for h in &active_hours {
            match (block_start, last_hour) {
                (None, _) => block_start = Some(*h),
                (Some(bs), Some(lh)) => {
                    if h - bs >= BLOCK_SECS || h - lh >= BLOCK_SECS {
                        block_start = Some(*h);
                    }
                }
                _ => {}
            }
            last_hour = Some(*h);
        }
        if let (Some(bs), Some(lh)) = (block_start, last_hour) {
            if now < bs + BLOCK_SECS && now - lh < BLOCK_SECS {
                usage.block_started_unix = bs;
                usage.block_ends_unix = bs + BLOCK_SECS;
                for ((hour, model), tokens) in &buckets {
                    if *hour >= bs && *hour < bs + BLOCK_SECS {
                        usage.block_tokens_total += tokens.total();
                        usage.block_cost_usd += cost_of(model, tokens);
                    }
                }
            }
        }

        let mut models: Vec<ModelUsage> = models_today
            .into_iter()
            .map(|(model, (tokens, cost_usd))| ModelUsage {
                model,
                tokens,
                cost_usd,
            })
            .collect();
        models.sort_by(|a, b| b.tokens.cmp(&a.tokens));
        usage.models_today = models;

        let now_hour = now - now.rem_euclid(3600);
        usage.hourly = (0..24)
            .map(|i| {
                let hour = now_hour - (23 - i) * 3600;
                let (tokens, cost_usd) = hourly.get(&hour).copied().unwrap_or((0, 0.0));
                HourBucket {
                    hour_unix: hour,
                    tokens,
                    cost_usd,
                }
            })
            .collect();
    }

    // Active sessions: freshest transcripts, deduped by working directory
    // (a session plus its subagent transcripts share one cwd).
    let mut by_cwd: HashMap<String, ActiveSession> = HashMap::new();
    for (path, age) in recent_files {
        let tail = read_tail(&path, 16 * 1024);
        let cwd = tail
            .as_deref()
            .and_then(|t| extract_last_json_str(t, "cwd"));
        // The newest model named in the tail is the one currently in use.
        let model = tail
            .as_deref()
            .and_then(|t| extract_last_json_str(t, "model"));
        let key = cwd
            .clone()
            .unwrap_or_else(|| path.to_string_lossy().into_owned());
        let name = cwd
            .as_deref()
            .map(|c| path_basename(c))
            .unwrap_or_else(|| "session".into());
        let entry = by_cwd.entry(key).or_insert(ActiveSession {
            name,
            cwd,
            age_secs: age,
            model,
            // Per-session token attribution would need every entry re-read and
            // grouped by session id; today's totals are day-wide, so claiming
            // a per-session number here would be a guess.
            tokens: None,
            cost_usd: None,
        });
        if age < entry.age_secs {
            entry.age_secs = age;
        }
    }
    let mut sessions: Vec<ActiveSession> = by_cwd.into_values().collect();
    sessions.sort_by_key(|s| s.age_secs);
    sessions.truncate(5);
    usage.active_sessions = sessions;
    usage
}

/// Live rate-limit windows from the OAuth usage API. Returns (plan, windows).
pub async fn fetch_oauth_windows(http: &reqwest::Client) -> (Option<String>, Vec<RateWindow>) {
    let Some(home) = dirs::home_dir() else {
        return (None, vec![]);
    };
    let creds_path = home.join(".claude").join(".credentials.json");
    let Ok(raw) = fs::read_to_string(&creds_path) else {
        return (None, vec![]);
    };
    let Ok(creds) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return (None, vec![]);
    };
    let oauth = &creds["claudeAiOauth"];
    let plan = oauth
        .get("subscriptionType")
        .and_then(|s| s.as_str())
        .map(|s| s.to_string());
    let Some(token) = oauth.get("accessToken").and_then(|t| t.as_str()) else {
        return (plan, vec![]);
    };
    // Skip expired tokens — Claude Code refreshes them while in use; we never
    // refresh ourselves (that would race the CLI's own refresh flow).
    if let Some(expires_ms) = oauth.get("expiresAt").and_then(|e| e.as_i64()) {
        if expires_ms / 1000 < unix_now() + 60 {
            return (plan, vec![]);
        }
    }
    let resp = http
        .get("https://api.anthropic.com/api/oauth/usage")
        .bearer_auth(token)
        .header("anthropic-beta", "oauth-2025-04-20")
        .timeout(std::time::Duration::from_secs(6))
        .send()
        .await;
    let Ok(resp) = resp else { return (plan, vec![]) };
    if !resp.status().is_success() {
        return (plan, vec![]);
    }
    let Ok(body) = resp.json::<serde_json::Value>().await else {
        return (plan, vec![]);
    };
    let specs = [
        ("five_hour", "5h", 300i64),
        ("seven_day", "Weekly", 10_080),
        ("seven_day_opus", "Opus 7d", 10_080),
        ("seven_day_sonnet", "Sonnet 7d", 10_080),
    ];
    let mut windows = Vec::new();
    for (key, label, minutes) in specs {
        let Some(w) = body.get(key) else { continue };
        if w.is_null() {
            continue;
        }
        let used = w
            .get("utilization")
            .or_else(|| w.get("used_percent"))
            .and_then(|u| u.as_f64());
        let Some(used) = used else { continue };
        let resets = w
            .get("resets_at")
            .map(|r| {
                r.as_i64().unwrap_or_else(|| {
                    r.as_str()
                        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                        .map(|d| d.timestamp())
                        .unwrap_or(0)
                })
            })
            .unwrap_or(0);
        windows.push(RateWindow {
            label: label.to_string(),
            used_percent: used,
            resets_at_unix: resets,
            window_minutes: minutes,
        });
    }
    (plan, windows)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pricing_tiers_by_model_family() {
        assert_eq!(pricing("claude-haiku-4-5").0, 1.0);
        assert_eq!(pricing("claude-sonnet-5").0, 3.0);
        assert_eq!(pricing("claude-opus-4-8").0, 15.0);
        assert_eq!(pricing("claude-fable-5").0, 15.0);
    }

    #[test]
    fn cost_math_per_mtok() {
        let t = TokenTotals {
            input: 1_000_000,
            output: 0,
            cache_write: 0,
            cache_read: 0,
        };
        assert!((cost_of("claude-sonnet-5", &t) - 3.0).abs() < 1e-9);
    }
}
