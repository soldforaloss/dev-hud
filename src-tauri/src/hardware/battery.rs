//! Battery + active power plan. Win32_Battery only exists on machines with a
//! battery (laptops, UPS) — absence means the card auto-hides.

use std::time::Duration;

use crate::cli::run_silent_timeout;
use crate::types::BatteryInfo;
use crate::wmi_bridge;

pub fn parse_powercfg(stdout: &str) -> Option<String> {
    // "Power Scheme GUID: 381b4222-...  (Balanced)"
    let line = stdout.lines().find(|l| l.contains('('))?;
    let start = line.find('(')?;
    let end = line.rfind(')')?;
    if end > start + 1 {
        Some(line[start + 1..end].to_string())
    } else {
        None
    }
}

pub fn status() -> BatteryInfo {
    let batteries = wmi_bridge::battery();
    let mut out = BatteryInfo::default();
    if let Some((charge, status_code, runtime)) = batteries.first().copied() {
        out.present = true;
        out.percent = Some(charge.min(100) as u32);
        // BatteryStatus 1 = discharging; everything else means AC involved.
        out.on_ac = Some(status_code != 1);
        // Huge sentinel values mean "unknown".
        out.runtime_min = (status_code == 1 && runtime > 0 && runtime < 10_000)
            .then_some(runtime);
    }
    if let Ok(o) = run_silent_timeout("powercfg", &["/getactivescheme"], Duration::from_secs(4)) {
        if o.status.success() {
            out.power_plan = parse_powercfg(&String::from_utf8_lossy(&o.stdout));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_powercfg_scheme_name() {
        let sample = "Power Scheme GUID: 381b4222-f694-41f0-9685-ff5bb260df2e  (Balanced)\n";
        assert_eq!(parse_powercfg(sample).as_deref(), Some("Balanced"));
    }
}
