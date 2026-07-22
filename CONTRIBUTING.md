# Contributing to Dev HUD

Thanks for wanting to help. Dev HUD is a Windows-first Tauri 2 + Rust + React desktop widget, and there are three ways to contribute, in increasing order of effort:

1. **Report bugs / request features** — open a GitHub issue. For bugs, run **"Export redacted diagnostics"** from the command palette (it's also in settings) and attach the dump — it's already secret-masked.
2. **Integrate your tool or SaaS as a custom card** — no fork required. See [Integrating your product](#integrating-your-product-custom-cards) below.
3. **Contribute code** — fixes, new built-in cards, roadmap items (see the README roadmap). See [Adding a built-in card](#adding-a-built-in-card).

## Development setup

Prerequisites:

- Node.js 20+
- Rust (stable) with the MSVC toolchain
- WebView2 runtime (preinstalled on Windows 11)

```
npm install
npm run tauri dev      # vite dev server on port 1430
npm run tauri build    # release build + NSIS installer
```

Verify your changes the same way CI of one (the maintainer) does:

```
npm test               # vitest — unit + component tests
npm run typecheck      # tsc --noEmit
cargo test             # run inside src-tauri/
```

All three must pass before a PR is reviewed.

## Project layout

| Path | What lives there |
|---|---|
| `src/model/` | The domain layer — pure, unit-tested. Status derivation, alerts engine, layout math, settings migration, privacy/redaction. |
| `src/components/` | One React component per card, plus the canvas, settings, alert center. |
| `src/useCollectors.ts` | Every poll in one place: per-card command, cadence, and provenance metadata (`COLLECTORS`). |
| `src/types.ts` ⇄ `src-tauri/src/types.rs` | The payload contract. **Change both together, always.** |
| `src-tauri/src/` | One Rust module per data source; `lib.rs` registers the Tauri commands. |
| `src-tauri/src/cli.rs` | `run_silent_timeout` — every external CLI spawn goes through it (argv arrays, kill-on-timeout, no visible window). |
| `harness.html` + `src/harness.tsx` | Dev-only layout harness — with `npm run dev` running, open `http://localhost:1430/harness.html` to exercise cards at fixed widths in a plain browser. Not part of the app build; don't delete it as dead code. |

## Ground rules

These are load-bearing invariants, not style preferences. PRs that break them will be asked to change:

- **Never kill a process by PID alone.** Kills verify `(pid, startTimeUnix)` identity and abort on mismatch.
- **Credentials are read-only.** The Claude OAuth token is read, never refreshed or stored elsewhere. Same spirit for anything else: Dev HUD observes, it does not own auth.
- **Health checks stay cheap.** e.g. OpenClaw is polled at `GET /health` only — never an endpoint that creates sessions or costs money.
- **Cards emit status conditions every poll, including when everything is normal.** The alert engine's hysteresis needs to observe recovery, not just failure.
- **Degrade honestly.** A missing tool means an auto-hidden card or a guided setup state — never fake data, never a silent zero.
- **No elevation, no telemetry.** The widget never runs elevated and phones home to nothing.
- **Spawns are bounded.** External commands go through `cli::run_silent_timeout` with argv arrays (no shell strings) and a timeout.
- Match the existing style; keep diffs surgical. One concern per PR.

## Integrating your product (custom cards)

If you build a dev tool or SaaS and want Dev HUD users to see your status/usage/quota at a glance, **you don't need to fork or PR anything**. Dev HUD has a sandboxed custom-card runner: the user adds a card in ⚙ → Custom cards pointing at your integration, and the HUD polls it and renders whatever valid payload comes back.

### The three source kinds

| Kind | Target | Notes |
|---|---|---|
| `command` | An absolute path to an executable, or a bare program name on `PATH` | Args are passed as an array. Relative paths and `..` are refused. stdout must be the payload. |
| `file` | A JSON file your tool keeps up to date | Cheapest option if you already write state to disk. |
| `http` | `http://127.0.0.1:<port>/...` or `http://localhost:<port>/...` | **Loopback only** — the host is re-checked after DNS resolution. `https://` is not supported; this is for local agents, not remote APIs. |

The polling loop is bounded on the HUD side: payloads are capped at 64 KB (hard ceiling), timeouts clamp to 0.25–30 s, intervals clamp to 5 s–24 h, and rendering is text-only (`<` and `>` never survive sanitization). Design within that.

### The payload schema (v1)

Your command's stdout / file / HTTP body must be JSON shaped like this:

```json
{
  "schemaVersion": 1,
  "status": "ok",
  "title": "Acme Deploys",
  "metrics": [
    { "label": "Queue depth", "value": 3 },
    { "label": "Last deploy", "value": "4m ago" },
    { "label": "API quota", "value": 82, "unit": "%" }
  ],
  "message": "All regions healthy"
}
```

- `schemaVersion` — must be `1`.
- `status` — one of `"ok"`, `"warning"`, `"critical"`, `"unknown"`. This drives the card's status dot and feeds the user's alert rules.
- `title` — card heading, ≤ 60 chars.
- `metrics` — up to 24 rows; `label` ≤ 60 chars, `value` is a string or number, `unit` optional.
- `message` — optional one-liner, ≤ 200 chars.

A malformed payload is treated as a **failed poll** — the card shows the error, not stale data. Test your integration by running your command/endpoint manually and checking the JSON before pointing a card at it.

### What to ship as a vendor

The pattern that works best: add a `--json`-style status subcommand to the CLI you already ship (`acme status --hud`), or have your local agent expose a loopback status endpoint. Then document one line for your users: *"Dev HUD users: add a custom card with kind `command`, target `acme`, args `status --hud`."* If your tool has real traction with Dev HUD users, that's also the strongest case for promoting it to a built-in card — see below.

## Adding a built-in card

Built-in cards are for data sources broadly useful to AI-assisted developers (the bar: would a stranger enable this?). Vendor-specific cards are welcome when the tool is widely used and the card meets every ground rule above — otherwise start with a custom-card integration.

A new card touches these places — use an existing simple card (e.g. `tailscale` or `docker`) as the template:

1. **Rust collector** — new module in `src-tauri/src/`, e.g. `acme.rs`. Detect-absent → honest "not installed/not running" state. External CLIs via `cli::run_silent_timeout`; HTTP via the existing reqwest client.
2. **Payload types** — add the struct to `src-tauri/src/types.rs` **and** the matching interface to `src/types.ts` (serde `camelCase` on the wire).
3. **Register the command** — in `src-tauri/src/lib.rs` (`#[tauri::command]` + the `invoke_handler` list).
4. **Collector registry** — add an entry to `COLLECTORS` in `src/useCollectors.ts` with a sensible cadence (be conservative; mark it `expensive` if it spawns processes) and an honest `source`/`requires` description.
5. **Card id** — add `["acme", "Acme"]` to `CARD_IDS` in `src/types.ts`; it then appears in settings, ordering, and the layout automatically.
6. **Component** — `src/components/AcmeCard.tsx`, following an existing card's density/overflow patterns.
7. **Status adapter** — a case in `src/model/cardStatus.ts` that emits conditions **every poll** (normal included), so alert rules can hold and release.
8. **Tests** — at minimum: adapter tests in `src/model/cardStatus.test.ts` covering healthy, degraded, and absent states, plus Rust parsing tests if you parse CLI output (locale-proof — no assuming `en-US` number formats).

If the data source can be absent on most machines, wire it as tri-state (`auto`/`on`/`off`) so it auto-hides instead of showing a permanent error.

## Pull requests

- Branch from `main`, one concern per PR.
- `npm test`, `npm run typecheck`, and `cargo test` (in `src-tauri/`) pass.
- Describe what you verified on a real machine — this project's history is full of "probed live" notes for a reason; simulated-only data sources get found out.
- By contributing you agree your work is licensed under the project's [MIT license](LICENSE).
