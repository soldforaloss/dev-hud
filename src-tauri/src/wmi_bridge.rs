//! WMI access on a single dedicated thread.
//!
//! `WMIConnection` is neither Send nor cheap to create, and COM must be
//! initialized per thread — so one long-lived worker owns the connections and
//! everything else talks to it over a channel. Requests carry their own reply
//! sender; a 3-second reply timeout keeps a wedged WMI service from hanging
//! callers.

use std::collections::HashMap;
use std::sync::mpsc::{self, Sender};
use std::sync::OnceLock;
use std::time::Duration;

use wmi::{COMLibrary, Variant, WMIConnection};

pub enum WmiRequest {
    /// Thermal zone temps in °C (root\WMI, deciKelvin source).
    ThermalZones(Sender<Vec<f32>>),
    /// (charge %, battery status code, est. runtime minutes) per battery.
    Battery(Sender<Vec<(u16, u16, u32)>>),
    /// (read B/s, write B/s) across physical disks (_Total).
    DiskPerf(Sender<(u64, u64)>),
    /// Processor queue length — Windows' nearest analogue to a load average.
    ProcessorQueue(Sender<Option<f32>>),
}

fn variant_u64(v: &Variant) -> Option<u64> {
    match v {
        Variant::UI1(x) => Some(*x as u64),
        Variant::UI2(x) => Some(*x as u64),
        Variant::UI4(x) => Some(*x as u64),
        Variant::UI8(x) => Some(*x),
        Variant::I1(x) => u64::try_from(*x).ok(),
        Variant::I2(x) => u64::try_from(*x).ok(),
        Variant::I4(x) => u64::try_from(*x).ok(),
        Variant::I8(x) => u64::try_from(*x).ok(),
        Variant::String(s) => s.parse().ok(),
        _ => None,
    }
}

fn worker(rx: mpsc::Receiver<WmiRequest>) {
    let Ok(com) = COMLibrary::new() else { return };
    let root_wmi = WMIConnection::with_namespace_path("root\\WMI", com);
    let cimv2 = WMIConnection::with_namespace_path("root\\cimv2", com);

    while let Ok(req) = rx.recv() {
        match req {
            WmiRequest::ThermalZones(reply) => {
                let mut temps = Vec::new();
                if let Ok(conn) = &root_wmi {
                    if let Ok(rows) = conn.raw_query::<HashMap<String, Variant>>(
                        "SELECT CurrentTemperature FROM MSAcpi_ThermalZoneTemperature",
                    ) {
                        for row in rows {
                            if let Some(dk) =
                                row.get("CurrentTemperature").and_then(variant_u64)
                            {
                                let c = dk as f32 / 10.0 - 273.15;
                                if (-30.0..150.0).contains(&c) {
                                    temps.push(c);
                                }
                            }
                        }
                    }
                }
                let _ = reply.send(temps);
            }
            WmiRequest::Battery(reply) => {
                let mut out = Vec::new();
                if let Ok(conn) = &cimv2 {
                    if let Ok(rows) = conn.raw_query::<HashMap<String, Variant>>(
                        "SELECT EstimatedChargeRemaining, BatteryStatus, EstimatedRunTime FROM Win32_Battery",
                    ) {
                        for row in rows {
                            let charge = row
                                .get("EstimatedChargeRemaining")
                                .and_then(variant_u64)
                                .unwrap_or(0) as u16;
                            let status = row
                                .get("BatteryStatus")
                                .and_then(variant_u64)
                                .unwrap_or(0) as u16;
                            let runtime = row
                                .get("EstimatedRunTime")
                                .and_then(variant_u64)
                                .unwrap_or(0) as u32;
                            out.push((charge, status, runtime));
                        }
                    }
                }
                let _ = reply.send(out);
            }
            WmiRequest::DiskPerf(reply) => {
                let mut result = (0u64, 0u64);
                if let Ok(conn) = &cimv2 {
                    if let Ok(rows) = conn.raw_query::<HashMap<String, Variant>>(
                        "SELECT Name, DiskReadBytesPersec, DiskWriteBytesPersec FROM Win32_PerfFormattedData_PerfDisk_PhysicalDisk WHERE Name = '_Total'",
                    ) {
                        for row in rows {
                            result.0 = row
                                .get("DiskReadBytesPersec")
                                .and_then(variant_u64)
                                .unwrap_or(0);
                            result.1 = row
                                .get("DiskWriteBytesPersec")
                                .and_then(variant_u64)
                                .unwrap_or(0);
                        }
                    }
                }
                let _ = reply.send(result);
            }
            WmiRequest::ProcessorQueue(reply) => {
                // None, not 0: an unreadable counter is not an idle machine.
                let mut out: Option<f32> = None;
                if let Ok(conn) = &cimv2 {
                    if let Ok(rows) = conn.raw_query::<HashMap<String, Variant>>(
                        "SELECT ProcessorQueueLength FROM Win32_PerfFormattedData_PerfOS_System",
                    ) {
                        for row in rows {
                            if let Some(q) = row.get("ProcessorQueueLength").and_then(variant_u64) {
                                out = Some(q as f32);
                            }
                        }
                    }
                }
                let _ = reply.send(out);
            }
        }
    }
}

fn sender() -> &'static Sender<WmiRequest> {
    static TX: OnceLock<Sender<WmiRequest>> = OnceLock::new();
    TX.get_or_init(|| {
        let (tx, rx) = mpsc::channel();
        std::thread::Builder::new()
            .name("wmi-bridge".into())
            .spawn(move || worker(rx))
            .expect("spawn wmi bridge");
        tx
    })
}

fn ask<T>(build: impl FnOnce(Sender<T>) -> WmiRequest) -> Option<T> {
    let (reply_tx, reply_rx) = mpsc::channel();
    sender().send(build(reply_tx)).ok()?;
    reply_rx.recv_timeout(Duration::from_secs(3)).ok()
}

pub fn thermal_zones() -> Vec<f32> {
    ask(WmiRequest::ThermalZones).unwrap_or_default()
}

pub fn battery() -> Vec<(u16, u16, u32)> {
    ask(WmiRequest::Battery).unwrap_or_default()
}

pub fn disk_perf() -> (u64, u64) {
    ask(WmiRequest::DiskPerf).unwrap_or((0, 0))
}

pub fn processor_queue() -> Option<f32> {
    ask(WmiRequest::ProcessorQueue).flatten()
}
