//! CPU temperatures & fans, tiered by what the machine offers:
//! 1. "lhm"  — LibreHardwareMonitor's web server (http://localhost:{port}/data.json):
//!             package + per-core temps, fan RPM. Full telemetry, needs the
//!             user to run LHM once (guided in settings). Legacy
//!             OpenHardwareMonitor serves the same JSON shape.
//! 2. "wmi"  — MSAcpi_ThermalZoneTemperature: a motherboard zone at best,
//!             unsupported on many desktops.
//! 3. "none" — nothing readable without elevation; the card points at setup.

use crate::types::ThermalsStatus;
use crate::wmi_bridge;

fn parse_value(text: &str) -> Option<f32> {
    // LHM values look like "47.0 °C" / "1,234 RPM" — and ',' is a thousands
    // separator on English locales but a decimal on European ones. A comma
    // followed by exactly 3 trailing digits reads as thousands.
    let cleaned: String = text
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.' || *c == ',')
        .collect();
    if cleaned.is_empty() {
        return None;
    }
    let normalized = if cleaned.contains('.') {
        cleaned.replace(',', "")
    } else if let Some((_, frac)) = cleaned.rsplit_once(',') {
        if frac.len() == 3 {
            cleaned.replace(',', "")
        } else {
            cleaned.replace(',', ".")
        }
    } else {
        cleaned
    };
    normalized.parse().ok()
}

struct LhmSensors {
    cpu_temps: Vec<(String, f32)>,
    fans: Vec<u32>,
    count: u32,
    throttling: Option<bool>,
}

/// LHM names these "Thermal Throttling" / "Thermal Limit" depending on vendor;
/// both report a level where anything above zero means the clock is capped.
fn is_throttle_sensor(text: &str) -> bool {
    let t = text.to_ascii_lowercase();
    t.contains("thermal") && (t.contains("limit") || t.contains("throttl"))
}

fn walk(node: &serde_json::Value, under_cpu: bool, acc: &mut LhmSensors) {
    let text = node.get("Text").and_then(|t| t.as_str()).unwrap_or("");
    let image = node.get("ImageURL").and_then(|t| t.as_str()).unwrap_or("");
    let is_cpu_device = image.contains("cpu.png") || text.to_ascii_lowercase().contains("cpu");
    let value = node.get("Value").and_then(|v| v.as_str()).unwrap_or("");

    if !value.is_empty() {
        acc.count += 1;
        if value.contains("°C") && (under_cpu || is_cpu_device) {
            if let Some(v) = parse_value(value) {
                acc.cpu_temps.push((text.to_string(), v));
            }
        }
        if value.contains("RPM") {
            if let Some(v) = parse_value(value) {
                if v > 0.0 {
                    acc.fans.push(v as u32);
                }
            }
        }
        if is_throttle_sensor(text) {
            if let Some(v) = parse_value(value) {
                // Any throttling sensor reading hot wins over the others.
                acc.throttling = Some(acc.throttling.unwrap_or(false) || v > 0.0);
            }
        }
    }
    if let Some(children) = node.get("Children").and_then(|c| c.as_array()) {
        for child in children {
            walk(child, under_cpu || is_cpu_device, acc);
        }
    }
}

pub fn parse_lhm(root: &serde_json::Value) -> ThermalsStatus {
    let mut acc = LhmSensors {
        cpu_temps: Vec::new(),
        fans: Vec::new(),
        count: 0,
        throttling: None,
    };
    walk(root, false, &mut acc);
    let package = acc
        .cpu_temps
        .iter()
        .find(|(name, _)| {
            let n = name.to_ascii_lowercase();
            n.contains("package") || n.contains("tctl") || n.contains("tdie")
        })
        .map(|(_, v)| *v);
    let max_core = acc
        .cpu_temps
        .iter()
        .filter(|(name, _)| name.to_ascii_lowercase().contains("core"))
        .map(|(_, v)| *v)
        .fold(None::<f32>, |acc, v| Some(acc.map_or(v, |a| a.max(v))));
    let fallback = acc
        .cpu_temps
        .iter()
        .map(|(_, v)| *v)
        .fold(None::<f32>, |acc, v| Some(acc.map_or(v, |a| a.max(v))));
    ThermalsStatus {
        tier: "lhm".into(),
        cpu_package_c: package.or(fallback),
        cpu_max_core_c: max_core,
        zone_c: None,
        fans_rpm: acc.fans,
        sensor_count: acc.count,
        throttling: acc.throttling,
    }
}

pub async fn status(http: &reqwest::Client, lhm_port: u16) -> ThermalsStatus {
    // Tier 1: LibreHardwareMonitor / OpenHardwareMonitor web server.
    let url = format!("http://127.0.0.1:{lhm_port}/data.json");
    if let Ok(resp) = http
        .get(&url)
        .timeout(std::time::Duration::from_millis(1800))
        .send()
        .await
    {
        if resp.status().is_success() {
            if let Ok(body) = resp.json::<serde_json::Value>().await {
                let parsed = parse_lhm(&body);
                if parsed.cpu_package_c.is_some() || parsed.sensor_count > 0 {
                    return parsed;
                }
            }
        }
    }

    // Tier 2: WMI thermal zone (blocking, via the bridge thread).
    let zones = tauri::async_runtime::spawn_blocking(wmi_bridge::thermal_zones)
        .await
        .unwrap_or_default();
    if let Some(max) = zones.iter().copied().fold(None::<f32>, |acc, v| {
        Some(acc.map_or(v, |a| a.max(v)))
    }) {
        return ThermalsStatus {
            tier: "wmi".into(),
            cpu_package_c: None,
            cpu_max_core_c: None,
            zone_c: Some(max),
            fans_rpm: vec![],
            sensor_count: zones.len() as u32,
            // The thermal zone class has no throttle signal to read.
            throttling: None,
        };
    }

    ThermalsStatus {
        tier: "none".into(),
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_lhm_tree() {
        let json = serde_json::json!({
            "Text": "Sensor", "Children": [{
                "Text": "AMD Ryzen 9", "ImageURL": "images_icon/cpu.png", "Children": [{
                    "Text": "Temperatures", "Children": [
                        {"Text": "CPU Package", "Value": "62.5 °C", "Children": []},
                        {"Text": "Core #1", "Value": "58.0 °C", "Children": []},
                        {"Text": "Core #2", "Value": "64.0 °C", "Children": []}
                    ]
                }]
            }, {
                "Text": "Motherboard", "Children": [{
                    "Text": "Fans", "Children": [
                        {"Text": "Fan #1", "Value": "1,240 RPM", "Children": []}
                    ]
                }]
            }]
        });
        let t = parse_lhm(&json);
        assert_eq!(t.tier, "lhm");
        assert_eq!(t.cpu_package_c, Some(62.5));
        assert_eq!(t.cpu_max_core_c, Some(64.0));
        assert_eq!(t.fans_rpm, vec![1240]);
        assert_eq!(t.throttling, None);
    }

    fn tree_with_throttle_sensor(text: &str, value: &str) -> serde_json::Value {
        serde_json::json!({
            "Text": "Sensor", "Children": [{
                "Text": "Intel Core i9", "ImageURL": "images_icon/cpu.png", "Children": [{
                    "Text": "Temperatures", "Children": [
                        {"Text": "CPU Package", "Value": "70.0 °C", "Children": []}
                    ]
                }, {
                    "Text": "Levels", "Children": [
                        {"Text": text, "Value": value, "Children": []}
                    ]
                }]
            }]
        })
    }

    #[test]
    fn extracts_throttling_level() {
        assert_eq!(
            parse_lhm(&tree_with_throttle_sensor("CPU Core Thermal Throttling", "1")).throttling,
            Some(true)
        );
        assert_eq!(
            parse_lhm(&tree_with_throttle_sensor("CPU Core Thermal Throttling", "0")).throttling,
            Some(false)
        );
        assert_eq!(
            parse_lhm(&tree_with_throttle_sensor("GPU Thermal Limit", "1.0")).throttling,
            Some(true)
        );
        // An unrelated sensor must leave it unmeasured, not "not throttling".
        assert_eq!(
            parse_lhm(&tree_with_throttle_sensor("CPU Total Load", "12.5")).throttling,
            None
        );
    }
}
