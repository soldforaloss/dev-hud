# ◉ Dev HUD

**The always-on desktop HUD for your AI dev stack.**

One glass widget, pinned to your desktop, that answers the four questions every AI-assisted developer alt-tabs for all day:

- **How much Claude do I have left?** — live 5h / weekly rate-limit rings (real percentages from the OAuth usage API), token + cost burn today, active 5-hour block countdown, 24h burn sparkline, per-model split — plus the **sessions actively working right now** (which project, how fresh, pulsing while live).
- **How much Codex do I have left?** — 5h / weekly usage rings with reset countdowns and plan info, parsed straight from Codex's own session logs, with the same live-session list. "On pace / over pace" tells you if you'll make it to the reset.
- **Is my OpenClaw gateway alive?** — health probe against the documented `/health` endpoint, latency, uptime, memory, CPU, and a one-click jump into the Control UI.
- **What's happening in *my* repos?** — auto-discovered from your gh CLI account (no watch-list to maintain): CI status dot, open PRs, real issue counts (PRs subtracted), stars, and latest release with a **NEW** badge when something ships.
- **Is the machine okay?** — a System card with CPU, RAM, commit-charge, and network throughput meters plus LAN/WAN IPs.
- **Is my tailnet up?** — a Tailscale card: connection state, tailnet IP, MagicDNS hostname, peers online.
- **What's running in Docker?** — container list with status and ports (and an honest "daemon not running" when it's off).

### The hardware utilities suite

- **GPU (NVIDIA)** — utilization, VRAM, temp, power, clocks, fan via `nvidia-smi`, plus per-process VRAM with identity-verified kill.
- **Thermals** — tiered CPU temps: full package/core temps + fan RPM via LibreHardwareMonitor's web server (guided 2-minute setup in settings), ACPI zone via WMI where readable, honest "needs setup" otherwise.
- **Disks** — per-volume capacity bars + live read/write throughput.
- **Network quality** — ping/jitter/loss bar-chart (locale-proof `ping` parsing, TCP fallback when ICMP is blocked), Wi-Fi SSID/signal/link rate.
- **Ports map** — every listening TCP port → owning process, click to open `localhost:PORT`; ports also badge the matching Processes rows.
- **WSL** — distros with running state, vmmem RAM cost, per-distro terminate + shut down all.
- **Battery & power** — charge, AC state, est. runtime, active power plan (auto-hides on desktops).
- **Uptime & reboot** — uptime, boot time, pending-reboot detection from the registry markers.
- **Software updates** — `winget upgrade` list on a 6-hour cadence.
- **Speedtest** — on-demand Cloudflare down/up/latency (never automatic; labeled ~33 MB).
- **Ollama** — loaded models with VRAM + unload countdown, installed model count.
- **MCP inspector** — servers configured for Claude Desktop / Claude Code / Codex, cross-referenced against live processes.
- **Alerts engine** — Windows toasts with thresholds you set: GPU/CPU temp, RAM, disk-free, gateway down, new release, WAN change. Rate-limited, fire-on-crossing.

Every card is tri-state in settings — **auto** (shown only when detected on your machine), **on**, or **off** (hidden and never polled). A first-run card lists exactly what was detected. No NVIDIA GPU? You never see a GPU card. That's the out-of-the-box story: zero config, nothing broken-looking, and the one genuinely gated feature (CPU temps) is a guided opt-in.

#### Why LibreHardwareMonitor is one-click-installed, not bundled

Settings → CPU thermals has a **"Set up automatically"** button: it installs LHM from winget's official source, pre-seeds its config (web server on, tray-minimized), starts it elevated, and registers a highest-privilege logon task — one button, one UAC prompt. We deliberately do **not** ship LHM's binaries inside the installer, even though its MPL-2.0 license would allow it (with attribution): LHM loads the WinRing0 kernel driver, which Defender/HVCI flags on some machines — bundling that would poison this installer's SmartScreen reputation — and a vendored copy would go stale while winget's stays current. Installing from the official source at the moment of explicit user opt-in gets the same end result with none of that. To undo the autostart: `schtasks /Delete /TN LibreHardwareMonitor-AIHUD /F` (admin).

Plus a built-in **process manager** for the node/bun/deno swarm AI tooling leaves behind — with identity-verified kills that can never terminate the wrong process, orphan detection, idle timers, and automatic labeling ("OpenClaw Gateway", "Vite", "MCP Server", …).

Windows-first. Built with Tauri 2 + Rust + React. ~10 MB, no Electron.

> Spiritual Windows port & merger of [CodexBar](https://github.com/steipete/CodexBar), [RepoBar](https://github.com/steipete/RepoBar), and [ReleaseBar](https://github.com/steipete/ReleaseBar) — as a desktop widget instead of a menu bar.

---

## The widget

- **Lives on the desktop layer** — always visible under your windows, never in the way. Three layering modes from the tray: *Pinned to desktop*, *Normal window*, *Always on top*. A focus-lost handler re-sinks the widget so Windows can't float it mid-stack after you interact with it.
- **Drag it anywhere, then lock it.** Window position and every card rectangle persist across restarts. The lock (🔒 in the header, or tray → *Lock position*) disables dragging so a stray mouse can't move it.
- **Acrylic glass** background via native Windows acrylic (or solid, your choice).
- **Tray icon** — show/hide, refresh, layering, lock, quit. Closing the window hides to tray.
- **Autostart** with Windows (toggleable), single-instance guarded.
- Every card collapses to a one-line summary (spend today, % used, gateway latency…) and remembers its state.

## Where the data comes from

| Card | Source | Notes |
| --- | --- | --- |
| Claude | `~/.claude/projects/**/*.jsonl` + `api.anthropic.com/api/oauth/usage` | Local scan dedupes by `message.id + requestId` (same rule as ccusage/CodexBar — resumed sessions copy history). Costs are API-equivalent estimates from a built-in pricing table. Rate rings use the Claude Code OAuth token read-only; tokens are never refreshed or stored. Active sessions = transcripts written to in the last 10 min, deduped by project. |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | Last `token_count` event per session carries cumulative tokens + the freshest `rate_limits` snapshot. Tail-read (256 KB) with mtime-keyed caching. Active sessions from rollout mtimes + `session_meta` cwd. |
| OpenClaw | `GET http://127.0.0.1:{port}/health` + process scan | Port resolved like OpenClaw itself: `OPENCLAW_GATEWAY_PORT` → `gateway.port` in `~/.openclaw/openclaw.json` → `18789`. `/health` is the documented monitoring endpoint — no session created per poll. |
| Repos | GitHub REST API via **gh CLI auth** | Token from `gh auth token` (env vars as fallback). Your own repositories are discovered automatically (`affiliation=owner`, most recently pushed, top 8). Issue counts subtract PRs (GitHub's `open_issues_count` lies). |
| System | `sysinfo` + `K32GetPerformanceInfo` | CPU %, RAM, **commit charge** (the number task managers call "swap/pagefile" on Windows), network ↓/↑ rates, LAN IP (UDP-connect trick, no packet sent), WAN IP (api.ipify.org, cached 15 min). |
| Tailscale | `tailscale status --json` | Backend state, tailnet IPv4, MagicDNS name, peers online/total. |
| Docker | `docker ps --format "{{json .}}"` | Distinguishes not-installed / daemon-down / running containers. |
| GPU | `nvidia-smi --query-gpu=… --format=csv` + `pmon -c 1 -s m` | Every field optional (`[N/A]` is normal); 8 s kill-timeout guards broken drivers. |
| Thermals | LHM `:8085/data.json` → WMI `MSAcpi_ThermalZoneTemperature` | All WMI runs on one dedicated bridge thread (COM isn't Send). Never elevates the widget. |
| Disks | `sysinfo` + `Win32_PerfFormattedData_PerfDisk` | Formatted counters are already rates. |
| Net quality | `ping.exe` (locale-proof parse) / TCP:443 fallback + `netsh wlan` | Rolling 20-sample window for avg/jitter/loss. |
| Ports | `GetExtendedTcpTable` (via `listeners`) | Feeds clickable badges into the Processes card. |
| WSL | `wsl -l -v` (UTF-16LE decoded!) | vmmem RAM from the shared process table. |
| Battery / Uptime | `Win32_Battery` + `powercfg` / registry reboot markers | Battery card auto-hides without one. |
| Updates | `winget upgrade` | Columns located by header offsets (headers localize). |
| Speedtest | `speed.cloudflare.com/__down`/`__up` | On-demand only. |
| Ollama / MCP | `:11434/api/ps` + tags / Claude+Codex config files | MCP running-state matched against live command lines. |
| Processes | `sysinfo` snapshot | Long-lived scanner for meaningful CPU deltas. Kills verify `(pid, start_time)` identity so a recycled PID is never terminated. |

Everything is read-only and local except the two HTTPS calls above (Anthropic usage, GitHub API). No telemetry, no accounts, no cloud.

---

## The operator console

The HUD answers six questions in order, and every one of them is one click or one keystroke from the last:

**What's happening now?** → the board. **What's abnormal?** → the *Needs attention* strip under the header. **What's affected?** → click the item, land on the card. **What correlates?** → the timeline (`☰`). **What can I do?** → the inspector's actions. **Did it work?** → the alert recovers itself and says so.

### Status semantics

Every card reports four *independent* dimensions, because collapsing them into one dot is how "stale" gets mistaken for "broken":

| Dimension | Values | Answers |
| --- | --- | --- |
| Health | healthy · degraded · unavailable · unknown | can the source answer at all? |
| Activity | active · idle · stopped · starting | is the thing doing work? |
| Attention | normal · warning · critical | does a human need to look? |
| Freshness | live · stale · estimated · cached · not measured | how much do we trust the timeliness? |

Nothing is signalled by colour alone — each badge carries a glyph, a label and an accessible description. Empty is never one thing either: a valid zero, "not configured", "not installed", "unsupported on this host", "permission denied" and "the collector failed" are ten distinct states, each explaining itself and offering the action that fixes it.

**The board is a canvas, not a grid.** Every card owns a rectangle: drag it anywhere by the ⠿ grip, resize it from the right edge, the bottom edge or the corner — width and height independently. The only boundary is another card's edge. Nothing swaps, nothing reflows, and two short cards can sit one above the other in the same column. Drag a card into an occupied space and it slides as far as it fits and parks there; the outline turns red while the position under the pointer is taken, and the dashed ghost shows where it will land. Locking the HUD makes the board read-only.

**Cards resize into information density, not just size.** Each card measures its own box and switches between *compact* (headline state only), *standard* (metrics plus key context) and *expanded* (history charts, full lists, diagnostics, related entities). A card collapsed to its header only occupies its header, so the space beneath it is immediately usable.

### One row pattern, everywhere

Data-heavy cards all use the same row, and its shape is enforced by the layout rather than by discipline:

```text
[dot] primary · secondary        badge badge    metric metric  [↗]
 fixed  flex 2   flex 1           drop first     fixed, tabular
```

**The row itself is the button** — clicking it opens that entity's inspector. There are no labelled action buttons inside rows: a labelled button costs roughly 90px of permanent width, and a Ports row used to carry three of them, which is why cards had to be half the screen wide before anything fit. At most **one icon** survives inline, and only when it is the row's obvious verb — open a port, open a repo, open a terminal.

When space runs out the row sheds in a fixed order: badges first, then the secondary qualifier, then the second metric. **The primary identifier is never dropped** — it truncates with an ellipsis and the full value is in the tooltip and the inspector. Numbers never truncate; they are fixed-width, right-aligned and tabular, so a column of them scans vertically.

Nothing wraps inside a row and no card scrolls sideways — cards scroll vertically only, and text scales down with the card (container queries) rather than clipping. A list cut short by the density budget says so and offers the way to the rest.

Where the detail went: terminate, restart, fetch, run tests, health check, copy endpoint, copy session id, open release — all in the entity's inspector, which was already the place for full context, provenance, history and related entities.

### Inspect anything

`⤢` on any card — or `Enter` on the focused one — opens the right-side inspector: current state, history, **data provenance** (which collector, last attempt, last success, poll duration, what it depends on, last error), related entities, recent events, and the safe actions available. `Escape` closes it.

Entities are linked across cards, so the walk works in both directions: port → owning process → working directory → repository → the agent session running in it → the MCP server it spawned. Nothing is a database; the graph is rebuilt from each poll, so a dead PID can never linger as a phantom edge.

### Keyboard

| Key | Action |
| --- | --- |
| `Ctrl+K` / `/` | command palette — `pid:18789`, `port:5434`, `repo:name`, `mcp:name`, or any command by name |
| `↑` `↓` `←` `→` | move between cards |
| `Enter` | inspect the focused card |
| `Escape` | close inspector, palette or panel |
| `Ctrl+R` | refresh every collector |

Destructive commands in the palette are labelled and need `Enter` twice.

### Alerts that behave like alerts

Thresholds now have a warning tier, a critical tier, a **sustained duration**, a separate **recovery threshold** (hysteresis), a recovery dwell time, a cooldown, and quiet hours. Composite rules can require two conditions at once.

> Warn when packet loss > 5% for 90 s. Critical when > 12% for 30 s. Recover when it stays under 2% for 60 s. Don't re-notify for 15 minutes unless it gets worse.

Toasts still fire, but they're now the notification for a **persistent alert record** that survives dismissal and restart: severity, first/last seen, duration, current value, trigger, related entities, acknowledge/snooze state, suggested action, and recovery time. Escalation always breaks through a cooldown, an acknowledgement or a snooze — getting worse is always news.

The **timeline** records changes, not polls, so it reads as a story:

```text
14:42  Network packet loss crossed 10%
14:41  Tailscale switched from direct to relay
14:31  Process 18789 became orphaned
14:22  Docker container restarted
```

When a critical alert opens, the HUD can freeze a **redacted incident snapshot** locally — CPU, memory, disks, thermals, network, process tree, listening ports, containers, WSL, gateway, MCP servers, AI sessions, repositories and recent events — so the post-mortem is still possible after everything recovered. Retention is capped by both count and bytes.

### Safe operator actions

Every state-changing action is explicit, argument-validated, confirmed, time-bounded and written to a local audit trail. Nothing is ever interpolated into a shell — every spawn is an argv array — and identifiers are validated by grammar, not by blocklist.

- **Processes** — inspect the tree, masked command line, working directory, graceful and force terminate, tree terminate, reviewed batch cleanup of confirmed orphans. Kills stay identity-verified by `(pid, start_time)`.
- **Ports** — identify the owner, copy the endpoint, open it, inspect bind address and exposure scope.
- **Docker** — start / stop / restart, view logs, inspect health.
- **WSL** — start, terminate, open a terminal, see forwarded state and disk usage.
- **MCP** — run a health check (a real `initialize` + `tools/list` handshake over stdio) and list capabilities. Explicit only: it starts the server, so it is never polled. The command that runs is re-read from disk, never accepted from the UI.
- **Repositories** — open the folder, fetch, view working-tree changes, run the project's declared test command **from a fixed allowlist**. Commit, push, reset and discard are not implemented, deliberately.

Actions can be disabled globally or per card.

### Privacy mode

One toggle redacts IP addresses, hostnames, device and peer names, repository names, usernames, filesystem paths, process arguments and session identifiers — across cards, inspectors, alerts, the timeline, copied text, exports and incident snapshots. Aliases are stable for the session (`ip-1`, `repo-2`) so the HUD stays readable while you screen-share. Blur was not an option: the raw value must never survive in a tooltip, an accessibility label or the clipboard. Secrets and tokens are masked in **every** mode, not just this one.

### Profiles, polling and retention

Named profiles capture visible cards, layout, sizes, poll intervals, opacity, layering, privacy and alert rules — with presets for AI development, network diagnostics, performance/thermals, repository maintenance, presentation and minimal ambient. Polling is per-card configurable, slows while the HUD is hidden, and backs off expensive collectors on battery. Retention caps apply to events, alerts, snapshots and metric history.

### Custom cards

A versioned, sandboxed contract: a command (argv array, never a shell), a local file, or a loopback HTTP endpoint returning

```json
{ "schemaVersion": 1, "status": "warning", "title": "Build Queue",
  "metrics": [{ "label": "Queued", "value": 8 }],
  "message": "Oldest job has waited 14 minutes" }
```

with timeouts, output-size limits, schema validation, sanitised text-only rendering (no HTML, ever), and an honest error state. Configured cards appear on the board like any other — same shell, same status badges, same inspector and overflow menu — and a card whose payload fails validation shows a collector error with a *Run now*, never the previous payload dressed up as current.

---

## Build

```powershell
npm install
npm run tauri dev     # develop
npm test              # vitest — models, components, redaction, migrations
npm run typecheck     # tsc --noEmit
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri build   # release exe + NSIS installer
```

Requires Rust (stable), Node 20+, and WebView2 (ships with Windows 11).

## Configure

Gear icon → settings: layering, acrylic/solid, lock, autostart. Repos need no configuration — they follow your gh CLI account. Everything persists to the Tauri store (`settings.json` in the app config dir).

The board is a free-placement canvas that **fills whatever window you give it**: card rectangles are proportional to the window width, so the whole arrangement scales together, and the canvas scrolls rather than crushing cards once the window gets narrower than roughly 500px. Each card scrolls internally when its content exceeds its box — nothing is ever clipped — and cards scale their row typography down as they get narrower (container queries), shedding low-priority columns before ever truncating what matters.

---

## Roadmap — what would make this even cooler

Implemented ✅ / planned ⬜:

- ✅ Live Claude 5h/weekly rings via OAuth usage API (not just log estimates)
- ✅ CodexBar-style pace indicator ("12% in reserve", "over pace")
- ✅ Release NEW badges with per-repo seen-state
- ✅ Identity-verified kills + orphan detection for runtime processes
- ✅ Persistent alert center with sustained thresholds, hysteresis, cooldown, quiet hours, ack/snooze and recovery
- ✅ Needs-attention strip, shared inspector, cross-card entity graph, `Ctrl+K` palette, keyboard navigation
- ✅ Event timeline + redacted incident snapshots
- ✅ Safe operator actions with argument validation and a local audit trail
- ✅ Privacy / screen-sharing mode, redacted diagnostic export, named profiles
- ✅ Per-card polling, reduced polling while hidden, battery back-off, retention caps
- ✅ Sandboxed custom-card contract (command / file / loopback HTTP, schema-validated)
- ⬜ **Wallpaper-glue mode** — parent the window to WorkerW so it survives Win+D like Rainmeter
- ⬜ **Multi-host** — the models already carry an optional `hostId`; the selector and a Tailscale transport are the remaining work
- ⬜ **Toast notifications** — new release shipped, rate limit > 90%, gateway went down
- ⬜ **Burn-down forecast** — "at this pace your weekly limit dies Thursday 3pm" with a tiny burn-down chart (CodexBar's killer widget)
- ✅ Tailscale + Docker cards, per-card enable/disable, fill-the-window responsive layout
- ⬜ **More providers** — Gemini CLI, Copilot, Cursor, OpenRouter credit balance (CodexBar tracks 60+; the provider trait is ready for it)
- ⬜ **OpenClaw deep status** — WS `connect` handshake for the full health snapshot (per-channel status, active sessions), restart button wired to the watchdog
- ⬜ **Temps** — Windows doesn't expose CPU/GPU temps to userland reliably; needs a LibreHardwareMonitor-style helper (admin driver), so it's opt-in territory
- ⬜ **GPU card** — VRAM/utilization via `nvidia-smi` where present
- ⬜ **Net quality** — ping/jitter to 1.1.1.1 alongside throughput
- ⬜ **Port badges** on processes (which dev server owns :3000?)
- ⬜ **WSL / Ollama / MCP-server cards** — same pattern as Docker: detect, list, act
- ⬜ **Adaptive refresh** — poll faster while you're actively using the tools, slower when idle / on battery
- ⬜ **Theme packs** + accent editor, horizontal dock layout option
- ⬜ **CLI companion** (`dev-hud --json`) for scripting the same data into tmux/starship prompts
- ⬜ Linux/macOS builds (everything except acrylic + the kill probe is already cross-platform)

PRs welcome. MIT licensed.
