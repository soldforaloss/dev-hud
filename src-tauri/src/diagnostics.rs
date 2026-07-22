//! What the HUD itself costs. A monitor that hides its own footprint is the
//! one thing on the desktop nobody can audit, so this reports the widget's own
//! process the same way it reports everyone else's.

use std::path::PathBuf;

use sysinfo::{Pid, ProcessesToUpdate, System};

use crate::types::SelfDiagnostics;

pub fn self_diagnostics(sys: &mut System, store_path: Option<PathBuf>) -> SelfDiagnostics {
    let pid = std::process::id();
    let mut out = SelfDiagnostics {
        pid,
        ..Default::default()
    };

    // Only our own pid: the caller's `System` is the shared scanner snapshot,
    // and a full refresh here would cost more than the thing being measured.
    sys.refresh_processes(ProcessesToUpdate::Some(&[Pid::from_u32(pid)]), true);
    if let Some(process) = sys.process(Pid::from_u32(pid)) {
        // cpu_usage is a delta against the previous refresh, so the very first
        // sample after launch reads 0 — that is honest, not a failure.
        out.cpu_percent = process.cpu_usage();
        out.mem_bytes = process.memory();
        let now = chrono::Utc::now().timestamp().max(0) as u64;
        out.uptime_secs = now.saturating_sub(process.start_time());
    }
    // thread_count stays None: sysinfo exposes per-process tasks on Linux
    // only, and a fabricated count is worse than an absent one.

    if let Some(path) = store_path {
        out.store_bytes = std::fs::metadata(&path).ok().map(|m| m.len());
        out.store_path = Some(path.to_string_lossy().into_owned());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_our_own_process_and_survives_a_missing_store() {
        let mut sys = System::new();
        let diag = self_diagnostics(&mut sys, None);
        assert_eq!(diag.pid, std::process::id());
        assert!(diag.mem_bytes > 0, "our own process should have memory");
        assert_eq!(diag.thread_count, None);
        assert_eq!(diag.store_bytes, None);
        assert_eq!(diag.store_path, None);
    }

    #[test]
    fn store_path_is_reported_even_when_the_file_is_absent() {
        let missing = std::env::temp_dir().join("ai-hud-no-such-store.json");
        let diag = self_diagnostics(&mut System::new(), Some(missing.clone()));
        assert_eq!(diag.store_bytes, None);
        assert_eq!(
            diag.store_path.as_deref(),
            Some(missing.to_string_lossy().as_ref())
        );
    }

    #[test]
    fn measures_a_real_store_file() {
        let path = std::env::temp_dir().join("ai-hud-diagnostics-store.json");
        std::fs::write(&path, b"{\"settings\":{}}").unwrap();
        let diag = self_diagnostics(&mut System::new(), Some(path.clone()));
        assert_eq!(diag.store_bytes, Some(15));
        let _ = std::fs::remove_file(&path);
    }
}
