//! Uptime + pending-reboot detection from the well-known registry markers.

use crate::types::UptimeStatus;

#[cfg(windows)]
fn reboot_reasons() -> Vec<String> {
    use winreg::enums::HKEY_LOCAL_MACHINE;
    use winreg::RegKey;
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let mut reasons = Vec::new();
    if hklm
        .open_subkey("SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired")
        .is_ok()
    {
        reasons.push("Windows Update".to_string());
    }
    if hklm
        .open_subkey("SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending")
        .is_ok()
    {
        reasons.push("Component servicing".to_string());
    }
    if let Ok(key) = hklm.open_subkey("SYSTEM\\CurrentControlSet\\Control\\Session Manager") {
        if key
            .get_raw_value("PendingFileRenameOperations")
            .map(|v| !v.bytes.is_empty())
            .unwrap_or(false)
        {
            reasons.push("Pending file renames".to_string());
        }
    }
    reasons
}

#[cfg(not(windows))]
fn reboot_reasons() -> Vec<String> {
    vec![]
}

pub fn status() -> UptimeStatus {
    let boot = sysinfo::System::boot_time();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let reasons = reboot_reasons();
    UptimeStatus {
        boot_unix: boot,
        uptime_secs: now.saturating_sub(boot),
        reboot_pending: !reasons.is_empty(),
        reasons,
    }
}
