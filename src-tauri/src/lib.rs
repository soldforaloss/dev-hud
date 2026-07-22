mod actions;
mod alerts;
mod cli;
mod custom_cards;
mod diagnostics;
mod docker;
mod fsutil;
mod git;
mod github;
mod hardware;
mod health;
mod kill;
mod mcp_health;
mod openclaw;
mod scanner;
mod tailscale;
mod types;
mod usage_claude;
mod usage_codex;
mod wmi_bridge;

use std::sync::{Arc, Mutex};

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow, WindowEvent};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_store::StoreExt;

use health::{HealthMonitor, HealthShared};
use scanner::Scanner;
use types::{
    ActionResult, AuditEntry, BatteryInfo, CustomCardResult, CustomCardSpec,
    LocalReposStatus, McpHealth, SelfDiagnostics, TopProcess, ClaudeUsage, CodexUsage, DisksStatus, DockerStatus, GithubPayload,
    GpuStatus, KillAllSummary, KillResult, KillTarget, McpStatus, NetQuality,
    OllamaStatus, OpenClawStatus, PortsStatus, ProcessesPayload, SpeedtestResult,
    SystemHealth, TailscaleStatus, ThermalsSetupResult, ThermalsStatus, UptimeStatus,
    WingetStatus, WslStatus,
};
use usage_claude::ClaudeShared;
use usage_codex::CodexShared;

pub const LAYERING_CHANGED: &str = "layering:changed";
pub const LOCK_CHANGED: &str = "lock:changed";
pub const REFRESH_ALL: &str = "hud:refresh";
const STORE_FILE: &str = "settings.json";

pub struct ScannerState(pub Arc<Mutex<Scanner>>);
pub struct ClaudeState(pub ClaudeShared);
pub struct CodexState(pub CodexShared);
pub struct HealthState(pub HealthShared);
pub struct Http(pub reqwest::Client);

/// Public-IP cache: (when fetched, value). Refreshed at most every 15 min.
pub struct PubIp(pub Mutex<Option<(std::time::Instant, Option<String>)>>);

pub struct NetqState(pub Arc<hardware::netq::NetqShared>);
pub struct AuditState(pub Arc<actions::AuditLog>);
/// A tiny System used only to measure the HUD's own process — kept apart from
/// the Scanner so self-measurement never disturbs the shared CPU deltas.
pub struct DiagState(pub Mutex<sysinfo::System>);
/// First-seen timestamps for listening sockets, so the ports card can say how
/// long something has been up.
pub struct PortsSeenState(pub Arc<hardware::ports::PortsSeen>);
pub struct Alerts(pub alerts::AlertGate);

/// The active layering mode; the focus-lost handler reads it to keep
/// pinned-to-desktop windows truly at the bottom (Windows raises any window
/// on activation, which would otherwise let the widget float mid-stack).
pub struct CurrentLayering(pub Mutex<String>);

// ---------- commands ----------

#[tauri::command]
async fn get_processes(scanner: State<'_, ScannerState>) -> Result<ProcessesPayload, String> {
    let sc = scanner.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut sc = sc.lock().map_err(|e| e.to_string())?;
        Ok(sc.snapshot())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Async so the up-to-1.7 s terminate wait never blocks the main event loop.
#[tauri::command]
async fn kill_process(
    scanner: State<'_, ScannerState>,
    pid: u32,
    start_time_unix: u64,
    kill_tree: bool,
) -> Result<KillResult, String> {
    actions::validate_pid(pid)?;
    let sc = scanner.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut sc = sc.lock().map_err(|e| e.to_string())?;
        Ok(kill::kill_process_impl(
            sc.system_mut(),
            pid,
            start_time_unix,
            kill_tree,
        ))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn kill_all_processes(
    scanner: State<'_, ScannerState>,
    targets: Vec<KillTarget>,
) -> Result<KillAllSummary, String> {
    for t in &targets {
        actions::validate_pid(t.pid)?;
    }
    let sc = scanner.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut sc = sc.lock().map_err(|e| e.to_string())?;
        Ok(kill::kill_all_impl(sc.system_mut(), &targets))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn get_claude_usage(
    claude: State<'_, ClaudeState>,
    http: State<'_, Http>,
) -> Result<ClaudeUsage, String> {
    let cache = claude.0.clone();
    let mut usage =
        tauri::async_runtime::spawn_blocking(move || usage_claude::compute_local(&cache))
            .await
            .map_err(|e| e.to_string())?;
    let (plan, windows) = usage_claude::fetch_oauth_windows(&http.0).await;
    usage.plan = plan;
    usage.windows = windows;
    Ok(usage)
}

#[tauri::command]
async fn get_codex_usage(codex: State<'_, CodexState>) -> Result<CodexUsage, String> {
    let cache = codex.0.clone();
    tauri::async_runtime::spawn_blocking(move || usage_codex::compute(&cache))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_openclaw_status(
    scanner: State<'_, ScannerState>,
    http: State<'_, Http>,
) -> Result<OpenClawStatus, String> {
    Ok(openclaw::status(&http.0, &scanner.0).await)
}

#[tauri::command]
async fn get_github_status(http: State<'_, Http>) -> Result<GithubPayload, String> {
    Ok(github::fetch(&http.0).await)
}

#[tauri::command]
async fn get_system_health(
    health: State<'_, HealthState>,
    scanner: State<'_, ScannerState>,
    http: State<'_, Http>,
    pub_ip: State<'_, PubIp>,
) -> Result<SystemHealth, String> {
    let monitor = health.0.clone();
    let mut result: SystemHealth = tauri::async_runtime::spawn_blocking(move || {
        let mut monitor = monitor.lock().map_err(|e| e.to_string())?;
        Ok::<_, String>(monitor.poll())
    })
    .await
    .map_err(|e| e.to_string())??;

    // Public IP, refreshed at most every 15 minutes (kept on failure too, so
    // an offline stretch doesn't hammer the endpoint).
    let cached = pub_ip
        .0
        .lock()
        .ok()
        .and_then(|c| c.clone())
        .filter(|(at, _)| at.elapsed().as_secs() < 900);
    result.public_ip = match cached {
        Some((_, ip)) => ip,
        None => {
            let fetched = http
                .0
                .get("https://api.ipify.org")
                .timeout(std::time::Duration::from_secs(4))
                .send()
                .await
                .ok()
                .filter(|r| r.status().is_success());
            let ip = match fetched {
                Some(resp) => resp.text().await.ok().map(|t| t.trim().to_string()),
                None => None,
            };
            if let Ok(mut c) = pub_ip.0.lock() {
                *c = Some((std::time::Instant::now(), ip.clone()));
            }
            ip
        }
    };
    // Top consumers come from the scanner's already-refreshed table: a second
    // full process refresh on this 3-second poll would double the idle cost of
    // the busiest collector in the app.
    let sc = scanner.0.clone();
    result.top_processes = tauri::async_runtime::spawn_blocking(move || {
        let Ok(sc) = sc.lock() else {
            return Vec::new();
        };
        let mut rows: Vec<TopProcess> = sc
            .system()
            .processes()
            .values()
            .map(|p| TopProcess {
                pid: p.pid().as_u32(),
                name: p.name().to_string_lossy().into_owned(),
                cpu_percent: p.cpu_usage(),
                mem_bytes: p.memory(),
            })
            .collect();
        rows.sort_by(|a, b| b.mem_bytes.cmp(&a.mem_bytes));
        rows.truncate(8);
        rows
    })
    .await
    .unwrap_or_default();
    result.queue_length = health::queue_length();
    Ok(result)
}

// ---------- local repositories ----------

#[tauri::command]
async fn get_local_repos(
    roots: Vec<String>,
    extra_paths: Vec<String>,
) -> Result<LocalReposStatus, String> {
    tauri::async_runtime::spawn_blocking(move || git::scan(&roots, &extra_paths))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_self_diagnostics(
    app: AppHandle,
    diag: State<'_, DiagState>,
) -> Result<SelfDiagnostics, String> {
    let store_path = app
        .path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join(STORE_FILE));
    let mut sys = diag.0.lock().map_err(|e| e.to_string())?;
    Ok(diagnostics::self_diagnostics(&mut sys, store_path))
}

// ---------- operator actions ----------
//
// Every one of these is explicit, argument-validated, time-bounded and
// audited. The frontend confirms destructive ones before it calls; the
// backend still validates as if it hadn't.

/// Run an action on a blocking thread and record the outcome.
async fn audited<F>(
    audit: &AuditState,
    action: &str,
    target: String,
    run: F,
) -> Result<ActionResult, String>
where
    F: FnOnce() -> ActionResult + Send + 'static,
{
    let result = tauri::async_runtime::spawn_blocking(run)
        .await
        .map_err(|e| e.to_string())?;
    audit.0.record(action, &target, &result);
    Ok(result)
}

#[tauri::command]
async fn docker_action(
    audit: State<'_, AuditState>,
    verb: String,
    name: String,
) -> Result<ActionResult, String> {
    let (v, n) = (verb.clone(), name.clone());
    audited(&audit, &format!("docker {verb}"), name, move || {
        actions::docker_container(&v, &n)
    })
    .await
}

#[tauri::command]
async fn docker_logs_action(
    audit: State<'_, AuditState>,
    name: String,
    lines: u32,
) -> Result<ActionResult, String> {
    let n = name.clone();
    audited(&audit, "docker logs", name, move || {
        actions::docker_logs(&n, lines)
    })
    .await
}

#[tauri::command]
async fn wsl_start_action(
    audit: State<'_, AuditState>,
    name: String,
) -> Result<ActionResult, String> {
    let n = name.clone();
    audited(&audit, "wsl start", name, move || actions::wsl_start(&n)).await
}

#[tauri::command]
async fn wsl_terminate_action(
    audit: State<'_, AuditState>,
    name: String,
) -> Result<ActionResult, String> {
    let n = name.clone();
    audited(&audit, "wsl terminate", name, move || {
        actions::wsl_terminate(&n)
    })
    .await
}

#[tauri::command]
async fn open_path_action(
    audit: State<'_, AuditState>,
    path: String,
) -> Result<ActionResult, String> {
    let p = path.clone();
    audited(&audit, "open folder", path, move || actions::open_path(&p)).await
}

#[tauri::command]
async fn open_terminal_action(
    audit: State<'_, AuditState>,
    dir: String,
) -> Result<ActionResult, String> {
    let d = dir.clone();
    audited(&audit, "open terminal", dir, move || {
        actions::open_terminal(&d)
    })
    .await
}

#[tauri::command]
async fn git_fetch_action(
    audit: State<'_, AuditState>,
    dir: String,
) -> Result<ActionResult, String> {
    let d = dir.clone();
    audited(&audit, "git fetch", dir, move || actions::git_fetch(&d)).await
}

#[tauri::command]
async fn git_status_action(
    audit: State<'_, AuditState>,
    dir: String,
) -> Result<ActionResult, String> {
    let d = dir.clone();
    audited(&audit, "git status", dir, move || {
        actions::git_status_detail(&d)
    })
    .await
}

#[tauri::command]
async fn run_repo_tests_action(
    audit: State<'_, AuditState>,
    dir: String,
    command: String,
) -> Result<ActionResult, String> {
    let (d, c) = (dir.clone(), command);
    audited(&audit, "run tests", dir, move || {
        actions::run_repo_tests(&d, &c)
    })
    .await
}

/// MCP health check. Explicit only: it starts the configured server, so it
/// must never be reachable from a poll.
#[tauri::command]
async fn mcp_health_check(
    scanner: State<'_, ScannerState>,
    audit: State<'_, AuditState>,
    name: String,
) -> Result<McpHealth, String> {
    let sc = scanner.0.clone();
    let target = name.clone();
    let health = tauri::async_runtime::spawn_blocking(move || {
        // Re-read the config rather than trusting a name from the frontend:
        // the command that runs is the one on disk, not one that was passed in.
        let configured = hardware::mcp::configured_commands();
        let Some((command, args)) = configured.get(&target).cloned() else {
            return McpHealth {
                name: target,
                ok: false,
                error: Some("no MCP server with that name is configured".into()),
                ..Default::default()
            };
        };
        let _ = &sc;
        let mut result = mcp_health::check(&command, &args, std::time::Duration::from_secs(8));
        result.name = target;
        result
    })
    .await
    .map_err(|e| e.to_string())?;
    let outcome = if health.ok {
        ActionResult::ok(format!("{} tool(s) reported", health.tools.len()))
    } else {
        ActionResult::fail("failed", health.error.clone().unwrap_or_default())
    };
    audit.0.record("mcp health check", &name, &outcome);
    Ok(health)
}

#[tauri::command]
async fn run_custom_card(spec: CustomCardSpec) -> Result<CustomCardResult, String> {
    tauri::async_runtime::spawn_blocking(move || custom_cards::run_blocking(&spec))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_audit_log(audit: State<'_, AuditState>) -> Vec<AuditEntry> {
    audit.0.entries()
}

#[tauri::command]
async fn get_tailscale_status() -> Result<TailscaleStatus, String> {
    tauri::async_runtime::spawn_blocking(tailscale::status)
        .await
        .map_err(|e| e.to_string())
}

// ---------- hardware suite commands ----------

#[tauri::command]
async fn get_gpu_status(scanner: State<'_, ScannerState>) -> Result<GpuStatus, String> {
    let sc = scanner.0.clone();
    tauri::async_runtime::spawn_blocking(move || hardware::gpu::status(&sc))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_thermals(http: State<'_, Http>, lhm_port: u16) -> Result<ThermalsStatus, String> {
    Ok(hardware::thermals::status(&http.0, lhm_port).await)
}

/// One-click thermals onboarding — the user's button click is the explicit
/// consent for the winget install, the UAC prompt, and the logon task.
#[tauri::command]
async fn setup_thermals(
    scanner: State<'_, ScannerState>,
    lhm_port: u16,
) -> Result<ThermalsSetupResult, String> {
    let sc = scanner.0.clone();
    tauri::async_runtime::spawn_blocking(move || hardware::lhm_setup::setup(&sc, lhm_port))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_disks() -> Result<DisksStatus, String> {
    tauri::async_runtime::spawn_blocking(hardware::disks::status)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_net_quality(
    netq: State<'_, NetqState>,
    host: String,
) -> Result<NetQuality, String> {
    let state = netq.0.clone();
    let host = if host.trim().is_empty() {
        "1.1.1.1".to_string()
    } else {
        host
    };
    tauri::async_runtime::spawn_blocking(move || hardware::netq::poll(&state, &host))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_ports(seen: State<'_, PortsSeenState>) -> Result<PortsStatus, String> {
    let seen = seen.0.clone();
    tauri::async_runtime::spawn_blocking(move || hardware::ports::status(&seen))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_wsl_status(scanner: State<'_, ScannerState>) -> Result<WslStatus, String> {
    let sc = scanner.0.clone();
    tauri::async_runtime::spawn_blocking(move || hardware::wsl::status(&sc))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn wsl_terminate(name: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || hardware::wsl::terminate(&name))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn wsl_shutdown_all() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(hardware::wsl::shutdown_all)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn get_battery() -> Result<BatteryInfo, String> {
    tauri::async_runtime::spawn_blocking(hardware::battery::status)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_uptime() -> Result<UptimeStatus, String> {
    tauri::async_runtime::spawn_blocking(hardware::uptime::status)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_ollama_status(http: State<'_, Http>, port: u16) -> Result<OllamaStatus, String> {
    Ok(hardware::ollama::status(&http.0, port).await)
}

#[tauri::command]
async fn get_winget_status() -> Result<WingetStatus, String> {
    tauri::async_runtime::spawn_blocking(hardware::winget::status)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn run_speedtest(http: State<'_, Http>) -> Result<SpeedtestResult, String> {
    hardware::speedtest::run(&http.0).await
}

#[tauri::command]
async fn get_mcp_status(scanner: State<'_, ScannerState>) -> Result<McpStatus, String> {
    let sc = scanner.0.clone();
    tauri::async_runtime::spawn_blocking(move || hardware::mcp::status(&sc))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn send_alert(
    app: AppHandle,
    gate: State<'_, Alerts>,
    key: String,
    title: String,
    body: String,
) -> Result<bool, String> {
    use tauri_plugin_notification::NotificationExt;
    if !gate.0.allow(&key) {
        return Ok(false);
    }
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
async fn get_docker_status() -> Result<DockerStatus, String> {
    tauri::async_runtime::spawn_blocking(docker::status)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn set_layering(window: WebviewWindow, mode: String) {
    set_layering_mode(window.app_handle(), &mode);
}

#[tauri::command]
fn set_locked(app: AppHandle, locked: bool) {
    sync_tray_lock(&app, locked);
}

#[tauri::command]
fn set_background(window: WebviewWindow, mode: String, opacity: u8) {
    apply_background(&window, &mode, opacity);
}

#[tauri::command]
fn open_local_port(app: AppHandle, port: u32) -> Result<(), String> {
    let port = actions::validate_port(port)?;
    app.opener()
        .open_url(format!("http://localhost:{port}"), None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("only http(s) urls can be opened".into());
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

// ---------- window behavior ----------

/// Pin the window to the top edge of the primary monitor, horizontally
/// centered. Runs at launch (and shortly after, in case the window-state
/// plugin restores the persisted size a beat later and shifts the width).
fn position_top_center(window: &WebviewWindow) {
    let monitor = window
        .primary_monitor()
        .ok()
        .flatten()
        .or_else(|| window.current_monitor().ok().flatten());
    let Some(monitor) = monitor else { return };
    let Ok(size) = window.outer_size() else { return };
    let x = monitor.position().x
        + ((monitor.size().width as i32 - size.width as i32) / 2).max(0);
    let y = monitor.position().y;
    let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
}

/// Apply the window backdrop.
///
/// In acrylic mode DWM owns the tint *entirely* — the web view stays fully
/// transparent. Painting a second translucent layer in the DOM on top of the
/// native tint is what produced the "hovering darkens the scene" artifact:
/// every partial repaint re-composited that layer over the same blurred
/// backdrop, so the repainted rectangle came out darker than its surroundings.
/// One translucent layer, owned by one compositor.
fn apply_background(window: &WebviewWindow, mode: &str, opacity: u8) {
    #[cfg(windows)]
    {
        match mode {
            "acrylic" => {
                let alpha = ((opacity as f32 / 100.0) * 255.0).clamp(20.0, 255.0) as u8;
                let _ = window_vibrancy::apply_acrylic(window, Some((10, 12, 18, alpha)));
            }
            _ => {
                let _ = window_vibrancy::clear_acrylic(window);
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (window, mode, opacity);
    }
}

/// Single entry point for layering changes: remembers the mode, applies the
/// window flags, and syncs the tray checkmarks.
fn set_layering_mode(app: &AppHandle, mode: &str) {
    if let Some(state) = app.try_state::<CurrentLayering>() {
        if let Ok(mut current) = state.0.lock() {
            *current = mode.to_string();
        }
    }
    if let Some(window) = app.get_webview_window("main") {
        apply_layering(&window, mode);
    }
    sync_tray_checks(app, mode);
}

fn apply_layering(window: &WebviewWindow, mode: &str) {
    match mode {
        "top" => {
            let _ = window.set_always_on_bottom(false);
            let _ = window.set_always_on_top(true);
        }
        "normal" => {
            let _ = window.set_always_on_bottom(false);
            let _ = window.set_always_on_top(false);
        }
        // Default: pinned to desktop.
        _ => {
            let _ = window.set_always_on_top(false);
            let _ = window.set_always_on_bottom(true);
        }
    }
}

struct TrayItems {
    desktop: CheckMenuItem<tauri::Wry>,
    normal: CheckMenuItem<tauri::Wry>,
    top: CheckMenuItem<tauri::Wry>,
    lock: CheckMenuItem<tauri::Wry>,
}

fn sync_tray_checks(app: &AppHandle, mode: &str) {
    if let Some(items) = app.try_state::<Mutex<TrayItems>>() {
        if let Ok(items) = items.lock() {
            let _ = items.desktop.set_checked(mode == "desktop");
            let _ = items.normal.set_checked(mode == "normal");
            let _ = items.top.set_checked(mode == "top");
        }
    }
}

fn sync_tray_lock(app: &AppHandle, locked: bool) {
    if let Some(items) = app.try_state::<Mutex<TrayItems>>() {
        if let Ok(items) = items.lock() {
            let _ = items.lock.set_checked(locked);
        }
    }
}

fn toggle_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(true) {
            let _ = window.hide();
        } else {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

struct StoredSettings {
    layering: String,
    locked: bool,
    autostart: bool,
    background: String,
    launch_mode: String,
    bg_opacity: u8,
}

impl Default for StoredSettings {
    fn default() -> Self {
        Self {
            layering: "desktop".into(),
            locked: false,
            autostart: true,
            background: "acrylic".into(),
            launch_mode: "remember".into(),
            bg_opacity: 55,
        }
    }
}

fn load_stored_settings(app: &AppHandle) -> StoredSettings {
    let mut out = StoredSettings::default();
    let Ok(store) = app.store(STORE_FILE) else {
        return out;
    };
    let Some(value) = store.get("settings") else {
        return out;
    };
    if let Some(mode) = value.get("layering").and_then(|v| v.as_str()) {
        out.layering = mode.to_string();
    }
    if let Some(locked) = value.get("locked").and_then(|v| v.as_bool()) {
        out.locked = locked;
    }
    if let Some(auto) = value.get("autostart").and_then(|v| v.as_bool()) {
        out.autostart = auto;
    }
    if let Some(bg) = value.get("background").and_then(|v| v.as_str()) {
        out.background = bg.to_string();
    }
    if let Some(mode) = value.get("launchMode").and_then(|v| v.as_str()) {
        out.launch_mode = mode.to_string();
    }
    if let Some(o) = value.get("bgOpacity").and_then(|v| v.as_u64()) {
        out.bg_opacity = o.clamp(10, 100) as u8;
    }
    out
}

/// Debounced window-position persistence (separate store key so the
/// frontend's wholesale "settings" writes never clobber it).
pub struct WindowPos {
    pub latest: Mutex<Option<(i32, i32)>>,
    pub flush_scheduled: std::sync::atomic::AtomicBool,
}

fn restore_or_center(app: &AppHandle, window: &WebviewWindow, stored: &StoredSettings) {
    let saved = app
        .store(STORE_FILE)
        .ok()
        .and_then(|s| s.get("windowPos"))
        .and_then(|v| {
            let arr = v.as_array()?;
            Some((arr.first()?.as_i64()? as i32, arr.get(1)?.as_i64()? as i32))
        });
    if stored.launch_mode == "remember" {
        if let Some((x, y)) = saved {
            // Only restore a spot that's still on some monitor.
            let on_screen = window
                .available_monitors()
                .map(|monitors| {
                    monitors.iter().any(|m| {
                        let (mx, my) = (m.position().x, m.position().y);
                        let (mw, mh) = (m.size().width as i32, m.size().height as i32);
                        x >= mx - 50 && x < mx + mw - 50 && y >= my - 20 && y < my + mh - 80
                    })
                })
                .unwrap_or(false);
            if on_screen {
                let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
                return;
            }
        }
    }
    position_top_center(window);
    // Re-center once the restored size has settled (center mode only).
    let delayed = window.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(400));
        position_top_center(&delayed);
    });
}

fn build_tray(app: &tauri::App, stored: &StoredSettings) -> tauri::Result<()> {
    let show_hide = MenuItem::with_id(app, "show-hide", "Show / Hide", true, None::<&str>)?;
    let refresh = MenuItem::with_id(app, "refresh", "Refresh now", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let layer_desktop = CheckMenuItem::with_id(
        app,
        "layer-desktop",
        "Pinned to desktop",
        true,
        stored.layering == "desktop",
        None::<&str>,
    )?;
    let layer_normal = CheckMenuItem::with_id(
        app,
        "layer-normal",
        "Normal window",
        true,
        stored.layering == "normal",
        None::<&str>,
    )?;
    let layer_top = CheckMenuItem::with_id(
        app,
        "layer-top",
        "Always on top",
        true,
        stored.layering == "top",
        None::<&str>,
    )?;
    let lock = CheckMenuItem::with_id(
        app,
        "lock-position",
        "Lock position",
        true,
        stored.locked,
        None::<&str>,
    )?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &show_hide,
            &refresh,
            &sep1,
            &layer_desktop,
            &layer_normal,
            &layer_top,
            &lock,
            &sep2,
            &quit,
        ],
    )?;

    app.manage(Mutex::new(TrayItems {
        desktop: layer_desktop,
        normal: layer_normal,
        top: layer_top,
        lock,
    }));

    TrayIconBuilder::with_id("main-tray")
        .icon(app.default_window_icon().expect("bundled icon").clone())
        .tooltip("Dev HUD")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "show-hide" => toggle_main_window(app),
            "refresh" => {
                let _ = app.emit(REFRESH_ALL, ());
            }
            "quit" => app.exit(0),
            "lock-position" => {
                let locked = app
                    .try_state::<Mutex<TrayItems>>()
                    .and_then(|items| {
                        items.lock().ok().and_then(|i| i.lock.is_checked().ok())
                    })
                    .unwrap_or(false);
                // Let the UI persist the setting and update the drag region.
                let _ = app.emit(LOCK_CHANGED, locked);
            }
            id @ ("layer-desktop" | "layer-normal" | "layer-top") => {
                let mode = id.trim_start_matches("layer-");
                set_layering_mode(app, mode);
                let _ = app.emit(LAYERING_CHANGED, mode.to_string());
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_main_window(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let scanner = Arc::new(Mutex::new(Scanner::new()));
    let http = reqwest::Client::builder()
        .user_agent("dev-hud")
        .connect_timeout(std::time::Duration::from_secs(3))
        .build()
        .expect("reqwest client");

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // Second launch (autostart + manual start): surface the running one.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_store::Builder::new().build())
        // Size persists; position does NOT — every launch pins top-center.
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all()
                        & !tauri_plugin_window_state::StateFlags::POSITION,
                )
                .build(),
        )
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .manage(ScannerState(scanner.clone()))
        .manage(ClaudeState(ClaudeShared::default()))
        .manage(CodexState(CodexShared::default()))
        .manage(HealthState(Arc::new(Mutex::new(HealthMonitor::new()))))
        .manage(PubIp(Mutex::new(None)))
        .manage(NetqState(Arc::new(hardware::netq::NetqShared::default())))
        .manage(PortsSeenState(Arc::new(
            hardware::ports::PortsSeen::default(),
        )))
        .manage(AuditState(Arc::new(actions::AuditLog::default())))
        .manage(DiagState(Mutex::new(sysinfo::System::new())))
        .manage(Alerts(alerts::AlertGate::default()))
        .manage(Http(http))
        .manage(CurrentLayering(Mutex::new("desktop".into())))
        .manage(WindowPos {
            latest: Mutex::new(None),
            flush_scheduled: std::sync::atomic::AtomicBool::new(false),
        })
        .setup(move |app| {
            let stored = load_stored_settings(app.handle());

            // Default-on autostart: enable on first run, respect the setting after.
            let autolaunch = app.autolaunch();
            if stored.autostart {
                let _ = autolaunch.enable();
            } else {
                let _ = autolaunch.disable();
            }

            build_tray(app, &stored)?;
            set_layering_mode(app.handle(), &stored.layering);
            if let Some(window) = app.get_webview_window("main") {
                apply_background(&window, &stored.background, stored.bg_opacity);
                restore_or_center(app.handle(), &window, &stored);
            }
            Ok(())
        })
        .on_window_event(|window, event| match event {
            // Remember where the user drags the window: record every move,
            // flush to the store 800 ms after the last one.
            WindowEvent::Moved(pos) => {
                if window.label() != "main" {
                    return;
                }
                let app = window.app_handle();
                if let Some(state) = app.try_state::<WindowPos>() {
                    if let Ok(mut latest) = state.latest.lock() {
                        *latest = Some((pos.x, pos.y));
                    }
                    use std::sync::atomic::Ordering;
                    if !state.flush_scheduled.swap(true, Ordering::SeqCst) {
                        let app = app.clone();
                        std::thread::spawn(move || {
                            std::thread::sleep(std::time::Duration::from_millis(800));
                            if let Some(state) = app.try_state::<WindowPos>() {
                                state.flush_scheduled.store(false, Ordering::SeqCst);
                                let latest = state.latest.lock().ok().and_then(|l| *l);
                                if let (Some((x, y)), Ok(store)) = (latest, app.store(STORE_FILE)) {
                                    store.set("windowPos", serde_json::json!([x, y]));
                                    let _ = store.save();
                                }
                            }
                        });
                    }
                }
            }
            // Close hides to tray; Quit lives in the tray menu.
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let _ = window.hide();
            }
            // Interacting with the widget raises it like any window; when
            // focus moves on, sink a pinned widget back under everything.
            WindowEvent::Focused(false) => {
                let app = window.app_handle();
                let pinned = app
                    .try_state::<CurrentLayering>()
                    .and_then(|s| s.0.lock().ok().map(|m| *m == "desktop"))
                    .unwrap_or(false);
                if pinned {
                    let _ = window.set_always_on_bottom(true);
                }
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            get_processes,
            kill_process,
            kill_all_processes,
            get_claude_usage,
            get_codex_usage,
            get_openclaw_status,
            get_github_status,
            get_system_health,
            get_tailscale_status,
            get_docker_status,
            get_gpu_status,
            get_thermals,
            setup_thermals,
            get_disks,
            get_net_quality,
            get_ports,
            get_wsl_status,
            wsl_terminate,
            wsl_shutdown_all,
            get_battery,
            get_uptime,
            get_ollama_status,
            get_winget_status,
            run_speedtest,
            get_mcp_status,
            get_local_repos,
            get_self_diagnostics,
            docker_action,
            docker_logs_action,
            wsl_start_action,
            wsl_terminate_action,
            open_path_action,
            open_terminal_action,
            git_fetch_action,
            git_status_action,
            run_repo_tests_action,
            mcp_health_check,
            run_custom_card,
            get_audit_log,
            send_alert,
            set_layering,
            set_locked,
            set_background,
            open_url,
            open_local_port
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
