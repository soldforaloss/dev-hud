//! On-demand speedtest against Cloudflare's speed endpoints. Never runs
//! automatically — it moves ~33 MB per click by design.

use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::types::SpeedtestResult;

const DOWN_BYTES: u64 = 25_000_000; // 25 MB
const UP_BYTES: usize = 8_000_000; // 8 MB

pub async fn run(http: &reqwest::Client) -> Result<SpeedtestResult, String> {
    // Latency: median-ish of 3 tiny fetches.
    let mut lats = Vec::new();
    for _ in 0..3 {
        let t0 = Instant::now();
        let r = http
            .get("https://speed.cloudflare.com/__down?bytes=1")
            .timeout(Duration::from_secs(5))
            .send()
            .await
            .map_err(|e| format!("latency probe failed: {e}"))?;
        let _ = r.bytes().await;
        lats.push(t0.elapsed().as_secs_f64() * 1000.0);
    }
    lats.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let latency_ms = lats.get(1).copied().unwrap_or(0.0);

    // Download.
    let t0 = Instant::now();
    let resp = http
        .get(format!(
            "https://speed.cloudflare.com/__down?bytes={DOWN_BYTES}"
        ))
        .timeout(Duration::from_secs(45))
        .send()
        .await
        .map_err(|e| format!("download failed: {e}"))?;
    let body = resp
        .bytes()
        .await
        .map_err(|e| format!("download failed: {e}"))?;
    let down_secs = t0.elapsed().as_secs_f64().max(0.001);
    let down_mbps = (body.len() as f64 * 8.0) / down_secs / 1_000_000.0;

    // Upload.
    let payload = vec![0u8; UP_BYTES];
    let t0 = Instant::now();
    let resp = http
        .post("https://speed.cloudflare.com/__up")
        .body(payload)
        .timeout(Duration::from_secs(45))
        .send()
        .await
        .map_err(|e| format!("upload failed: {e}"))?;
    let _ = resp.bytes().await;
    let up_secs = t0.elapsed().as_secs_f64().max(0.001);
    let up_mbps = (UP_BYTES as f64 * 8.0) / up_secs / 1_000_000.0;

    Ok(SpeedtestResult {
        down_mbps,
        up_mbps,
        latency_ms,
        // Jitter needs repeated probes; this test takes one latency sample, so
        // reporting a number here would be inventing one.
        jitter_ms: None,
        provider: "speed.cloudflare.com".into(),
        at_unix: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0),
    })
}
