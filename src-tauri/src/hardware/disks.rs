//! Volumes (capacity, media type) via sysinfo + global read/write throughput
//! via the WMI formatted perf counters (already rates, no delta math needed).
//! Latency is the exception: its formatted counter is a whole-second integer,
//! so it comes from the raw counter and a remembered sample instead.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use sysinfo::{DiskKind, Disks};
use wmi::{COMLibrary, Variant, WMIConnection};

use crate::types::{DiskVolume, DisksStatus};
use crate::wmi_bridge;

/// SMART barely moves and the query is slow, so one verdict is reused for
/// this long.
const SMART_TTL: Duration = Duration::from_secs(600);

/// (queried at, verdict). The inner `None` means "the driver never told us",
/// which is deliberately not the same as "healthy".
static SMART_CACHE: Mutex<Option<(Instant, Option<bool>)>> = Mutex::new(None);

/// Previous (elapsed ticks, transfer count) from the raw perf counter, so the
/// average can be taken over the last interval instead of since boot.
static LATENCY_PREV: Mutex<Option<(u32, u32)>> = Mutex::new(None);

/// wmi_bridge's worker speaks a fixed request enum, so these two disk-only
/// queries get their own short-lived COM thread — WMI insists on being talked
/// to from a thread that initialized COM, and disks poll slowly enough
/// (8s) that a resident connection isn't worth a second permanent thread.
/// `Variant` is not `Send`, so the closure has to reduce rows to plain data
/// before handing anything back.
fn with_wmi<T: Send + 'static>(
    namespace: &'static str,
    query: impl FnOnce(&WMIConnection) -> T + Send + 'static,
) -> Option<T> {
    std::thread::spawn(move || {
        let com = COMLibrary::new().ok()?;
        let conn = WMIConnection::with_namespace_path(namespace, com).ok()?;
        Some(query(&conn))
    })
    .join()
    .ok()
    .flatten()
}

fn variant_u64(v: &Variant) -> Option<u64> {
    match v {
        Variant::UI1(x) => Some(*x as u64),
        Variant::UI2(x) => Some(*x as u64),
        Variant::UI4(x) => Some(*x as u64),
        Variant::UI8(x) => Some(*x),
        Variant::I4(x) => u64::try_from(*x).ok(),
        Variant::I8(x) => u64::try_from(*x).ok(),
        Variant::String(s) => s.parse().ok(),
        _ => None,
    }
}

fn variant_bool(v: &Variant) -> Option<bool> {
    match v {
        Variant::Bool(b) => Some(*b),
        other => variant_u64(other).map(|n| n != 0),
    }
}

/// PERF_AVERAGE_TIMER: seconds = (Δticks / frequency) / Δoperations. The
/// *formatted* class exposes this as a whole-second u32, which truncates every
/// real disk to 0, so the raw counter and a remembered sample are the only
/// honest source.
pub fn avg_latency_ms(prev: Option<(u32, u32)>, cur: (u32, u32), freq: u64) -> Option<f32> {
    let (prev_ticks, prev_ops) = prev?;
    if freq == 0 {
        return None;
    }
    // Counters are u32 and wrap; the delta is still correct modulo 2^32.
    let ticks = cur.0.wrapping_sub(prev_ticks) as f64;
    let ops = cur.1.wrapping_sub(prev_ops) as f64;
    if ops <= 0.0 {
        return None; // no I/O this interval — nothing was measured
    }
    Some(((ticks / freq as f64) / ops * 1000.0) as f32)
}

fn query_latency_ms() -> Option<f32> {
    let (ticks, ops, freq) = with_wmi("root\\cimv2", |conn| {
        let rows = conn
            .raw_query::<HashMap<String, Variant>>(
                "SELECT AvgDisksecPerTransfer, AvgDisksecPerTransfer_Base, Frequency_PerfTime \
                 FROM Win32_PerfRawData_PerfDisk_PhysicalDisk WHERE Name = '_Total'",
            )
            .ok()?;
        let row = rows.into_iter().next()?;
        Some((
            row.get("AvgDisksecPerTransfer").and_then(variant_u64)? as u32,
            row.get("AvgDisksecPerTransfer_Base").and_then(variant_u64)? as u32,
            row.get("Frequency_PerfTime").and_then(variant_u64)?,
        ))
    })??;

    let mut prev = LATENCY_PREV.lock().expect("disk latency sample");
    let out = avg_latency_ms(*prev, (ticks, ops), freq);
    *prev = Some((ticks, ops));
    out
}

/// One verdict for the whole machine: InstanceName can't be mapped back to a
/// drive letter reliably, so a mixed answer is reported as unknown rather than
/// pinned to the wrong volume. `None` also covers NVMe and RAID controllers,
/// which simply don't publish this class.
fn query_smart_ok() -> Option<bool> {
    let failing: Vec<bool> = with_wmi("root\\wmi", |conn| {
        let rows = conn
            .raw_query::<HashMap<String, Variant>>(
                "SELECT InstanceName, PredictFailure FROM MSStorageDriver_FailurePredictStatus",
            )
            .ok()?;
        // One unreadable row invalidates the whole verdict.
        rows.iter()
            .map(|r| r.get("PredictFailure").and_then(variant_bool))
            .collect::<Option<Vec<bool>>>()
    })??;
    verdict_from(&failing)
}

/// `None` for "no rows" and for "the drives disagree" alike: neither can be
/// pinned to a specific volume, and a wrong "healthy" is the worst answer.
pub fn verdict_from(failing: &[bool]) -> Option<bool> {
    let first = *failing.first()?;
    failing.iter().all(|f| *f == first).then_some(!first)
}

fn smart_ok_cached() -> Option<bool> {
    let mut cache = SMART_CACHE.lock().expect("smart cache");
    if let Some((at, verdict)) = *cache {
        if at.elapsed() < SMART_TTL {
            return verdict;
        }
    }
    let verdict = query_smart_ok();
    *cache = Some((Instant::now(), verdict));
    verdict
}

fn kind_label(kind: DiskKind) -> &'static str {
    match kind {
        DiskKind::SSD => "ssd",
        DiskKind::HDD => "hdd",
        DiskKind::Unknown(_) => "unknown",
    }
}

pub fn status() -> DisksStatus {
    let disks = Disks::new_with_refreshed_list();
    let smart_ok = smart_ok_cached();
    let mut volumes: Vec<DiskVolume> = disks
        .iter()
        .map(|d| {
            let fs = d.file_system().to_string_lossy().into_owned();
            let removable = d.is_removable();
            DiskVolume {
                mount: d.mount_point().to_string_lossy().into_owned(),
                label: {
                    let name = d.name().to_string_lossy().into_owned();
                    if name.is_empty() {
                        fs.clone()
                    } else {
                        name
                    }
                },
                total: d.total_space(),
                available: d.available_space(),
                fs: if fs.is_empty() { None } else { Some(fs) },
                kind: kind_label(d.kind()).into(),
                removable,
                // Removable media isn't covered by the fixed-disk SMART rows.
                smart_ok: if removable { None } else { smart_ok },
            }
        })
        .filter(|v| v.total > 0)
        .collect();
    volumes.sort_by(|a, b| a.mount.cmp(&b.mount));
    volumes.dedup_by(|a, b| a.mount == b.mount);
    let (read_bps, write_bps) = wmi_bridge::disk_perf();
    DisksStatus {
        volumes,
        read_bps,
        write_bps,
        latency_ms: query_latency_ms(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn latency_needs_a_previous_sample_and_real_io() {
        // First poll has nothing to diff against.
        assert_eq!(avg_latency_ms(None, (1_000, 10), 10_000_000), None);
        // Idle interval: no transfers completed, so nothing was measured.
        assert_eq!(avg_latency_ms(Some((1_000, 10)), (1_000, 10), 10_000_000), None);
        // A broken frequency can't be divided by.
        assert_eq!(avg_latency_ms(Some((0, 0)), (1_000, 10), 0), None);
    }

    #[test]
    fn latency_averages_over_the_interval() {
        // 10M ticks/s: 2M ticks (0.2s) across 10 transfers = 20ms each.
        let ms = avg_latency_ms(Some((0, 0)), (2_000_000, 10), 10_000_000).unwrap();
        assert!((ms - 20.0).abs() < 0.001, "got {ms}");
    }

    #[test]
    fn latency_survives_counter_wrap() {
        let prev = (u32::MAX - 999, 100);
        let cur = (1_000u32, 110u32); // wrapped: 2000 ticks, 10 transfers
        let ms = avg_latency_ms(Some(prev), cur, 10_000_000).unwrap();
        assert!((ms - 0.02).abs() < 0.0001, "got {ms}");
    }

    #[test]
    fn smart_verdict_needs_unanimity() {
        assert_eq!(verdict_from(&[]), None); // class unavailable
        assert_eq!(verdict_from(&[false, false]), Some(true));
        assert_eq!(verdict_from(&[true, true]), Some(false));
        assert_eq!(verdict_from(&[false, true]), None); // can't say which drive
    }

    #[test]
    fn maps_disk_kinds() {
        assert_eq!(kind_label(DiskKind::SSD), "ssd");
        assert_eq!(kind_label(DiskKind::HDD), "hdd");
        assert_eq!(kind_label(DiskKind::Unknown(-1)), "unknown");
    }
}
