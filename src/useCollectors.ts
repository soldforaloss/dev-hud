// Every collector poll in one place.
//
// Centralising this is what makes per-card intervals, reduced polling while
// hidden, and "pause the expensive ones on battery" a policy rather than
// nineteen ad-hoc call sites — and it gives the diagnostics card a single
// provenance map to report from.

import { useMemo } from "react";
import { usePoll } from "./hooks";
import type { PollResult } from "./hooks";
import type { Provenance } from "./model/provenance";
import type { Settings } from "./model/settings";
import type {
  BatteryInfo,
  ClaudeUsage,
  CodexUsage,
  DisksStatus,
  DockerStatus,
  GithubPayload,
  GpuStatus,
  LocalReposStatus,
  McpStatus,
  NetQuality,
  OllamaStatus,
  OpenClawStatus,
  PortsStatus,
  ProcessesPayload,
  SelfDiagnostics,
  SystemHealth,
  TailscaleStatus,
  ThermalsStatus,
  UptimeStatus,
  WingetStatus,
  WslStatus,
} from "./types";
import type { StatusBundle } from "./model/cardStatus";

/** Default cadence and provenance metadata per card. */
export const COLLECTORS: Record<
  string,
  { command: string; intervalMs: number; source: string; requires?: string; expensive?: boolean }
> = {
  procs: { command: "get_processes", intervalMs: 3_000, source: "sysinfo process table" },
  claude: {
    command: "get_claude_usage",
    intervalMs: 45_000,
    source: "~/.claude transcripts + OAuth usage API",
    requires: "Claude Code installed; network for live rate windows",
  },
  codex: {
    command: "get_codex_usage",
    intervalMs: 45_000,
    source: "~/.codex/sessions rollouts",
    requires: "Codex CLI installed",
  },
  openclaw: {
    command: "get_openclaw_status",
    intervalMs: 7_000,
    source: "GET /health on the gateway port",
    requires: "OpenClaw gateway listening on its configured port",
  },
  system: { command: "get_system_health", intervalMs: 3_000, source: "sysinfo + K32GetPerformanceInfo" },
  tailscale: {
    command: "get_tailscale_status",
    intervalMs: 30_000,
    source: "tailscale status --json",
    requires: "tailscale CLI on PATH",
  },
  docker: {
    command: "get_docker_status",
    intervalMs: 12_000,
    source: "docker ps / stats / inspect",
    requires: "docker CLI and a running daemon",
    expensive: true,
  },
  repos: {
    command: "get_github_status",
    intervalMs: 300_000,
    source: "GitHub REST API via gh CLI auth",
    requires: "gh auth login",
    expensive: true,
  },
  gpu: {
    command: "get_gpu_status",
    intervalMs: 3_000,
    source: "nvidia-smi",
    requires: "NVIDIA driver",
  },
  thermals: {
    command: "get_thermals",
    intervalMs: 5_000,
    source: "LibreHardwareMonitor web server, else WMI thermal zone",
    requires: "LibreHardwareMonitor on the configured port for full temps",
  },
  disks: { command: "get_disks", intervalMs: 8_000, source: "sysinfo + PerfDisk counters" },
  netq: {
    command: "get_net_quality",
    intervalMs: 15_000,
    source: "ping.exe, TCP:443 fallback",
    expensive: true,
  },
  ports: { command: "get_ports", intervalMs: 10_000, source: "GetExtendedTcpTable" },
  wsl: { command: "get_wsl_status", intervalMs: 20_000, source: "wsl -l -v", requires: "WSL installed" },
  battery: { command: "get_battery", intervalMs: 30_000, source: "Win32_Battery + powercfg" },
  uptime: { command: "get_uptime", intervalMs: 60_000, source: "OS boot time + registry reboot markers" },
  ollama: {
    command: "get_ollama_status",
    intervalMs: 15_000,
    source: "Ollama local API",
    requires: "Ollama listening on its configured port",
  },
  winget: {
    command: "get_winget_status",
    intervalMs: 21_600_000,
    source: "winget upgrade",
    requires: "winget on PATH",
    expensive: true,
  },
  mcp: {
    command: "get_mcp_status",
    intervalMs: 60_000,
    source: "Claude/Codex MCP config files + live process match",
  },
  git: {
    command: "get_local_repos",
    intervalMs: 120_000,
    source: "git status/log in configured folders",
    requires: "git on PATH and at least one configured folder",
    expensive: true,
  },
  diag: { command: "get_self_diagnostics", intervalMs: 10_000, source: "the HUD measuring itself" },
};

export interface CollectorSet {
  bundle: StatusBundle;
  provenance: Record<string, Provenance>;
  refresh: Record<string, () => Promise<void>>;
  errors: Record<string, string | null>;
}

export interface CollectorOptions {
  settings: Settings;
  nonce: number;
  /** False when a card's mode is "off" — the collector is not polled at all. */
  isPolled: (id: string) => boolean;
  /** True while running on battery, for the expensive-collector policy. */
  onBattery: boolean;
}

/**
 * A card's effective interval: the user's override if set, otherwise the
 * default. Expensive collectors are slowed 4× on battery rather than stopped,
 * so the card degrades honestly instead of going blank.
 */
export function effectiveInterval(
  id: string,
  settings: Settings,
  onBattery: boolean,
): number {
  const def = COLLECTORS[id]?.intervalMs ?? 30_000;
  const base = settings.pollIntervals[id] ?? def;
  const expensive = COLLECTORS[id]?.expensive ?? false;
  if (expensive && onBattery && settings.pauseExpensiveOnBattery) return base * 4;
  return base;
}

export function useCollectors(opts: CollectorOptions): CollectorSet {
  const { settings, nonce, isPolled, onBattery } = opts;
  const slow = Math.max(1, settings.hiddenSlowdown);

  const mk = <T,>(id: string, args?: Record<string, unknown>): PollResult<T> => {
    const meta = COLLECTORS[id];
    // eslint-disable-next-line react-hooks/rules-of-hooks
    return usePoll<T>(meta.command, effectiveInterval(id, settings, onBattery), nonce, {
      args,
      enabled: isPolled(id),
      source: meta.source,
      requires: meta.requires,
      hiddenMultiplier: slow,
      pauseWhenHidden: meta.expensive === true,
    });
  };

  // The call order below is fixed — these are hooks, and `isPolled` only ever
  // toggles the `enabled` flag, never whether the hook runs.
  const procs = mk<ProcessesPayload>("procs");
  const claude = mk<ClaudeUsage>("claude");
  const codex = mk<CodexUsage>("codex");
  const openclaw = mk<OpenClawStatus>("openclaw");
  const system = mk<SystemHealth>("system");
  const tailscale = mk<TailscaleStatus>("tailscale");
  const docker = mk<DockerStatus>("docker");
  const repos = mk<GithubPayload>("repos");
  const gpu = mk<GpuStatus>("gpu");
  const thermals = mk<ThermalsStatus>("thermals", { lhmPort: settings.lhmPort });
  const disks = mk<DisksStatus>("disks");
  const netq = mk<NetQuality>("netq", { host: settings.pingHost });
  const ports = mk<PortsStatus>("ports");
  const wsl = mk<WslStatus>("wsl");
  const battery = mk<BatteryInfo>("battery");
  const uptime = mk<UptimeStatus>("uptime");
  const ollama = mk<OllamaStatus>("ollama", { port: settings.ollamaPort });
  const winget = mk<WingetStatus>("winget");
  const mcp = mk<McpStatus>("mcp");
  const git = mk<LocalReposStatus>("git", {
    roots: settings.repoRoots,
    extraPaths: [],
  });
  const diag = mk<SelfDiagnostics>("diag");

  const all: Record<string, PollResult<unknown>> = {
    procs, claude, codex, openclaw, system, tailscale, docker, repos, gpu,
    thermals, disks, netq, ports, wsl, battery, uptime, ollama, winget, mcp,
    git, diag,
  };

  // These container objects must only change identity when their *contents*
  // do. App derives card status from them in a useMemo and evaluates alerts in
  // an effect keyed on that result — a fresh object every render would make
  // both run on every render, and the alert effect would then loop.
  const ids = Object.keys(all);
  const provenanceValues = ids.map((id) => all[id].provenance);
  const refreshValues = ids.map((id) => all[id].refresh);
  const errorValues = ids.map((id) => all[id].error);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const provenance = useMemo(
    () => Object.fromEntries(ids.map((id, i) => [id, provenanceValues[i]])) as Record<string, Provenance>,
    provenanceValues,
  );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const refresh = useMemo(
    () => Object.fromEntries(ids.map((id, i) => [id, refreshValues[i]])) as Record<string, () => Promise<void>>,
    refreshValues,
  );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const errors = useMemo(
    () => Object.fromEntries(ids.map((id, i) => [id, errorValues[i]])) as Record<string, string | null>,
    errorValues,
  );

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const bundle: StatusBundle = useMemo(() => ({
    claude: claude.data,
    codex: codex.data,
    openclaw: openclaw.data,
    system: system.data,
    gpu: gpu.data,
    thermals: thermals.data,
    disks: disks.data,
    netq: netq.data,
    ports: ports.data,
    wsl: wsl.data,
    battery: battery.data,
    uptime: uptime.data,
    tailscale: tailscale.data,
    docker: docker.data,
    ollama: ollama.data,
    winget: winget.data,
    mcp: mcp.data,
    procs: procs.data,
    repos: repos.data,
    git: git.data,
    diag: diag.data,
    custom: EMPTY_CUSTOM,
  }), [
    claude.data, codex.data, openclaw.data, system.data, gpu.data,
    thermals.data, disks.data, netq.data, ports.data, wsl.data, battery.data,
    uptime.data, tailscale.data, docker.data, ollama.data, winget.data,
    mcp.data, procs.data, repos.data, git.data, diag.data,
  ]);

  return { bundle, provenance, refresh, errors };
}

/** Shared empty map so the bundle's identity is not churned by `{}`. */
const EMPTY_CUSTOM: Record<string, null> = {};
