//! Ollama local model server: loaded models from /api/ps, installed count
//! from /api/tags. Connection refused = not running (card auto-hides).

use crate::types::{OllamaModel, OllamaStatus};

pub async fn status(http: &reqwest::Client, port: u16) -> OllamaStatus {
    let mut out = OllamaStatus::default();
    let base = format!("http://127.0.0.1:{port}");
    let ps = http
        .get(format!("{base}/api/ps"))
        .timeout(std::time::Duration::from_secs(3))
        .send()
        .await;
    let Ok(resp) = ps else { return out };
    if !resp.status().is_success() {
        return out;
    }
    out.reachable = true;
    if let Ok(body) = resp.json::<serde_json::Value>().await {
        if let Some(models) = body.get("models").and_then(|m| m.as_array()) {
            for m in models {
                out.loaded.push(OllamaModel {
                    name: m
                        .get("name")
                        .and_then(|n| n.as_str())
                        .unwrap_or("?")
                        .to_string(),
                    vram_bytes: m.get("size_vram").and_then(|s| s.as_u64()),
                    expires_at: m
                        .get("expires_at")
                        .and_then(|e| e.as_str())
                        .map(String::from),
                });
            }
        }
    }
    if let Ok(resp) = http
        .get(format!("{base}/api/tags"))
        .timeout(std::time::Duration::from_secs(3))
        .send()
        .await
    {
        if let Ok(body) = resp.json::<serde_json::Value>().await {
            out.installed_count = body
                .get("models")
                .and_then(|m| m.as_array())
                .map(|m| m.len() as u32)
                .unwrap_or(0);
        }
    }
    out
}
