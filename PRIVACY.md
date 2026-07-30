# Privacy and network behavior

Dev HUD has **no maintainer telemetry**: no analytics, no crash reporting, no
accounts, no update phone-home. The maintainer receives nothing when you run
the app. That said, "no network" would be the wrong promise — several
collectors contact external services to do their job. This document lists
every one of them.

## Outbound connections

| Endpoint | Trigger | Cadence | Data sent | Credential used | How to disable |
| --- | --- | --- | --- | --- | --- |
| `api.anthropic.com/api/oauth/usage` | Claude card enabled and a Claude Code OAuth token exists | Each Claude card poll | The request itself (bearer token) | Claude Code OAuth token from `~/.claude/.credentials.json`, read-only — never refreshed or stored elsewhere | Turn the Claude card off in ⚙ → Cards |
| `api.github.com` | Repos card enabled and a GitHub token is available | Each Repos card poll | The request itself (bearer token) | `gh auth token`, falling back to `GH_TOKEN`/`GITHUB_TOKEN` env vars, read-only | Turn the Repos card off in ⚙ → Cards |
| `api.ipify.org` | System card enabled (WAN IP field) | At most once per 15 minutes (cached, including across failures) | The request itself — your public IP is what the service reports back | None | Turn the System card off in ⚙ → Cards (no separate WAN-IP toggle yet) |
| Configured ping target, default `1.1.1.1` | Net quality card enabled | Each Net quality poll (default 15 s) | ICMP echo requests, or a TCP:443 handshake when ICMP is blocked | None | Turn the Net quality card off in ⚙ → Cards |
| `speed.cloudflare.com` | You click **Run speedtest** — never automatic | On demand only | ~25 MB download + ~8 MB upload of random bytes per run | None | Don't run it |
| Configured winget sources (Microsoft by default) | Updates card enabled (`winget upgrade`), or you accept the guided thermals setup (`winget install LibreHardwareMonitor`) | Each Updates card poll; thermals install is one-time and user-confirmed | Standard winget source queries | None | Turn the Updates card off in ⚙ → Cards; decline the thermals setup |

Anything not in this table stays on your machine. If a change adds an
outbound endpoint, it must be added to this table in the same PR — that rule
is part of [CONTRIBUTING.md](CONTRIBUTING.md).

## Local-only connections

These never leave your machine (loopback only):

- OpenClaw gateway health checks (`127.0.0.1:{port}/health`)
- Ollama API (`127.0.0.1:11434`)
- LibreHardwareMonitor web server (`localhost:8085`)
- Custom-card HTTP sources — the contract rejects non-loopback URLs
- MCP server discovery — reads Claude/Codex config files on disk

## Credentials

Dev HUD observes, it does not own auth. Credentials (the Claude OAuth token,
the GitHub token) are read from where their own tools store them, sent only
to their own service, and never written anywhere else, refreshed, or logged.

## What privacy mode does — and does not do

Privacy mode (🛡) is **display and export redaction** for screen sharing:
addresses, hostnames, paths and repository names are replaced with stable
aliases in the UI, diagnostics exports and incident snapshots. Secrets in
process command lines are masked unconditionally, privacy mode or not.

Privacy mode does **not** change network behavior — collectors keep polling
the endpoints listed above. To stop a network collector, turn its card off.
