//! Process discovery: sysinfo snapshot filtered to JS runtimes (node/bun/deno),
//! enriched with tool labels, the killable probe, and the descendant map.
//! Ported from the node-process-widget scanner, extended for AI-tool detection.

use std::collections::{HashMap, HashSet, VecDeque};
use std::time::{SystemTime, UNIX_EPOCH};

use chrono::{SecondsFormat, Utc};
use sysinfo::{Pid, Process, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

use crate::types::{ProcInfo, ProcessesPayload};

/// CPU percentage at or above which a process counts as "active" for the
/// idle clock. True-idle node sits at ~0%; timers/GC blip well below this.
const ACTIVE_CPU_PERCENT: f32 = 0.5;

/// Runtimes the widget tracks.
const RUNTIMES: [&str; 3] = ["node.exe", "bun.exe", "deno.exe"];

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub struct Scanner {
    sys: System,
    /// (pid, start_time) -> unix seconds of last observed CPU activity.
    last_active: HashMap<(u32, u64), u64>,
}

impl Scanner {
    pub fn new() -> Self {
        Self {
            sys: System::new(),
            last_active: HashMap::new(),
        }
    }

    /// Refresh all processes and build the payload. The `System` is long-lived
    /// so successive calls yield meaningful `cpu_usage` deltas.
    pub fn snapshot(&mut self) -> ProcessesPayload {
        self.sys.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing()
                .with_memory()
                .with_cpu()
                .with_cmd(UpdateKind::OnlyIfNotSet)
                .with_exe(UpdateKind::OnlyIfNotSet)
                .with_cwd(UpdateKind::OnlyIfNotSet),
        );
        build_payload(&self.sys, &mut self.last_active)
    }

    pub fn system_mut(&mut self) -> &mut System {
        &mut self.sys
    }

    pub fn system(&self) -> &System {
        &self.sys
    }
}

fn is_runtime(p: &Process) -> bool {
    let name = p.name().to_string_lossy().to_ascii_lowercase();
    RUNTIMES.contains(&name.as_str())
}

/// Identify what tool is running inside the runtime from its command line.
/// Order matters: more specific patterns first.
pub fn detect_label(cmd_lower: &str) -> Option<String> {
    let rules: [(&str, &str); 16] = [
        ("openclaw", "OpenClaw"),
        ("claude", "Claude Code"),
        ("codex", "Codex"),
        ("copilot", "Copilot"),
        ("gemini", "Gemini CLI"),
        ("mcp", "MCP Server"),
        ("vite", "Vite"),
        ("next", "Next.js"),
        ("webpack", "Webpack"),
        ("esbuild", "esbuild"),
        ("tsserver", "TS Server"),
        ("typescript", "TS Server"),
        ("vitest", "Vitest"),
        ("jest", "Jest"),
        ("tailwind", "Tailwind"),
        ("electron", "Electron"),
    ];
    // OpenClaw gateway is its own thing — the health card also keys off it.
    if cmd_lower.contains("openclaw") && cmd_lower.contains("gateway") {
        return Some("OpenClaw Gateway".into());
    }
    for (pat, label) in rules {
        if cmd_lower.contains(pat) {
            return Some((*label).into());
        }
    }
    None
}

/// Compact command line for display: prefer the script path's file name,
/// else the first non-flag argument, else a truncated join.
fn summarize_cmd(cmd: &[String]) -> String {
    let mut script: Option<&str> = None;
    for arg in cmd.iter().skip(1) {
        if arg.starts_with('-') {
            continue;
        }
        script = Some(arg);
        break;
    }
    let text = match script {
        Some(s) => {
            let base = s.rsplit(['\\', '/']).next().unwrap_or(s);
            base.to_string()
        }
        None => cmd.join(" "),
    };
    if text.len() > 60 {
        format!("{}…", &text[..59])
    } else {
        text
    }
}

/// (pid, ppid, start_time) triples — the pure inputs of the descendant map.
type ProcTriple = (u32, Option<u32>, u64);

fn triples(sys: &System) -> Vec<ProcTriple> {
    sys.processes()
        .iter()
        .map(|(pid, p)| (pid.as_u32(), p.parent().map(|pp| pp.as_u32()), p.start_time()))
        .collect()
}

/// Build parent -> children edges, dropping any edge where the child claims to
/// predate its parent — that means the parent PID was reused.
fn children_map(triples: &[ProcTriple]) -> HashMap<u32, Vec<u32>> {
    let starts: HashMap<u32, u64> = triples.iter().map(|(pid, _, st)| (*pid, *st)).collect();
    let mut map: HashMap<u32, Vec<u32>> = HashMap::new();
    for (pid, ppid, start) in triples {
        if let Some(pp) = ppid {
            if let Some(parent_start) = starts.get(pp) {
                if *start >= *parent_start {
                    map.entry(*pp).or_default().push(*pid);
                }
            }
        }
    }
    map
}

/// BFS over the child map; cycle-safe via the visited set.
fn descendants_in(children: &HashMap<u32, Vec<u32>>, root: u32) -> Vec<u32> {
    let mut out = Vec::new();
    let mut seen: HashSet<u32> = HashSet::from([root]);
    let mut queue: VecDeque<u32> = VecDeque::from([root]);
    while let Some(cur) = queue.pop_front() {
        if let Some(kids) = children.get(&cur) {
            for kid in kids {
                if seen.insert(*kid) {
                    out.push(*kid);
                    queue.push_back(*kid);
                }
            }
        }
    }
    out
}

/// All descendant PIDs of `root` in the current snapshot, deepest last.
pub fn descendants_of(sys: &System, root: u32) -> Vec<u32> {
    descendants_in(&children_map(&triples(sys)), root)
}

/// Runtimes/shells to walk past when attributing a process to an app.
const SKIP_PARENTS: [&str; 7] = [
    "node.exe",
    "bun.exe",
    "deno.exe",
    "cmd.exe",
    "conhost.exe",
    "powershell.exe",
    "pwsh.exe",
];

/// Shell/system roots that mean "launched by the user / system".
const HIDE_PARENTS: [&str; 8] = [
    "explorer.exe",
    "services.exe",
    "svchost.exe",
    "wininit.exe",
    "winlogon.exe",
    "smss.exe",
    "userinit.exe",
    "system",
];

struct Ancestry {
    app: Option<String>,
    broken: bool,
}

fn resolve_ancestry(sys: &System, proc_: &Process) -> Ancestry {
    let mut current = proc_.parent();
    let mut child_start = proc_.start_time();
    for _ in 0..16 {
        let Some(pid) = current else {
            return Ancestry { app: None, broken: false };
        };
        let Some(parent) = sys.process(pid) else {
            return Ancestry { app: None, broken: true };
        };
        // A "parent" younger than its child means the PPID was recycled.
        if parent.start_time() > child_start + 1 {
            return Ancestry { app: None, broken: true };
        }
        let name = parent.name().to_string_lossy();
        let lower = name.to_ascii_lowercase();
        if SKIP_PARENTS.contains(&lower.as_str()) {
            child_start = parent.start_time();
            current = parent.parent();
            continue;
        }
        if HIDE_PARENTS.contains(&lower.as_str()) {
            return Ancestry { app: None, broken: false };
        }
        let display = if lower.ends_with(".exe") {
            &name[..name.len() - 4]
        } else {
            &name[..]
        };
        return Ancestry {
            app: Some(display.to_string()),
            broken: false,
        };
    }
    Ancestry { app: None, broken: false }
}

#[cfg(windows)]
pub fn probe_killable(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_TERMINATE};
    unsafe {
        let handle = OpenProcess(PROCESS_TERMINATE, 0, pid);
        if handle.is_null() {
            false
        } else {
            CloseHandle(handle);
            true
        }
    }
}

#[cfg(not(windows))]
pub fn probe_killable(_pid: u32) -> bool {
    true
}

pub fn build_payload(
    sys: &System,
    last_active: &mut HashMap<(u32, u64), u64>,
) -> ProcessesPayload {
    let children = children_map(&triples(sys));
    let now = unix_now();
    let mut processes: Vec<ProcInfo> = sys
        .processes()
        .iter()
        .filter(|(_, p)| is_runtime(p))
        .map(|(pid, p)| {
            let pid_u32 = pid.as_u32();
            let start = p.start_time();
            let cpu = p.cpu_usage();
            let seen = last_active.entry((pid_u32, start)).or_insert(now);
            if cpu >= ACTIVE_CPU_PERCENT {
                *seen = now;
            }
            let idle_secs = now.saturating_sub(*seen);
            let ancestry = resolve_ancestry(sys, p);
            let cmd: Vec<String> = p
                .cmd()
                .iter()
                .map(|c| c.to_string_lossy().into_owned())
                .collect();
            let cmd_lower = cmd.join(" ").to_ascii_lowercase();
            ProcInfo {
                pid: pid_u32,
                ppid: p.parent().map(|pp| pp.as_u32()),
                name: p.name().to_string_lossy().into_owned(),
                label: detect_label(&cmd_lower),
                cmd_summary: summarize_cmd(&cmd),
                cwd: p.cwd().map(|c| c.to_string_lossy().into_owned()),
                start_time_unix: start,
                mem_bytes: p.memory(),
                cpu_percent: cpu,
                killable: probe_killable(pid_u32),
                child_pids: descendants_in(&children, pid_u32),
                parent_app: ancestry.app,
                orphaned: ancestry.broken,
                idle_secs,
            }
        })
        .collect();
    // Drop activity entries for processes that no longer exist.
    let live: HashSet<(u32, u64)> = processes
        .iter()
        .map(|p| (p.pid, p.start_time_unix))
        .collect();
    last_active.retain(|key, _| live.contains(key));
    // Stable order: start time ascending, PID as tiebreaker.
    processes.sort_by_key(|p| (p.start_time_unix, p.pid));
    ProcessesPayload {
        scanned_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        processes,
    }
}

/// Does `pid` still refer to the process that started at `expected_start`?
/// ±1 s slack for rounding at scan boundaries.
pub fn identity_matches(sys: &System, pid: u32, expected_start: u64) -> Option<bool> {
    sys.process(Pid::from_u32(pid))
        .map(|p| p.start_time().abs_diff(expected_start) <= 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn children_map_drops_edges_where_child_predates_parent() {
        let triples = vec![
            (100, None, 500),
            (200, Some(100), 400),
            (300, Some(100), 600),
            (400, Some(300), 600),
        ];
        let map = children_map(&triples);
        assert_eq!(map.get(&100), Some(&vec![300]));
        assert_eq!(descendants_in(&map, 100), vec![300, 400]);
    }

    #[test]
    fn descendants_survive_cycles() {
        let triples = vec![(1, Some(2), 10), (2, Some(1), 10)];
        let map = children_map(&triples);
        assert!(descendants_in(&map, 1).len() <= 1);
    }

    #[test]
    fn labels_detect_ai_tools() {
        assert_eq!(
            detect_label("c:\\x\\node.exe c:\\apps\\openclaw\\gateway.js"),
            Some("OpenClaw Gateway".into())
        );
        assert_eq!(detect_label("node vite --port 3000"), Some("Vite".into()));
        assert_eq!(detect_label("node plain-server.js"), None);
    }

    #[test]
    fn summarize_prefers_script_basename() {
        let cmd = vec![
            "C:\\node\\node.exe".to_string(),
            "--max-old-space-size=4096".to_string(),
            "C:\\proj\\server\\index.js".to_string(),
        ];
        assert_eq!(summarize_cmd(&cmd), "index.js");
    }
}
