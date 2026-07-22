//! Toast delivery with per-key rate limiting. Rule evaluation lives in the
//! frontend (it already holds every payload); this side just guarantees a
//! given alert key can't spam more than once per 10 minutes.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const MIN_INTERVAL: Duration = Duration::from_secs(600);

#[derive(Default)]
pub struct AlertGate(pub Mutex<HashMap<String, Instant>>);

impl AlertGate {
    /// True when this key is allowed to fire now (and records the firing).
    pub fn allow(&self, key: &str) -> bool {
        let Ok(mut fired) = self.0.lock() else {
            return false;
        };
        let now = Instant::now();
        match fired.get(key) {
            Some(last) if now.duration_since(*last) < MIN_INTERVAL => false,
            _ => {
                fired.insert(key.to_string(), now);
                true
            }
        }
    }
}
