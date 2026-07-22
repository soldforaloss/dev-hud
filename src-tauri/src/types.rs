//! Payload contract between the Rust backend and the UI.
//! Mirror of src/types.ts — change both together.

use serde::{Deserialize, Serialize};

// ---------- processes ----------

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProcInfo {
    pub pid: u32,
    pub ppid: Option<u32>,
    /// Runtime executable name, e.g. "node.exe".
    pub name: String,
    /// Detected tool running inside the runtime: "OpenClaw Gateway", "Vite", …
    pub label: Option<String>,
    /// Compact human-readable command line (script name or truncated args).
    pub cmd_summary: String,
    pub cwd: Option<String>,
    pub start_time_unix: u64,
    pub mem_bytes: u64,
    pub cpu_percent: f32,
    pub killable: bool,
    /// All descendant PIDs (children, grandchildren, …) present at scan time.
    pub child_pids: Vec<u32>,
    /// Nearest non-runtime ancestor app ("Claude", "Code", …), if any.
    pub parent_app: Option<String>,
    /// The process chain that spawned this is dead — strongest leftover signal.
    pub orphaned: bool,
    /// Seconds since last observed meaningful CPU activity (>= 0.5%).
    pub idle_secs: u64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProcessesPayload {
    pub scanned_at: String,
    pub processes: Vec<ProcInfo>,
}

/// Identity pair for kills — never kill by PID alone.
#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct KillTarget {
    pub pid: u32,
    pub start_time_unix: u64,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct KillAllSummary {
    pub killed: Vec<u32>,
    pub denied: Vec<u32>,
    pub already_exited: Vec<u32>,
    pub reused: Vec<u32>,
    pub failed: Vec<u32>,
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum KillStatus {
    Killed,
    AlreadyExited,
    PidReused,
    AccessDenied,
    Unknown,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct KillResult {
    pub status: KillStatus,
    pub os_code: Option<u32>,
    pub killed_pids: Vec<u32>,
}

// ---------- AI usage ----------

/// A session transcript that changed within the last few minutes — the
/// "what is working right now" signal for Claude/Codex cards.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ActiveSession {
    /// Display name: last path component of the working directory.
    pub name: String,
    pub cwd: Option<String>,
    /// Seconds since the transcript last changed.
    pub age_secs: u64,
    /// Model last named in the transcript, when the log records one.
    pub model: Option<String>,
    /// Cumulative tokens attributed to this session, when derivable.
    pub tokens: Option<u64>,
    pub cost_usd: Option<f64>,
}

#[derive(Serialize, Clone, Copy, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct TokenTotals {
    pub input: u64,
    pub output: u64,
    pub cache_write: u64,
    pub cache_read: u64,
}

impl TokenTotals {
    pub fn total(&self) -> u64 {
        self.input + self.output + self.cache_write + self.cache_read
    }
    pub fn add(&mut self, other: &TokenTotals) {
        self.input += other.input;
        self.output += other.output;
        self.cache_write += other.cache_write;
        self.cache_read += other.cache_read;
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsage {
    pub model: String,
    pub tokens: u64,
    pub cost_usd: f64,
}

/// Per-project spend for the day, so cost can be attributed to work.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProjectUsage {
    pub project: String,
    pub tokens: u64,
    pub cost_usd: f64,
    pub sessions: u32,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HourBucket {
    pub hour_unix: i64,
    pub tokens: u64,
    pub cost_usd: f64,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeUsage {
    pub available: bool,
    /// Subscription plan from OAuth credentials ("max", "pro"), if readable.
    pub plan: Option<String>,
    /// Live rate-limit windows from the OAuth usage API ("5h", "Weekly", …).
    /// Empty when the API is unreachable — the local estimates below still work.
    pub windows: Vec<RateWindow>,
    pub today_tokens: TokenTotals,
    pub today_cost_usd: f64,
    pub week_tokens_total: u64,
    pub week_cost_usd: f64,
    /// Active 5-hour billing block (ccusage-style). Zeros when idle.
    pub block_tokens_total: u64,
    pub block_cost_usd: f64,
    pub block_started_unix: i64,
    pub block_ends_unix: i64,
    pub models_today: Vec<ModelUsage>,
    /// Last 24 hourly buckets, oldest first — sparkline data.
    pub hourly: Vec<HourBucket>,
    /// Sessions whose transcript changed in the last ~10 minutes, newest first.
    pub active_sessions: Vec<ActiveSession>,
    pub projects_today: Vec<ProjectUsage>,
    /// True only when `windows` came from the provider API, not a local guess.
    pub windows_live: bool,
    /// Why the provider call failed, when it did.
    pub provider_error: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RateWindow {
    /// "5h", "Weekly", or "Xh"/"Xd" derived from window minutes.
    pub label: String,
    pub used_percent: f64,
    pub resets_at_unix: i64,
    pub window_minutes: i64,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct CodexUsage {
    pub available: bool,
    pub plan: Option<String>,
    pub primary: Option<RateWindow>,
    pub secondary: Option<RateWindow>,
    pub today_tokens_total: u64,
    pub today_sessions: u32,
    pub last_event_unix: i64,
    /// Sessions whose rollout changed in the last ~10 minutes, newest first.
    pub active_sessions: Vec<ActiveSession>,
    pub projects_today: Vec<ProjectUsage>,
}

// ---------- system health ----------

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TopProcess {
    pub pid: u32,
    pub name: String,
    pub cpu_percent: f32,
    pub mem_bytes: u64,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SystemHealth {
    pub cpu_percent: f32,
    pub mem_used: u64,
    pub mem_total: u64,
    pub swap_used: u64,
    pub swap_total: u64,
    /// Windows commit charge: RAM + pagefile the OS has promised (this is
    /// the number most task managers label "swap/pagefile usage"). Zero on
    /// platforms where it doesn't apply.
    pub commit_used: u64,
    pub commit_total: u64,
    /// Network rates in bytes/second across all interfaces.
    pub net_rx_bps: u64,
    pub net_tx_bps: u64,
    pub local_ip: Option<String>,
    pub public_ip: Option<String>,
    /// Processor queue length — Windows' closest analogue to load average.
    pub queue_length: Option<f32>,
    pub top_processes: Vec<TopProcess>,
}

// ---------- tailscale ----------

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TailscalePeer {
    pub name: String,
    pub os: Option<String>,
    pub online: bool,
    /// DERP region short code when relayed; None when the path is direct.
    pub relay: Option<String>,
    pub direct: bool,
    pub last_seen: Option<String>,
    pub ip: Option<String>,
    pub exit_node: bool,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct TailscaleStatus {
    pub installed: bool,
    /// BackendState: "Running" | "Stopped" | "NeedsLogin" | …
    pub state: Option<String>,
    pub ip: Option<String>,
    pub hostname: Option<String>,
    pub magic_dns: Option<String>,
    pub peers_online: u32,
    pub peers_total: u32,
    pub error: Option<String>,
    pub relay: Option<String>,
    pub self_direct: bool,
    pub exit_node_active: Option<String>,
    pub advertised_routes: Vec<String>,
    pub key_expiry_unix: Option<i64>,
    pub peers: Vec<TailscalePeer>,
}

// ---------- docker ----------

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PortMapping {
    pub container_port: u16,
    pub host_port: Option<u16>,
    pub host_ip: Option<String>,
    pub proto: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ContainerInfo {
    pub id: String,
    pub name: String,
    pub image: String,
    pub state: String,
    pub status: String,
    pub ports: Option<String>,
    pub port_list: Vec<PortMapping>,
    /// "healthy" | "unhealthy" | "starting"; None when no healthcheck exists.
    pub health: Option<String>,
    pub restart_count: Option<u32>,
    pub created_unix: Option<i64>,
    pub cpu_percent: Option<f32>,
    pub mem_bytes: Option<u64>,
    pub mem_limit_bytes: Option<u64>,
    pub net_rx_bytes: Option<u64>,
    pub net_tx_bytes: Option<u64>,
    pub block_read_bytes: Option<u64>,
    pub block_write_bytes: Option<u64>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct DockerStatus {
    pub installed: bool,
    pub daemon_up: bool,
    pub containers: Vec<ContainerInfo>,
    pub error: Option<String>,
}

// ---------- OpenClaw gateway ----------

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct OpenClawStatus {
    pub installed: bool,
    pub port: u16,
    pub reachable: bool,
    pub http_status: Option<u16>,
    pub latency_ms: Option<u64>,
    pub pid: Option<u32>,
    pub uptime_secs: Option<u64>,
    pub mem_bytes: Option<u64>,
    pub cpu_percent: Option<f32>,
    /// All node processes whose command line mentions openclaw.
    pub process_count: u32,
    // Everything below is only populated when /health reports it; the gateway
    // is free to omit any of these and the card must say "not measured".
    pub requests_per_min: Option<f64>,
    pub active_requests: Option<u64>,
    pub queued_requests: Option<u64>,
    pub error_rate: Option<f64>,
    pub p50_ms: Option<f64>,
    pub p95_ms: Option<f64>,
    pub p99_ms: Option<f64>,
    pub connected_clients: Option<u64>,
    pub last_error: Option<String>,
    pub version: Option<String>,
}

// ---------- hardware suite ----------

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GpuInfo {
    pub index: u32,
    pub name: String,
    pub temp_c: Option<f32>,
    pub util_percent: Option<f32>,
    pub mem_used_mb: Option<u64>,
    pub mem_total_mb: Option<u64>,
    pub power_w: Option<f32>,
    pub power_limit_w: Option<f32>,
    pub clock_mhz: Option<u64>,
    pub fan_percent: Option<f32>,
    pub pstate: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GpuProcess {
    pub pid: u32,
    pub name: String,
    pub mem_mb: Option<u64>,
    /// Present when the process was found in the live table — enables the
    /// identity-verified kill.
    pub start_time_unix: Option<u64>,
    pub killable: bool,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct GpuStatus {
    pub available: bool,
    pub error: Option<String>,
    pub driver: Option<String>,
    pub gpus: Vec<GpuInfo>,
    pub processes: Vec<GpuProcess>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ThermalsStatus {
    /// "lhm" (full LibreHardwareMonitor) | "wmi" (basic zone) | "none".
    pub tier: String,
    pub cpu_package_c: Option<f32>,
    pub cpu_max_core_c: Option<f32>,
    pub zone_c: Option<f32>,
    pub fans_rpm: Vec<u32>,
    pub sensor_count: u32,
    /// None when no throttling sensor exists — not the same as "not throttling".
    pub throttling: Option<bool>,
}

/// Outcome of the one-click thermals setup (winget install + config seed +
/// elevated launch of LibreHardwareMonitor).
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ThermalsSetupResult {
    /// The web server is answering (either it already was, or setup worked).
    pub live: bool,
    pub installed_now: bool,
    pub config_seeded: bool,
    pub launched: bool,
    pub task_registered: bool,
    pub message: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DiskVolume {
    pub mount: String,
    pub label: String,
    pub total: u64,
    pub available: u64,
    pub fs: Option<String>,
    /// "ssd" | "hdd" | "unknown".
    pub kind: String,
    pub removable: bool,
    /// SMART predict-failure state; None when the driver doesn't expose it.
    pub smart_ok: Option<bool>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct DisksStatus {
    pub volumes: Vec<DiskVolume>,
    pub read_bps: u64,
    pub write_bps: u64,
    pub latency_ms: Option<f32>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct NetQuality {
    /// "icmp" | "tcp" | "none".
    pub mode: String,
    pub latency_ms: Option<f32>,
    pub avg_ms: Option<f32>,
    pub jitter_ms: Option<f32>,
    pub loss_percent: f32,
    /// Recent samples, oldest first (-1 marks a lost probe).
    pub samples: Vec<f32>,
    pub wifi_ssid: Option<String>,
    pub wifi_signal: Option<u32>,
    pub link_mbps: Option<f32>,
    /// DNS resolution time; None when not measured this cycle.
    pub dns_ms: Option<f32>,
    pub interface_name: Option<String>,
    pub link_type: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PortListener {
    pub port: u16,
    pub pid: u32,
    pub process: String,
    /// "tcp" | "udp".
    pub proto: String,
    /// "v4" | "v6".
    pub family: String,
    pub bind_addr: String,
    /// "loopback" | "lan" | "public" — how far this socket is reachable.
    pub exposure: String,
    pub first_seen_unix: i64,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct PortsStatus {
    pub listeners: Vec<PortListener>,
    pub error: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WslDistro {
    pub name: String,
    pub state: String,
    pub version: String,
    pub is_default: bool,
    /// Size of the distro's ext4.vhdx, from its registry BasePath.
    pub disk_bytes: Option<u64>,
    pub docker_integration: bool,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct WslStatus {
    pub installed: bool,
    pub distros: Vec<WslDistro>,
    /// Shared across all running distros — WSL2 runs one utility VM.
    pub vmmem_bytes: Option<u64>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct BatteryInfo {
    pub present: bool,
    pub percent: Option<u32>,
    pub on_ac: Option<bool>,
    pub runtime_min: Option<u32>,
    pub power_plan: Option<String>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct UptimeStatus {
    pub boot_unix: u64,
    pub uptime_secs: u64,
    pub reboot_pending: bool,
    pub reasons: Vec<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OllamaModel {
    pub name: String,
    pub vram_bytes: Option<u64>,
    pub expires_at: Option<String>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct OllamaStatus {
    pub reachable: bool,
    pub loaded: Vec<OllamaModel>,
    pub installed_count: u32,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WingetUpdate {
    pub name: String,
    pub id: String,
    pub current: String,
    pub available: String,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct WingetStatus {
    pub installed: bool,
    pub updates: Vec<WingetUpdate>,
    pub error: Option<String>,
    pub checked_unix: i64,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SpeedtestResult {
    pub down_mbps: f64,
    pub up_mbps: f64,
    pub latency_ms: f64,
    pub jitter_ms: Option<f64>,
    pub at_unix: i64,
    pub provider: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct McpServer {
    pub name: String,
    /// "claude-desktop" | "claude-code" | "codex".
    pub source: String,
    pub command: String,
    pub running: bool,
    pub pid: Option<u32>,
    pub cwd: Option<String>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    pub servers: Vec<McpServer>,
}

/// Result of an explicit, user-triggered MCP handshake. Never polled: it
/// spawns the configured server, so it only runs when someone asks.
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct McpHealth {
    pub name: String,
    pub ok: bool,
    pub latency_ms: Option<u64>,
    pub server_name: Option<String>,
    pub server_version: Option<String>,
    pub protocol_version: Option<String>,
    pub tools: Vec<String>,
    pub error: Option<String>,
}

// ---------- GitHub ----------

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RepoRelease {
    pub tag: String,
    pub published_at: Option<String>,
    pub url: String,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct RepoStatus {
    pub repo: String,
    pub ok: bool,
    pub error: Option<String>,
    pub stars: Option<u64>,
    pub open_issues: Option<u64>,
    pub open_prs: Option<u64>,
    /// "success" | "failure" | "pending" | "none" (no runs) — latest workflow run.
    pub ci_status: Option<String>,
    pub default_branch: Option<String>,
    pub release: Option<RepoRelease>,
    pub pushed_at: Option<String>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct GithubPayload {
    pub authenticated: bool,
    /// The gh-CLI-authenticated user whose own repos are shown.
    pub login: Option<String>,
    pub repos: Vec<RepoStatus>,
    /// Set when the whole fetch failed (no token, rate limit, offline).
    pub error: Option<String>,
}

// ---------- local git working copies ----------

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct LocalRepo {
    pub path: String,
    pub name: String,
    pub branch: Option<String>,
    pub dirty_count: u32,
    pub ahead: u32,
    pub behind: u32,
    pub upstream: Option<String>,
    pub last_commit_subject: Option<String>,
    pub last_commit_unix: Option<i64>,
    /// "owner/name" parsed from the origin remote, to join with the GitHub card.
    pub remote_slug: Option<String>,
    /// Test command declared by the project, for the explicit run action.
    pub test_command: Option<String>,
    pub error: Option<String>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct LocalReposStatus {
    pub repos: Vec<LocalRepo>,
    pub roots: Vec<String>,
    pub git_available: bool,
}

// ---------- HUD self-diagnostics ----------

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SelfDiagnostics {
    pub pid: u32,
    pub cpu_percent: f32,
    pub mem_bytes: u64,
    pub thread_count: Option<u32>,
    pub uptime_secs: u64,
    pub store_bytes: Option<u64>,
    pub store_path: Option<String>,
}

// ---------- operator actions ----------

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ActionResult {
    pub ok: bool,
    /// Machine-readable outcome: "ok", "denied", "not_found", "invalid", …
    pub code: String,
    pub message: String,
    /// Command output excerpt — truncated and secret-masked before it leaves.
    pub detail: Option<String>,
}

impl ActionResult {
    pub fn ok(message: impl Into<String>) -> Self {
        Self { ok: true, code: "ok".into(), message: message.into(), detail: None }
    }
    pub fn fail(code: &str, message: impl Into<String>) -> Self {
        Self { ok: false, code: code.into(), message: message.into(), detail: None }
    }
    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    pub id: String,
    pub at_unix: i64,
    pub action: String,
    pub target: String,
    pub ok: bool,
    pub code: String,
    pub message: String,
}

// ---------- custom cards ----------

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CustomCardSpec {
    pub id: String,
    /// "command" | "http" | "file".
    pub kind: String,
    pub target: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub timeout_ms: u64,
    pub max_bytes: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CustomCardMetric {
    pub label: String,
    pub value: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unit: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CustomCardPayload {
    pub schema_version: u32,
    pub status: String,
    pub title: String,
    pub metrics: Vec<CustomCardMetric>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CustomCardResult {
    pub id: String,
    pub ok: bool,
    pub payload: Option<CustomCardPayload>,
    pub error: Option<String>,
    pub duration_ms: u64,
    pub at_unix: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payload_serializes_to_contract_field_names() {
        let payload = ProcessesPayload {
            scanned_at: "2026-07-20T00:00:00Z".into(),
            processes: vec![ProcInfo {
                pid: 1,
                ppid: None,
                name: "node.exe".into(),
                label: None,
                cmd_summary: String::new(),
                cwd: None,
                start_time_unix: 0,
                mem_bytes: 0,
                cpu_percent: 0.0,
                killable: true,
                child_pids: vec![],
                parent_app: None,
                orphaned: false,
                idle_secs: 0,
            }],
        };
        let v = serde_json::to_value(&payload).unwrap();
        assert!(v.get("scannedAt").is_some());
        let p = &v["processes"][0];
        for key in [
            "pid", "ppid", "name", "label", "cmdSummary", "cwd", "startTimeUnix",
            "memBytes", "cpuPercent", "killable", "childPids", "parentApp",
            "orphaned", "idleSecs",
        ] {
            assert!(p.get(key).is_some(), "missing contract key {key}");
        }
    }

    #[test]
    fn usage_serializes_camel_case() {
        let u = ClaudeUsage::default();
        let v = serde_json::to_value(&u).unwrap();
        for key in [
            "available", "todayTokens", "todayCostUsd", "weekCostUsd",
            "blockTokensTotal", "blockEndsUnix", "modelsToday", "hourly",
            "projectsToday", "windowsLive", "providerError",
        ] {
            assert!(v.get(key).is_some(), "missing usage key {key}");
        }
    }

    #[test]
    fn action_result_helpers_set_code_and_ok() {
        let good = ActionResult::ok("stopped").with_detail("exit 0");
        assert!(good.ok && good.code == "ok" && good.detail.is_some());
        let bad = ActionResult::fail("denied", "no permission");
        assert!(!bad.ok && bad.code == "denied");
        let v = serde_json::to_value(&bad).unwrap();
        assert!(v.get("ok").is_some() && v.get("code").is_some());
    }
}
