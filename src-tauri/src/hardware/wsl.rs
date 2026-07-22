//! WSL distros via `wsl.exe -l -v`. The classic trap: wsl.exe prints UTF-16LE,
//! so bytes must be decoded before parsing. vmmem RAM comes from the shared
//! process table.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::cli::{is_not_found, run_silent_timeout};
use crate::scanner::Scanner;
use crate::types::{WslDistro, WslStatus};

const LXSS_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Lxss";

/// Distros Docker Desktop creates for its own engine; they are plumbing, not
/// something the user installed.
const DOCKER_DISTROS: [&str; 2] = ["docker-desktop", "docker-desktop-data"];

/// wsl.exe output is UTF-16LE (sometimes with BOM); fall back to UTF-8 when
/// it clearly isn't (e.g. translated builds piping differently).
pub fn decode_wsl_output(bytes: &[u8]) -> String {
    let looks_utf16 = bytes.len() >= 2
        && (bytes.starts_with(&[0xFF, 0xFE])
            || bytes.iter().skip(1).step_by(2).take(16).filter(|b| **b == 0).count() > 4);
    if looks_utf16 {
        let start = if bytes.starts_with(&[0xFF, 0xFE]) { 2 } else { 0 };
        let units: Vec<u16> = bytes[start..]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

pub fn parse_list(text: &str) -> Vec<WslDistro> {
    let mut out = Vec::new();
    for (i, line) in text.lines().enumerate() {
        if i == 0 {
            continue; // header row (NAME STATE VERSION, localized)
        }
        let raw = line.trim_end();
        if raw.trim().is_empty() {
            continue;
        }
        let is_default = raw.trim_start().starts_with('*');
        let cleaned = raw.trim_start().trim_start_matches('*').trim_start();
        // Columns are space-aligned; distro names may contain single spaces,
        // so split on runs of 2+ spaces.
        let cols: Vec<&str> = cleaned
            .split("  ")
            .map(str::trim)
            .filter(|c| !c.is_empty())
            .collect();
        if cols.len() < 3 {
            continue;
        }
        out.push(WslDistro {
            name: cols[0].to_string(),
            state: cols[1].to_string(),
            version: cols[2].to_string(),
            is_default,
            disk_bytes: None,
            docker_integration: false,
        });
    }
    out
}

/// Distro name -> BasePath, from the per-distro GUID subkeys the WSL service
/// writes. `wsl.exe` has no equivalent output.
fn base_paths() -> HashMap<String, String> {
    let mut out = HashMap::new();
    let hkcu = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER);
    let Ok(lxss) = hkcu.open_subkey(LXSS_KEY) else {
        return out;
    };
    for guid in lxss.enum_keys().flatten() {
        let Ok(key) = lxss.open_subkey(&guid) else {
            continue;
        };
        let (Ok(name), Ok(path)) = (
            key.get_value::<String, _>("DistributionName"),
            key.get_value::<String, _>("BasePath"),
        ) else {
            continue;
        };
        out.insert(name, path);
    }
    out
}

/// BasePath is usually stored in the `\\?\` extended form, which `fs` accepts
/// but reads more cleanly without.
pub fn vhdx_path(base_path: &str) -> String {
    let trimmed = base_path.strip_prefix(r"\\?\").unwrap_or(base_path);
    format!(r"{}\ext4.vhdx", trimmed.trim_end_matches('\\'))
}

/// True when Docker Desktop's WSL backend exists on this machine at all — the
/// flag is machine-wide, not a per-distro opt-in, which WSL doesn't expose.
fn docker_backend_present(distros: &[WslDistro]) -> bool {
    distros
        .iter()
        .any(|d| DOCKER_DISTROS.contains(&d.name.to_ascii_lowercase().as_str()))
}

pub fn status(scanner: &Arc<Mutex<Scanner>>) -> WslStatus {
    let mut out = WslStatus::default();
    let result = run_silent_timeout("wsl", &["-l", "-v"], Duration::from_secs(8));
    let output = match result {
        Err(e) if is_not_found(&e) => return out,
        Err(_) => return out,
        Ok(o) => o,
    };
    out.installed = true;
    let text = decode_wsl_output(&output.stdout);
    // "no installed distributions" exits non-zero — installed but empty.
    if output.status.success() {
        out.distros = parse_list(&text);
    }
    let docker = docker_backend_present(&out.distros);
    let paths = base_paths();
    for d in &mut out.distros {
        let is_docker = DOCKER_DISTROS.contains(&d.name.to_ascii_lowercase().as_str());
        d.docker_integration = docker && !is_docker;
        d.disk_bytes = paths
            .get(&d.name)
            .and_then(|base| std::fs::metadata(vhdx_path(base)).ok())
            .map(|m| m.len());
    }
    if let Ok(sc) = scanner.lock() {
        let vmmem: u64 = sc
            .system()
            .processes()
            .values()
            .filter(|p| {
                let n = p.name().to_string_lossy().to_ascii_lowercase();
                n == "vmmem" || n == "vmmemwsl"
            })
            .map(|p| p.memory())
            .sum();
        if vmmem > 0 {
            out.vmmem_bytes = Some(vmmem);
        }
    }
    out
}

pub fn terminate(name: &str) -> Result<(), String> {
    let out = run_silent_timeout("wsl", &["-t", name], Duration::from_secs(10))
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(decode_wsl_output(&out.stderr).trim().to_string())
    }
}

pub fn shutdown_all() -> Result<(), String> {
    let out = run_silent_timeout("wsl", &["--shutdown"], Duration::from_secs(15))
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(decode_wsl_output(&out.stderr).trim().to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_utf16le_and_parses() {
        let text = "  NAME            STATE           VERSION\n* Ubuntu          Running         2\n  Debian          Stopped         2\n";
        let utf16: Vec<u8> = std::iter::once(&[0xFF, 0xFE][..])
            .chain(std::iter::once(
                text.encode_utf16()
                    .flat_map(|u| u.to_le_bytes())
                    .collect::<Vec<u8>>()
                    .leak() as &[u8],
            ))
            .flatten()
            .copied()
            .collect();
        let decoded = decode_wsl_output(&utf16);
        let distros = parse_list(&decoded);
        assert_eq!(distros.len(), 2);
        assert_eq!(distros[0].name, "Ubuntu");
        assert!(distros[0].is_default);
        assert_eq!(distros[1].state, "Stopped");
    }

    #[test]
    fn builds_vhdx_path_from_base_path() {
        assert_eq!(
            vhdx_path(r"\\?\C:\Users\t\AppData\Local\wsl\Ubuntu"),
            r"C:\Users\t\AppData\Local\wsl\Ubuntu\ext4.vhdx"
        );
        assert_eq!(vhdx_path(r"D:\wsl\Debian\"), r"D:\wsl\Debian\ext4.vhdx");
    }

    #[test]
    fn docker_backend_detected_only_from_its_own_distros() {
        let distro = |name: &str| WslDistro {
            name: name.into(),
            state: "Running".into(),
            version: "2".into(),
            is_default: false,
            disk_bytes: None,
            docker_integration: false,
        };
        assert!(docker_backend_present(&[
            distro("Ubuntu"),
            distro("docker-desktop")
        ]));
        assert!(!docker_backend_present(&[distro("Ubuntu"), distro("Debian")]));
    }
}
