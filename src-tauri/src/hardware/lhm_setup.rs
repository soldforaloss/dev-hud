//! One-click thermals setup: install LibreHardwareMonitor via winget (its
//! official distribution — we deliberately don't redistribute the binary or
//! its kernel driver ourselves), pre-seed its config with the web server
//! enabled, then start it elevated and register a highest-privilege logon
//! task — all behind a single UAC prompt the user explicitly clicks for.
//!
//! Because the launch is elevated, provenance is verified fail-closed:
//! the executable is only accepted from the canonical winget package
//! directory (or Program Files), it is held open write/delete-denied from
//! verification through the launch so it cannot be swapped underneath us,
//! and the elevated command re-checks the SHA-256 immediately before
//! registering and starting anything.

use std::fs;
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use sha2::{Digest, Sha256};

use crate::cli::run_silent_timeout;
use crate::scanner::Scanner;
use crate::types::ThermalsSetupResult;

const TASK_NAME: &str = "LibreHardwareMonitor-DevHUD";
/// Pre-rename task from the AI HUD era — cleaned up during setup.
const OLD_TASK_NAME: &str = "LibreHardwareMonitor-AIHUD";
const WINGET_ID: &str = "LibreHardwareMonitor.LibreHardwareMonitor";

fn web_server_up(port: u16) -> bool {
    let addr = format!("127.0.0.1:{port}");
    addr.parse()
        .ok()
        .and_then(|a| TcpStream::connect_timeout(&a, Duration::from_millis(800)).ok())
        .is_some()
}

/// True for a winget package directory that belongs to the LHM package —
/// winget names portable package dirs `<PackageId>_<SourceId>`. Any other
/// directory under the user-writable Packages tree is untrusted, however
/// plausible the exe inside it looks.
fn is_lhm_package_dir(name: &str) -> bool {
    name.strip_prefix(WINGET_ID)
        .is_some_and(|rest| rest.starts_with('_'))
}

fn locate() -> Option<PathBuf> {
    if let Some(local) = dirs::data_local_dir() {
        let packages = local.join("Microsoft").join("WinGet").join("Packages");
        if let Ok(entries) = fs::read_dir(&packages) {
            for dir in entries.filter_map(|e| e.ok()) {
                if !is_lhm_package_dir(&dir.file_name().to_string_lossy()) {
                    continue;
                }
                for entry in walkdir::WalkDir::new(dir.path())
                    .max_depth(2)
                    .into_iter()
                    .filter_map(|e| e.ok())
                {
                    if entry.file_name().to_string_lossy() == "LibreHardwareMonitor.exe" {
                        return Some(entry.into_path());
                    }
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

/// Strip the `\\?\` verbatim prefix canonicalize adds — schtasks and
/// Start-Process want a plain path. UNC paths are left alone.
fn simplify(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC") => PathBuf::from(rest),
        _ => p.to_path_buf(),
    }
}

/// The located executable: canonical path, content hash, and an open handle
/// with write/delete sharing denied — while `_handle` lives, the file cannot
/// be replaced, so the hash stays true from verification through launch.
/// (FILE_SHARE_READ still permits reads and image execution.)
struct PinnedExe {
    path: PathBuf,
    sha256_hex: String,
    _handle: fs::File,
}

fn pin(path: &Path) -> Result<PinnedExe, String> {
    use std::os::windows::fs::OpenOptionsExt;
    const FILE_SHARE_READ: u32 = 0x0000_0001;
    let canonical =
        simplify(&fs::canonicalize(path).map_err(|e| format!("cannot resolve {path:?}: {e}"))?);
    let mut handle = fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .open(&canonical)
        .map_err(|e| format!("cannot open {canonical:?}: {e}"))?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut handle, &mut hasher)
        .map_err(|e| format!("cannot hash {canonical:?}: {e}"))?;
    let sha256_hex: String = hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02X}"))
        .collect();
    Ok(PinnedExe {
        path: canonical,
        sha256_hex,
        _handle: handle,
    })
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
        text.insert_str(
            ins,
            &format!("  <add key=\"{key}\" value=\"{value}\" />\n  "),
        );
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
/// and start LHM elevated. The elevated command re-verifies the SHA-256
/// itself immediately before acting, so a file swapped after our check but
/// before the user clicks the prompt is refused rather than elevated.
fn elevated_launch(exe: &Path, sha256_hex: &str) -> Result<(), String> {
    let exe_str = exe.to_string_lossy();
    let inner = format!(
        "if ((Get-FileHash -LiteralPath \"{exe_str}\" -Algorithm SHA256).Hash -ne '{sha256_hex}') {{ exit 23 }}; schtasks /Delete /TN {OLD_TASK_NAME} /F | Out-Null; schtasks /Create /TN {TASK_NAME} /TR \"{exe_str}\" /SC ONLOGON /RL HIGHEST /F | Out-Null; Start-Process -FilePath \"{exe_str}\""
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

    // Pin before anything else touches the file: from here to the end of
    // setup the exe cannot be modified or replaced, and the elevated command
    // re-checks this exact hash before launching.
    let pinned = match pin(&exe) {
        Ok(p) => p,
        Err(e) => {
            r.message = format!("Couldn't verify the LibreHardwareMonitor executable: {e}");
            return r;
        }
    };
    let exe = pinned.path.clone();

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

    match elevated_launch(&exe, &pinned.sha256_hex) {
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
        "Started — waiting for sensors; if nothing appears, approve the UAC prompt and check again"
            .into()
    };
    r
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_canonical_winget_package_dir_is_trusted() {
        assert!(is_lhm_package_dir(
            "LibreHardwareMonitor.LibreHardwareMonitor_Microsoft.Winget.Source_8wekyb3d8bbwe"
        ));
        for bad in [
            "SomeOtherTool_Microsoft.Winget.Source_8wekyb3d8bbwe",
            "LibreHardwareMonitor.LibreHardwareMonitorEvil_src",
            "LibreHardwareMonitor.LibreHardwareMonitor", // no source suffix
            "Evil.LibreHardwareMonitor.LibreHardwareMonitor_src",
            "",
        ] {
            assert!(!is_lhm_package_dir(bad), "trusted {bad:?}");
        }
    }

    #[test]
    fn simplify_strips_the_verbatim_prefix_only_for_drive_paths() {
        assert_eq!(
            simplify(Path::new(r"\\?\C:\Tools\lhm.exe")),
            PathBuf::from(r"C:\Tools\lhm.exe")
        );
        assert_eq!(
            simplify(Path::new(r"\\?\UNC\server\share\lhm.exe")),
            PathBuf::from(r"\\?\UNC\server\share\lhm.exe")
        );
        assert_eq!(
            simplify(Path::new(r"C:\plain\path.exe")),
            PathBuf::from(r"C:\plain\path.exe")
        );
    }

    #[test]
    fn pin_hashes_and_blocks_writers() {
        let path = std::env::temp_dir().join("devhud-lhm-pin-test.bin");
        fs::write(&path, b"payload-v1").unwrap();
        let pinned = pin(&path).unwrap();
        assert_eq!(pinned.sha256_hex.len(), 64);
        // While pinned, the file cannot be rewritten or deleted.
        assert!(fs::write(&path, b"swapped!").is_err());
        assert!(fs::remove_file(&path).is_err());
        drop(pinned);
        fs::remove_file(&path).unwrap();
    }

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
