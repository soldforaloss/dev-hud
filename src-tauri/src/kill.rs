//! Force-terminate with identity verification.
//!
//! Never kills by PID alone: the caller supplies the start time it displayed,
//! and a mismatch aborts with `PidReused`. Tree kills terminate descendants
//! deepest-first from the same snapshot the identity check ran against.
//! Ported unchanged from node-process-widget.

use sysinfo::{Pid, ProcessesToUpdate, System};

use crate::scanner::{descendants_of, identity_matches};
use crate::types::{KillAllSummary, KillResult, KillStatus, KillTarget};

pub const ERROR_ACCESS_DENIED: u32 = 5;
pub const ERROR_INVALID_PARAMETER: u32 = 87;

#[cfg(windows)]
fn terminate(pid: u32, wait_ms: u32) -> Result<(), u32> {
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, TerminateProcess, WaitForSingleObject, PROCESS_TERMINATE,
    };
    // Generic access right, not re-exported by windows-sys under Threading.
    const SYNCHRONIZE: u32 = 0x0010_0000;

    unsafe {
        let handle = OpenProcess(PROCESS_TERMINATE | SYNCHRONIZE, 0, pid);
        if handle.is_null() {
            return Err(GetLastError());
        }
        if TerminateProcess(handle, 1) == 0 {
            let code = GetLastError();
            CloseHandle(handle);
            return Err(code);
        }
        if wait_ms > 0 {
            WaitForSingleObject(handle, wait_ms);
        }
        CloseHandle(handle);
        Ok(())
    }
}

#[cfg(not(windows))]
fn terminate(_pid: u32, _wait_ms: u32) -> Result<(), u32> {
    Err(0)
}

pub fn kill_process_impl(
    sys: &mut System,
    pid: u32,
    expected_start: u64,
    kill_tree: bool,
) -> KillResult {
    sys.refresh_processes(ProcessesToUpdate::All, true);

    match identity_matches(sys, pid, expected_start) {
        None => {
            return KillResult {
                status: KillStatus::AlreadyExited,
                os_code: None,
                killed_pids: vec![],
            }
        }
        Some(false) => {
            return KillResult {
                status: KillStatus::PidReused,
                os_code: None,
                killed_pids: vec![],
            }
        }
        Some(true) => {}
    }

    let mut killed = Vec::new();

    if kill_tree {
        let mut descendants = descendants_of(sys, pid);
        descendants.reverse(); // deepest first
        for child in descendants {
            if terminate(child, 250).is_ok() {
                killed.push(child);
            }
        }
    }

    match terminate(pid, 1500) {
        Ok(()) => {
            killed.push(pid);
            KillResult {
                status: KillStatus::Killed,
                os_code: None,
                killed_pids: killed,
            }
        }
        Err(code) => {
            // The target may have exited inside the race window — losing the
            // race to a dying process is success, not an error.
            sys.refresh_processes(ProcessesToUpdate::Some(&[Pid::from_u32(pid)]), true);
            if sys.process(Pid::from_u32(pid)).is_none() {
                let status = if killed.is_empty() {
                    KillStatus::AlreadyExited
                } else {
                    KillStatus::Killed
                };
                return KillResult {
                    status,
                    os_code: None,
                    killed_pids: killed,
                };
            }
            let status = match code {
                ERROR_ACCESS_DENIED => KillStatus::AccessDenied,
                ERROR_INVALID_PARAMETER => KillStatus::AlreadyExited,
                _ => KillStatus::Unknown,
            };
            KillResult {
                status,
                os_code: Some(code),
                killed_pids: killed,
            }
        }
    }
}

/// Batch kill: one snapshot, then every target is identity-verified
/// individually — the same never-kill-by-PID-alone rule.
pub fn kill_all_impl(sys: &mut System, targets: &[KillTarget]) -> KillAllSummary {
    sys.refresh_processes(ProcessesToUpdate::All, true);
    let mut summary = KillAllSummary::default();
    for target in targets {
        match identity_matches(sys, target.pid, target.start_time_unix) {
            None => summary.already_exited.push(target.pid),
            Some(false) => summary.reused.push(target.pid),
            Some(true) => match terminate(target.pid, 300) {
                Ok(()) => summary.killed.push(target.pid),
                Err(ERROR_ACCESS_DENIED) => summary.denied.push(target.pid),
                Err(ERROR_INVALID_PARAMETER) => summary.already_exited.push(target.pid),
                Err(_) => summary.failed.push(target.pid),
            },
        }
    }
    summary
}
