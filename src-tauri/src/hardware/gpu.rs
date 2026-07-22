//! NVIDIA GPU monitoring via nvidia-smi (ships with the driver).
//!
//! Query CSV is stable across driver generations; every field is optional
//! because "[N/A]" is normal (no fan on laptops, MIG mode, etc.). Per-process
//! VRAM comes from `pmon -c 1 -s m`, which covers graphics + compute apps.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::cli::{is_not_found, run_silent_timeout};
use crate::scanner::{probe_killable, Scanner};
use crate::types::{GpuInfo, GpuProcess, GpuStatus};

const QUERY: &str = "index,name,temperature.gpu,utilization.gpu,memory.used,memory.total,power.draw,power.limit,clocks.sm,fan.speed,pstate,driver_version";

fn opt_f32(field: &str) -> Option<f32> {
    let t = field.trim();
    if t.is_empty() || t.contains("N/A") {
        None
    } else {
        t.parse().ok()
    }
}

fn opt_u64(field: &str) -> Option<u64> {
    opt_f32(field).map(|f| f as u64)
}

pub fn parse_query(stdout: &str) -> (Vec<GpuInfo>, Option<String>) {
    let mut gpus = Vec::new();
    let mut driver = None;
    for line in stdout.lines() {
        let cols: Vec<&str> = line.split(',').map(str::trim).collect();
        if cols.len() < 12 {
            continue;
        }
        let Some(index) = cols[0].parse::<u32>().ok() else {
            continue;
        };
        driver = driver.or_else(|| Some(cols[11].to_string()));
        gpus.push(GpuInfo {
            index,
            name: cols[1].to_string(),
            temp_c: opt_f32(cols[2]),
            util_percent: opt_f32(cols[3]),
            mem_used_mb: opt_u64(cols[4]),
            mem_total_mb: opt_u64(cols[5]),
            power_w: opt_f32(cols[6]),
            power_limit_w: opt_f32(cols[7]),
            clock_mhz: opt_u64(cols[8]),
            fan_percent: opt_f32(cols[9]),
            pstate: if cols[10].contains("N/A") {
                None
            } else {
                Some(cols[10].to_string())
            },
        });
    }
    (gpus, driver)
}

/// pmon rows: `# gpu pid type fb ... command` — header lines start with '#'.
/// Column layout varies slightly by driver, so find fb/command by header.
pub fn parse_pmon(stdout: &str) -> Vec<(u32, String, Option<u64>)> {
    let mut fb_col: Option<usize> = None;
    let mut cmd_col: Option<usize> = None;
    let mut out = Vec::new();
    for line in stdout.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with('#') {
            let headers: Vec<&str> = trimmed.trim_start_matches('#').split_whitespace().collect();
            for (i, h) in headers.iter().enumerate() {
                match *h {
                    "fb" => fb_col = Some(i),
                    "command" => cmd_col = Some(i),
                    _ => {}
                }
            }
            continue;
        }
        let cols: Vec<&str> = trimmed.split_whitespace().collect();
        if cols.len() < 3 {
            continue;
        }
        let Ok(pid) = cols[1].parse::<u32>() else {
            continue; // "-" rows mean an idle GPU slot
        };
        let mem = fb_col
            .and_then(|i| cols.get(i))
            .and_then(|v| v.parse::<u64>().ok());
        let name = cmd_col
            .and_then(|i| cols.get(i))
            .unwrap_or(&"?")
            .to_string();
        out.push((pid, name, mem));
    }
    out
}

pub fn status(scanner: &Arc<Mutex<Scanner>>) -> GpuStatus {
    let mut out = GpuStatus::default();
    let result = run_silent_timeout(
        "nvidia-smi",
        &[
            &format!("--query-gpu={QUERY}"),
            "--format=csv,noheader,nounits",
        ],
        Duration::from_secs(8),
    );
    let output = match result {
        Err(e) if is_not_found(&e) => {
            out.available = false;
            return out;
        }
        Err(e) => {
            out.available = true;
            out.error = Some(e.to_string());
            return out;
        }
        Ok(o) => o,
    };
    out.available = true;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let first = stderr
            .lines()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("nvidia-smi failed");
        out.error = Some(first.chars().take(120).collect());
        return out;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let (gpus, driver) = parse_query(&stdout);
    out.gpus = gpus;
    out.driver = driver;

    // Per-process VRAM; enrich with (start_time, killable) from the live
    // process table so kills stay identity-verified.
    if let Ok(pmon) = run_silent_timeout(
        "nvidia-smi",
        &["pmon", "-c", "1", "-s", "m"],
        Duration::from_secs(8),
    ) {
        if pmon.status.success() {
            let rows = parse_pmon(&String::from_utf8_lossy(&pmon.stdout));
            let scanner = scanner.lock().ok();
            for (pid, name, mem) in rows {
                let start = scanner.as_ref().and_then(|sc| {
                    sc.system()
                        .process(sysinfo::Pid::from_u32(pid))
                        .map(|p| p.start_time())
                });
                out.processes.push(GpuProcess {
                    pid,
                    name,
                    mem_mb: mem,
                    start_time_unix: start,
                    killable: start.is_some() && probe_killable(pid),
                });
            }
            out.processes.sort_by(|a, b| b.mem_mb.cmp(&a.mem_mb));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_query_csv_with_na_fields() {
        let sample = "0, NVIDIA GeForce RTX 4080, 52, 17, 3541, 16376, 55.61, 320.00, 1290, [N/A], P5, 560.94\n";
        let (gpus, driver) = parse_query(sample);
        assert_eq!(gpus.len(), 1);
        assert_eq!(gpus[0].name, "NVIDIA GeForce RTX 4080");
        assert_eq!(gpus[0].temp_c, Some(52.0));
        assert_eq!(gpus[0].mem_total_mb, Some(16376));
        assert_eq!(gpus[0].fan_percent, None);
        assert_eq!(driver.as_deref(), Some("560.94"));
    }

    #[test]
    fn parses_pmon_rows_and_skips_idle() {
        let sample = "\
# gpu        pid  type    fb   command
# Idx          #   C/G    MB   name
    0       1234     G   512   chrome.exe
    0          -     -     -   -
";
        let rows = parse_pmon(sample);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0], (1234, "chrome.exe".into(), Some(512)));
    }
}
