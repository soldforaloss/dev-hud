//! System health: CPU, RAM, swap, and network throughput.
//!
//! Keeps a long-lived sysinfo `System` + `Networks` so CPU percentages and
//! network deltas are meaningful between polls.

use std::sync::{Arc, Mutex};
use std::time::Instant;

use sysinfo::{CpuRefreshKind, MemoryRefreshKind, Networks, RefreshKind, System};

use crate::types::SystemHealth;

pub struct HealthMonitor {
    sys: System,
    networks: Networks,
    last_poll: Option<Instant>,
}

impl HealthMonitor {
    pub fn new() -> Self {
        Self {
            sys: System::new_with_specifics(
                RefreshKind::nothing()
                    .with_cpu(CpuRefreshKind::nothing().with_cpu_usage())
                    .with_memory(MemoryRefreshKind::everything()),
            ),
            networks: Networks::new_with_refreshed_list(),
            last_poll: None,
        }
    }

    pub fn poll(&mut self) -> SystemHealth {
        self.sys
            .refresh_cpu_specifics(CpuRefreshKind::nothing().with_cpu_usage());
        self.sys.refresh_memory();
        let (commit_used, commit_total) = commit_charge();

        // Network counters are deltas since the previous refresh; divide by
        // elapsed time for a rate. First poll has no baseline — report zero.
        let elapsed = self
            .last_poll
            .map(|t| t.elapsed().as_secs_f64())
            .unwrap_or(0.0);
        self.networks.refresh(true);
        self.last_poll = Some(Instant::now());

        let (mut rx, mut tx) = (0u64, 0u64);
        for (_name, data) in self.networks.iter() {
            rx += data.received();
            tx += data.transmitted();
        }
        let (net_rx_bps, net_tx_bps) = if elapsed > 0.2 {
            (
                (rx as f64 / elapsed) as u64,
                (tx as f64 / elapsed) as u64,
            )
        } else {
            (0, 0)
        };

        SystemHealth {
            cpu_percent: self.sys.global_cpu_usage(),
            mem_used: self.sys.used_memory(),
            mem_total: self.sys.total_memory(),
            swap_used: self.sys.used_swap(),
            swap_total: self.sys.total_swap(),
            commit_used,
            commit_total,
            net_rx_bps,
            net_tx_bps,
            local_ip: local_ip(),
            public_ip: None, // filled by the command layer from its cache
            // Both filled by the command layer: the queue counter is polled on
            // its own slower cadence, and the top-process list is read from the
            // scanner's already-refreshed table rather than refreshing every
            // process a second time on this 3-second poll.
            queue_length: None,
            top_processes: Vec::new(),
        }
    }
}

/// Windows processor queue length — the nearest analogue to a load average.
///
/// Read from a raw perf counter on its own 15-second cadence: it changes
/// slowly and a WMI round trip on every 3-second health poll would be a
/// measurable idle-CPU cost for a number nobody watches that closely.
pub fn queue_length() -> Option<f32> {
    #[cfg(windows)]
    {
        use std::sync::Mutex;
        use std::time::Duration;
        static CACHE: Mutex<Option<(Instant, Option<f32>)>> = Mutex::new(None);
        if let Ok(guard) = CACHE.lock() {
            if let Some((at, value)) = guard.as_ref() {
                if at.elapsed() < Duration::from_secs(15) {
                    return *value;
                }
            }
        }
        let value = crate::wmi_bridge::processor_queue();
        if let Ok(mut guard) = CACHE.lock() {
            *guard = Some((Instant::now(), value));
        }
        value
    }
    #[cfg(not(windows))]
    {
        None
    }
}

pub type HealthShared = Arc<Mutex<HealthMonitor>>;

/// Windows commit charge (committed bytes / commit limit) — RAM plus
/// pagefile the OS has promised out. This is what most task managers mean
/// by "pagefile/swap usage", unlike `used_swap` which only counts pages
/// actually written to disk.
#[cfg(windows)]
fn commit_charge() -> (u64, u64) {
    use windows_sys::Win32::System::ProcessStatus::{
        K32GetPerformanceInfo, PERFORMANCE_INFORMATION,
    };
    unsafe {
        let mut info: PERFORMANCE_INFORMATION = std::mem::zeroed();
        info.cb = std::mem::size_of::<PERFORMANCE_INFORMATION>() as u32;
        if K32GetPerformanceInfo(&mut info, info.cb) != 0 {
            let page = info.PageSize as u64;
            (info.CommitTotal as u64 * page, info.CommitLimit as u64 * page)
        } else {
            (0, 0)
        }
    }
}

#[cfg(not(windows))]
fn commit_charge() -> (u64, u64) {
    (0, 0)
}

/// LAN address: connect a UDP socket outward (no packet is sent) and read
/// the local endpoint the OS picked.
fn local_ip() -> Option<String> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    Some(socket.local_addr().ok()?.ip().to_string())
}
