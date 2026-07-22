//! One-click thermals setup: install LibreHardwareMonitor via winget (its
//! official distribution — we deliberately don't redistribute the binary or
//! its kernel driver ourselves), pre-seed its config with the web server
//! enabled, then start it elevated and register a highest-privilege logon
//! task — all behind a single UAC prompt the user explicitly clicks for.

use std::fs;
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::cli::run_silent_timeout;
use crate::scanner::Scanner;
use crate::types::ThermalsSetupResult;

const TASK_NAME: &str = "LibreHardwareMonitor-AIHUD";
const WINGET_ID: &str = "LibreHardwareMonitor.LibreHardwareMonitor";

fn web_server_up(port: u16) -> bool {
    let addr = format!("127.0.0.1:{port}");
    addr.parse()
        .ok()
        .and_then(|a| TcpStream::connect_timeout(&a, Duration::from_millis(800)).ok())
        .is_some()
}

fn locate() -> Option<PathBuf> {
    if let Some(local) = dirs::data_local_dir() {
        let packages = local.join("Microsoft").join("WinGet").join("Packages");
        if packages.is_dir() {
            for entry in walkdir::WalkDir::new(&packages)
                .max_depth(3)
                .into_iter()
                .filter_map(|e| e.ok())
            {
                if entry.file_name().to_string_lossy() == "LibreHardwareMonitor.exe" {
                    return Some(entry.into_path());
                }
            }
        }
    }
    for base in ["C:\\Program Files", "C:\\Program Files (x86)"] {
        let candidate = Path::new(base)
            .join("LibreHardwareMonitor")
            .join("LibreHardwareMonitor.exe");
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn install_via_winget() -> bool {
    run_silent_timeout(
        "winget",
        &[
            "install",
            "--id",
            WINGET_ID,
            "--accept-source-agreements",
            "--accept-package-agreements",
            "--disable-interactivity",
        ],
        Duration::from_secs(300),
    )
    .map(|o| o.status.success())
    .unwrap_or(false)
    // Exit code for "already installed" is non-zero; locate() afterwards is
    // the real success test either way.
}

/// Set `key="…" value="…"` inside the flat appSettings XML, inserting the
/// key when missing. Returns whether the text changed.
fn set_key(text: &mut String, key: &str, value: &str) -> bool {
    let needle = format!("key=\"{key}\"");
    if let Some(pos) = text.find(&needle) {
        if let Some(vstart_rel) = text[pos..].find("value=\"") {
            let vstart = pos + vstart_rel + 7;
            if let Some(vend_rel) = text[vstart..].find('"') {
                let vend = vstart + vend_rel;
                if &text[vstart..vend] == value {
                    return false;
                }
                text.replace_range(vstart..vend, value);
                return true;
            }
        }
        false
    } else if let Some(ins) = text.find("</appSettings>") {
        text.insert_str(ins, &format!("  <add key=\"{key}\" value=\"{value}\" />\n  "));
        true
    } else {
        false
    }
}

fn ensure_config(exe: &Path, port: u16) -> std::io::Result<bool> {
    let path = exe.with_file_name("LibreHardwareMonitor.config");
    let port_str = port.to_string();
    let desired: [(&str, &str); 5] = [
        ("listenerPort", &port_str),
        ("runWebServerMenuItem", "true"),
        ("startMinMenuItem", "true"),
        ("minTrayMenuItem", "true"),
        ("minCloseMenuItem", "true"),
    ];
    if !path.exists() {
        let body: String = desired
            .iter()
            .map(|(k, v)| format!("    <add key=\"{k}\" value=\"{v}\" />\n"))
            .collect();
        fs::write(
            &path,
            format!(
                "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<configuration>\n  <appSettings>\n{body}  </appSettings>\n</configuration>\n"
            ),
        )?;
        return Ok(true);
    }
    let mut text = fs::read_to_string(&path)?;
    let mut changed = false;
    for (key, value) in desired {
        changed |= set_key(&mut text, key, value);
    }
    if changed {
        fs::write(&path, &text)?;
    }
    Ok(changed)
}

fn lhm_process_running(scanner: &Arc<Mutex<Scanner>>) -> bool {
    scanner
        .lock()
        .map(|sc| {
            sc.system().processes().values().any(|p| {
                p.name()
                    .to_string_lossy()
                    .eq_ignore_ascii_case("LibreHardwareMonitor.exe")
            })
        })
        .unwrap_or(false)
}

/// One UAC prompt covers both: register the logon task (highest privileges)
/// and start LHM elevated.
fn elevated_launch(exe: &Path) -> Result<(), String> {
    let exe_str = exe.to_string_lossy();
    let inner = format!(
        "schtasks /Create /TN {TASK_NAME} /TR \"{exe_str}\" /SC ONLOGON /RL HIGHEST /F | Out-Null; Start-Process -FilePath \"{exe_str}\""
    );
    let outer = format!(
        "Start-Process powershell -Verb RunAs -Wait:$false -ArgumentList '-NoProfile','-WindowStyle','Hidden','-Command','{}'",
        inner.replace('\'', "''")
    );
    let out = run_silent_timeout(
        "powershell",
        &["-NoProfile", "-Command", &outer],
        Duration::from_secs(180),
    )
    .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&out.stderr);
        Err(if stderr.to_ascii_lowercase().contains("canceled") {
            "UAC prompt was declined".into()
        } else {
            stderr
                .lines()
                .find(|l| !l.trim().is_empty())
                .unwrap_or("elevation failed")
                .chars()
                .take(120)
                .collect()
        })
    }
}

pub fn setup(scanner: &Arc<Mutex<Scanner>>, port: u16) -> ThermalsSetupResult {
    let mut r = ThermalsSetupResult::default();

    if web_server_up(port) {
        r.live = true;
        r.message = "LibreHardwareMonitor is already serving sensors".into();
        return r;
    }

    let exe = match locate() {
        Some(exe) => Some(exe),
        None => {
            r.installed_now = install_via_winget();
            locate()
        }
    };
    let Some(exe) = exe else {
        r.message =
            "Couldn't install LibreHardwareMonitor (is winget available?) — install it manually, then run setup again".into();
        return r;
    };

    match ensure_config(&exe, port) {
        Ok(changed) => r.config_seeded = changed,
        Err(e) => {
            r.message = format!("Couldn't write LHM config: {e}");
            return r;
        }
    }

    if lhm_process_running(scanner) {
        // Its web server is off (we checked above) and the config seed only
        // applies at startup — never kill a user's app to force it.
        r.message = "LibreHardwareMonitor is running but its web server is off — quit it from the tray and run setup again, or enable Options → Remote Web Server → Run".into();
        return r;
    }

    match elevated_launch(&exe) {
        Ok(()) => {
            r.launched = true;
            r.task_registered = true;
        }
        Err(e) => {
            r.message = format!("Elevation failed: {e}");
            return r;
        }
    }

    // Give it up to ~20 s (UAC click + driver load) to come up.
    for _ in 0..20 {
        if web_server_up(port) {
            r.live = true;
            break;
        }
        std::thread::sleep(Duration::from_secs(1));
    }
    r.message = if r.live {
        "Full telemetry live — the Thermals card updates within a few seconds".into()
    } else {
        "Started — waiting for sensors; if nothing appears, approve the UAC prompt and check again".into()
    };
    r
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_key_updates_and_inserts() {
        let mut xml = String::from(
            "<configuration>\n  <appSettings>\n    <add key=\"runWebServerMenuItem\" value=\"false\" />\n  </appSettings>\n</configuration>",
        );
        assert!(set_key(&mut xml, "runWebServerMenuItem", "true"));
        assert!(xml.contains("key=\"runWebServerMenuItem\" value=\"true\""));
        assert!(!set_key(&mut xml, "runWebServerMenuItem", "true")); // idempotent
        assert!(set_key(&mut xml, "listenerPort", "8085")); // inserted
        assert!(xml.contains("key=\"listenerPort\" value=\"8085\""));
    }
}
