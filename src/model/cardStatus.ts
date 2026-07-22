// Payload → shared semantics.
//
// One adapter per card, all pure. This is the only place that knows how to
// read a collector's shape, which keeps the components dumb and makes the
// "is this healthy / stale / worth interrupting me for" question testable
// without a DOM.

import type {
  BatteryInfo,
  ClaudeUsage,
  CodexUsage,
  CustomCardResult,
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
} from "../types";
import type { AttentionState, FreshnessState, HealthState, ActivityState } from "./status";
import { attentionFromThresholds, worstAttention } from "./status";
import type { Provenance } from "./provenance";
import { collectorHealth, provenanceFreshness } from "./provenance";
import type { EntityRef } from "./entities";
import { entityRef } from "./entities";
import type { AlertRules, ThresholdRule } from "./settings";

/**
 * One evaluated condition.
 *
 * Conditions are emitted on *every* poll, including while normal — that is
 * what lets the alert engine apply hysteresis. A value sitting between the
 * warning threshold and the recovery threshold is neither firing nor
 * recovered, and it can only stay in that dead-band if the card keeps
 * reporting it.
 */
export interface AttentionItem {
  /** Stable across polls — doubles as the alert dedupe key. */
  key: string;
  cardId: string;
  ruleId: string;
  severity: AttentionState;
  title: string;
  detail?: string;
  value?: number;
  threshold?: number;
  entities: EntityRef[];
  suggestedActions?: string[];
  /** True when the value is back inside the recovery band. */
  recovered?: boolean;
  sustainSecs?: number;
  recoverSecs?: number;
  cooldownSecs?: number;
}

export interface CardStatus {
  id: string;
  health: HealthState;
  activity?: ActivityState;
  attention: AttentionState;
  freshness: FreshnessState;
  /** undefined = still probing; false hides the card in "auto" mode. */
  availability: boolean | undefined;
  /** Plain-language reason a card is shown or hidden under "auto". */
  availabilityReason: string;
  /** Short explanation attached to the header badges. */
  statusDetail: string;
  /** Every evaluated condition, normal ones included. */
  conditions: AttentionItem[];
  /** The subset worth showing a human — `conditions` minus the normal ones. */
  attentionItems: AttentionItem[];
}

/** Split a condition list into what fires and what the engine still tracks. */
function settle(s: CardStatus, conditions: AttentionItem[]): CardStatus {
  s.conditions = conditions;
  s.attentionItems = conditions.filter((c) => c.severity !== "normal");
  s.attention = worstAttention(conditions.map((c) => c.severity));
  return s;
}

export interface StatusBundle {
  claude: ClaudeUsage | null;
  codex: CodexUsage | null;
  openclaw: OpenClawStatus | null;
  system: SystemHealth | null;
  gpu: GpuStatus | null;
  thermals: ThermalsStatus | null;
  disks: DisksStatus | null;
  netq: NetQuality | null;
  ports: PortsStatus | null;
  wsl: WslStatus | null;
  battery: BatteryInfo | null;
  uptime: UptimeStatus | null;
  tailscale: TailscaleStatus | null;
  docker: DockerStatus | null;
  ollama: OllamaStatus | null;
  winget: WingetStatus | null;
  mcp: McpStatus | null;
  procs: ProcessesPayload | null;
  repos: GithubPayload | null;
  git: LocalReposStatus | null;
  diag: SelfDiagnostics | null;
  custom: Record<string, CustomCardResult | null>;
}

export interface StatusContext {
  data: StatusBundle;
  provenance: Record<string, Provenance>;
  rules: AlertRules;
  nowMs: number;
}

const NO_ITEMS: AttentionItem[] = [];

function base(id: string, ctx: StatusContext): CardStatus {
  const p = ctx.provenance[id];
  return {
    id,
    health: p ? collectorHealth(p) : "unknown",
    attention: "normal",
    freshness: p ? provenanceFreshness(p, ctx.nowMs) : "not_measured",
    availability: undefined,
    availabilityReason: "Still probing this source",
    statusDetail: "",
    conditions: NO_ITEMS,
    attentionItems: NO_ITEMS,
  };
}

/** Threshold rule → attention + recovery band, in one place. */
function evaluate(
  rule: ThresholdRule,
  value: number | null | undefined,
): { severity: AttentionState; recovered: boolean } {
  if (!rule.on || value == null) return { severity: "normal", recovered: true };
  const severity = attentionFromThresholds(value, rule.warn, rule.critical, rule.higherIsWorse);
  const recovered = rule.higherIsWorse ? value < rule.recoverAt : value > rule.recoverAt;
  return { severity, recovered };
}

function item(
  partial: Omit<AttentionItem, "sustainSecs" | "recoverSecs" | "cooldownSecs">,
  rule: { sustainSecs: number; recoverSecs: number; cooldownSecs: number },
): AttentionItem {
  return {
    ...partial,
    sustainSecs: rule.sustainSecs,
    recoverSecs: rule.recoverSecs,
    cooldownSecs: rule.cooldownSecs,
  };
}

// ---------------------------------------------------------------- adapters

export function deriveCardStatus(id: string, ctx: StatusContext): CardStatus {
  const fn = ADAPTERS[id];
  return fn ? fn(ctx) : base(id, ctx);
}

type Adapter = (ctx: StatusContext) => CardStatus;

const ADAPTERS: Record<string, Adapter> = {
  claude: (ctx) => {
    const s = base("claude", ctx);
    const d = ctx.data.claude;
    if (!d) return s;
    s.availability = d.available;
    s.availabilityReason = d.available
      ? "Found Claude Code transcripts in ~/.claude/projects"
      : "Hidden because ~/.claude was not found";
    if (!d.available) {
      s.health = "unavailable";
      s.statusDetail = "Claude Code not installed";
      return s;
    }
    s.health = "healthy";
    s.activity = d.activeSessions.some((x) => x.ageSecs < 120) ? "active" : "idle";
    // Local estimates are honest data, just not provider-authoritative.
    if (!d.windowsLive) {
      s.freshness = "estimated";
      s.statusDetail = d.providerError
        ? `Rate limits unavailable: ${d.providerError}`
        : "Rate limits estimated from local logs";
      s.health = "degraded";
    } else {
      s.statusDetail = `${d.windows.length} live rate windows`;
    }
    const items: AttentionItem[] = [];
    for (const w of d.windows) {
      const sev = attentionFromThresholds(w.usedPercent, 85, 95, true);
      {
        items.push(
          item(
            {
              key: `claude-window:${w.label}`,
              cardId: "claude",
              ruleId: "claudeWindow",
              severity: sev,
              title: `Claude ${w.label} limit ${w.usedPercent.toFixed(0)}% used`,
              detail: `${(100 - w.usedPercent).toFixed(0)}% remaining before reset`,
              value: w.usedPercent,
              threshold: sev === "critical" ? 95 : 85,
              entities: [],
              suggestedActions: ["Switch model", "Wait for reset"],
              recovered: w.usedPercent < 80,
            },
            { sustainSecs: 0, recoverSecs: 60, cooldownSecs: 1800 },
          ),
        );
      }
    }
    return settle(s, items);
  },

  codex: (ctx) => {
    const s = base("codex", ctx);
    const d = ctx.data.codex;
    if (!d) return s;
    s.availability = d.available;
    s.availabilityReason = d.available
      ? "Found Codex rollouts in ~/.codex/sessions"
      : "Hidden because ~/.codex was not found";
    if (!d.available) {
      s.health = "unavailable";
      s.statusDetail = "Codex not installed";
      return s;
    }
    s.health = "healthy";
    s.activity = d.activeSessions.some((x) => x.ageSecs < 120) ? "active" : "idle";
    // Codex windows come from the last logged snapshot, never a live API.
    const ageSecs = d.lastEventUnix > 0 ? ctx.nowMs / 1000 - d.lastEventUnix : null;
    if (ageSecs == null) {
      s.freshness = "not_measured";
      s.statusDetail = "No rate-limit snapshot in recent sessions";
      s.health = "degraded";
    } else if (ageSecs > 86_400) {
      s.freshness = "stale";
      s.statusDetail = "Last Codex activity was over a day ago";
    } else {
      s.freshness = "cached";
      s.statusDetail = "Rate limits from the newest session log";
    }
    const items: AttentionItem[] = [];
    for (const w of [d.primary, d.secondary]) {
      if (!w) continue;
      const sev = attentionFromThresholds(w.usedPercent, 85, 95, true);
      {
        items.push(
          item(
            {
              key: `codex-window:${w.label}`,
              cardId: "codex",
              ruleId: "codexWindow",
              severity: sev,
              title: `Codex ${w.label} limit ${w.usedPercent.toFixed(0)}% used`,
              value: w.usedPercent,
              threshold: sev === "critical" ? 95 : 85,
              entities: [],
              recovered: w.usedPercent < 80,
            },
            { sustainSecs: 0, recoverSecs: 60, cooldownSecs: 1800 },
          ),
        );
      }
    }
    return settle(s, items);
  },

  sessions: (ctx) => {
    const s = base("sessions", ctx);
    const claude = ctx.data.claude;
    const codex = ctx.data.codex;
    if (!claude && !codex) return s;
    const total =
      (claude?.activeSessions.length ?? 0) + (codex?.activeSessions.length ?? 0);
    s.availability = (claude?.available ?? false) || (codex?.available ?? false);
    s.availabilityReason = s.availability
      ? "At least one agent CLI is installed"
      : "Hidden because neither Claude Code nor Codex was found";
    s.health = s.availability ? "healthy" : "unavailable";
    s.activity = total > 0 ? "active" : "idle";
    s.statusDetail = total > 0 ? `${total} session(s) seen recently` : "No recent sessions";
    // Freshness follows whichever source last succeeded.
    s.freshness = worstOf(ctx, ["claude", "codex"]);
    return s;
  },

  openclaw: (ctx) => {
    const s = base("openclaw", ctx);
    const d = ctx.data.openclaw;
    if (!d) return s;
    s.availability = d.installed || d.reachable;
    s.availabilityReason = d.reachable
      ? `Gateway answering on port ${d.port}`
      : d.installed
        ? `Configured on port ${d.port} but not responding`
        : "Hidden because ~/.openclaw was not found";
    if (!d.installed && !d.reachable) {
      s.health = "unavailable";
      s.statusDetail = "OpenClaw not installed";
      return s;
    }
    const httpOk = d.reachable && (d.httpStatus ?? 500) < 500;
    s.health = httpOk ? "healthy" : d.reachable ? "degraded" : "unavailable";
    s.activity = (d.activeRequests ?? 0) > 0 ? "active" : d.reachable ? "idle" : "stopped";
    s.statusDetail = d.reachable
      ? `HTTP ${d.httpStatus ?? "?"} in ${d.latencyMs ?? "?"} ms`
      : `No response on 127.0.0.1:${d.port}`;
    const items: AttentionItem[] = [];
    if (ctx.rules.gatewayDown.on && d.installed && !d.reachable) {
      items.push(
        item(
          {
            key: "gateway-down",
            cardId: "openclaw",
            ruleId: "gatewayDown",
            severity: "critical",
            title: "OpenClaw gateway is down",
            detail: `Nothing listening on 127.0.0.1:${d.port}`,
            entities: [entityRef("gateway", String(d.port), `OpenClaw :${d.port}`)],
            suggestedActions: ["Check the gateway process", "Open the Control UI"],
            recovered: false,
          },
          ctx.rules.gatewayDown,
        ),
      );
    }
    if (d.errorRate != null) {
      const sev = attentionFromThresholds(d.errorRate * 100, 5, 20, true);
      {
        items.push(
          item(
            {
              key: "gateway-errors",
              cardId: "openclaw",
              ruleId: "gatewayErrors",
              severity: sev,
              title: `Gateway error rate ${(d.errorRate * 100).toFixed(1)}%`,
              value: d.errorRate * 100,
              threshold: sev === "critical" ? 20 : 5,
              entities: [entityRef("gateway", String(d.port), `OpenClaw :${d.port}`)],
              recovered: d.errorRate * 100 < 2,
            },
            { sustainSecs: 60, recoverSecs: 60, cooldownSecs: 900 },
          ),
        );
      }
    }
    return settle(s, items);
  },

  system: (ctx) => {
    const s = base("system", ctx);
    const d = ctx.data.system;
    s.availability = true;
    s.availabilityReason = "Always available — sysinfo reads the local machine";
    if (!d) return s;
    s.health = "healthy";
    s.activity = "active";
    const memPct = d.memTotal > 0 ? (d.memUsed / d.memTotal) * 100 : null;
    const { severity, recovered } = evaluate(ctx.rules.ram, memPct);
    s.statusDetail = `CPU ${d.cpuPercent.toFixed(0)}%, RAM ${memPct?.toFixed(0) ?? "?"}%`;
    const items: AttentionItem[] = [];
    if (memPct != null) {
      items.push(
        item(
          {
            key: "ram",
            cardId: "system",
            ruleId: "ram",
            severity,
            title: `Memory at ${memPct.toFixed(0)}%`,
            detail: "Consider closing idle runtimes",
            value: memPct,
            threshold: severity === "critical" ? ctx.rules.ram.critical : ctx.rules.ram.warn,
            entities: [entityRef("host", "local", "This machine")],
            suggestedActions: ["Review top processes"],
            recovered,
          },
          ctx.rules.ram,
        ),
      );
    }
    return settle(s, items);
  },

  gpu: (ctx) => {
    const s = base("gpu", ctx);
    const d = ctx.data.gpu;
    if (!d) return s;
    s.availability = d.available;
    s.availabilityReason = d.available
      ? `Detected NVIDIA driver ${d.driver ?? ""}`.trim()
      : "Hidden because no supported NVIDIA adapter was found";
    if (!d.available) {
      s.health = "unavailable";
      s.statusDetail = d.error ?? "nvidia-smi not present";
      return s;
    }
    s.health = d.error ? "degraded" : "healthy";
    const g = d.gpus[0];
    s.activity = (g?.utilPercent ?? 0) > 5 ? "active" : "idle";
    s.statusDetail = d.error ?? `${d.gpus.length} adapter(s)`;
    const items: AttentionItem[] = [];
    for (const gpu of d.gpus) {
      const { severity, recovered } = evaluate(ctx.rules.gpuTemp, gpu.tempC);
      if (gpu.tempC != null) {
        items.push(
          item(
            {
              key: `gpu-temp:${gpu.index}`,
              cardId: "gpu",
              ruleId: "gpuTemp",
              severity,
              title: `${gpu.name} at ${gpu.tempC.toFixed(0)}°C`,
              value: gpu.tempC,
              threshold:
                severity === "critical" ? ctx.rules.gpuTemp.critical : ctx.rules.gpuTemp.warn,
              entities: [entityRef("host", "local", "This machine")],
              suggestedActions: ["Check GPU processes"],
              recovered,
            },
            ctx.rules.gpuTemp,
          ),
        );
      }
    }
    return settle(s, items);
  },

  thermals: (ctx) => {
    const s = base("thermals", ctx);
    const d = ctx.data.thermals;
    s.availability = true;
    if (!d) return s;
    s.availabilityReason =
      d.tier === "lhm"
        ? "Detected LibreHardwareMonitor's web server"
        : d.tier === "wmi"
          ? "Falling back to the ACPI thermal zone via WMI"
          : "No CPU sensor readable without elevation";
    s.health = d.tier === "lhm" ? "healthy" : d.tier === "wmi" ? "degraded" : "unavailable";
    s.statusDetail =
      d.tier === "lhm"
        ? `${d.sensorCount} sensors`
        : d.tier === "wmi"
          ? "Motherboard zone only — no per-core temps"
          : "Needs LibreHardwareMonitor";
    const value = d.cpuMaxCoreC ?? d.cpuPackageC ?? d.zoneC;
    const { severity, recovered } = evaluate(ctx.rules.cpuTemp, value);
    const items: AttentionItem[] = [];
    if (value != null) {
      items.push(
        item(
          {
            key: "cpu-temp",
            cardId: "thermals",
            ruleId: "cpuTemp",
            severity,
            title: `CPU at ${value.toFixed(0)}°C`,
            detail: d.throttling ? "Thermal throttling is active" : undefined,
            value,
            threshold:
              severity === "critical" ? ctx.rules.cpuTemp.critical : ctx.rules.cpuTemp.warn,
            entities: [entityRef("host", "local", "This machine")],
            recovered,
          },
          ctx.rules.cpuTemp,
        ),
      );
    }
    return settle(s, items);
  },

  disks: (ctx) => {
    const s = base("disks", ctx);
    const d = ctx.data.disks;
    s.availability = true;
    s.availabilityReason = "Always available — local volumes";
    if (!d) return s;
    s.health = "healthy";
    s.statusDetail = `${d.volumes.length} volume(s)`;
    const items: AttentionItem[] = [];
    for (const v of d.volumes) {
      const freePct = v.total > 0 ? (v.available / v.total) * 100 : null;
      const { severity, recovered } = evaluate(ctx.rules.diskFree, freePct);
      if (freePct != null) {
        items.push(
          item(
            {
              key: `disk-free:${v.mount}`,
              cardId: "disks",
              ruleId: "diskFree",
              severity,
              title: `${v.mount} has ${freePct.toFixed(0)}% free`,
              value: freePct,
              threshold:
                severity === "critical" ? ctx.rules.diskFree.critical : ctx.rules.diskFree.warn,
              entities: [entityRef("host", "local", "This machine")],
              recovered,
            },
            ctx.rules.diskFree,
          ),
        );
      }
      if (v.smartOk === false) {
        items.push(
          item(
            {
              key: `disk-smart:${v.mount}`,
              cardId: "disks",
              ruleId: "diskSmart",
              severity: "critical",
              title: `${v.mount} reports a SMART failure prediction`,
              detail: "Back up this volume",
              entities: [entityRef("host", "local", "This machine")],
              recovered: false,
            },
            { sustainSecs: 0, recoverSecs: 3600, cooldownSecs: 86_400 },
          ),
        );
      }
    }
    return settle(s, items);
  },

  netq: (ctx) => {
    const s = base("netq", ctx);
    const d = ctx.data.netq;
    s.availability = true;
    if (!d) return s;
    s.availabilityReason =
      d.mode === "icmp"
        ? "Measuring with ICMP ping"
        : d.mode === "tcp"
          ? "ICMP blocked — falling back to a TCP:443 probe"
          : "No probe succeeded";
    s.health = d.mode === "none" ? "unavailable" : d.lossPercent > 0 ? "degraded" : "healthy";
    s.statusDetail =
      d.latencyMs != null
        ? `${d.latencyMs.toFixed(0)} ms, ${d.lossPercent.toFixed(0)}% loss`
        : "No response from the probe host";
    const items: AttentionItem[] = [];
    const loss = evaluate(ctx.rules.packetLoss, d.lossPercent);
    {
      items.push(
        item(
          {
            key: "packet-loss",
            cardId: "netq",
            ruleId: "packetLoss",
            severity: loss.severity,
            title: `Network packet loss is ${d.lossPercent.toFixed(0)}%`,
            detail: `Probing over ${d.mode.toUpperCase()}`,
            value: d.lossPercent,
            threshold:
              loss.severity === "critical"
                ? ctx.rules.packetLoss.critical
                : ctx.rules.packetLoss.warn,
            entities: [entityRef("network_interface", d.interfaceName ?? "default", d.interfaceName ?? "Active interface")],
            suggestedActions: ["Run a speed test", "Check Tailscale relay state"],
            recovered: loss.recovered,
          },
          ctx.rules.packetLoss,
        ),
      );
    }
    const lat = evaluate(ctx.rules.latency, d.avgMs ?? d.latencyMs);
    if (d.avgMs != null || d.latencyMs != null) {
      const v = d.avgMs ?? d.latencyMs ?? 0;
      items.push(
        item(
          {
            key: "latency",
            cardId: "netq",
            ruleId: "latency",
            severity: lat.severity,
            title: `Network latency ${v.toFixed(0)} ms`,
            value: v,
            threshold:
              lat.severity === "critical" ? ctx.rules.latency.critical : ctx.rules.latency.warn,
            entities: [],
            recovered: lat.recovered,
          },
          ctx.rules.latency,
        ),
      );
    }
    return settle(s, items);
  },

  ports: (ctx) => {
    const s = base("ports", ctx);
    const d = ctx.data.ports;
    s.availability = true;
    s.availabilityReason = "Always available — enumerates local listening sockets";
    if (!d) return s;
    if (d.error) {
      s.health = "unavailable";
      s.statusDetail = d.error;
      return s;
    }
    s.health = "healthy";
    s.statusDetail = `${d.listeners.length} listening socket(s)`;
    const exposed = d.listeners.filter((l) => l.exposure === "public");
    const items: AttentionItem[] = [];
    if (exposed.length > 0) {
      items.push(
        item(
          {
            key: "ports-public",
            cardId: "ports",
            ruleId: "portsPublic",
            severity: "warning",
            title: `${exposed.length} port(s) bound to all interfaces`,
            detail: exposed
              .slice(0, 4)
              .map((l) => `:${l.port} (${l.process})`)
              .join(", "),
            entities: exposed
              .slice(0, 8)
              .map((l) => entityRef("port", l.port, `:${l.port}`)),
            suggestedActions: ["Inspect the owning process", "Check the firewall rule"],
            recovered: false,
          },
          { sustainSecs: 60, recoverSecs: 60, cooldownSecs: 86_400 },
        ),
      );
    }
    return settle(s, items);
  },

  wsl: (ctx) => {
    const s = base("wsl", ctx);
    const d = ctx.data.wsl;
    if (!d) return s;
    s.availability = d.installed;
    s.availabilityReason = d.installed
      ? `Found ${d.distros.length} distribution(s)`
      : "Hidden because wsl.exe was not found";
    if (!d.installed) {
      s.health = "unavailable";
      s.statusDetail = "WSL not installed";
      return s;
    }
    const running = d.distros.filter((x) => x.state === "Running").length;
    s.health = "healthy";
    s.activity = running > 0 ? "active" : "stopped";
    s.statusDetail = `${running}/${d.distros.length} running`;
    return s;
  },

  battery: (ctx) => {
    const s = base("battery", ctx);
    const d = ctx.data.battery;
    if (!d) return s;
    s.availability = d.present;
    s.availabilityReason = d.present
      ? "Battery detected"
      : "Hidden because this machine has no battery";
    if (!d.present) {
      s.health = "unavailable";
      s.statusDetail = "No battery on this machine";
      return s;
    }
    s.health = "healthy";
    s.activity = d.onAc === false ? "active" : "idle";
    s.statusDetail = `${d.percent ?? "?"}% · ${d.onAc === false ? "on battery" : "plugged in"}`;
    const items: AttentionItem[] = [];
    if (d.percent != null) {
      items.push(
        item(
          {
            key: "battery-low",
            cardId: "battery",
            ruleId: "batteryLow",
            severity:
              d.onAc !== false || d.percent > 20
                ? "normal"
                : d.percent <= 10
                  ? "critical"
                  : "warning",
            title: `Battery at ${d.percent}%`,
            value: d.percent,
            threshold: 20,
            entities: [entityRef("host", "local", "This machine")],
            recovered: d.percent > 30 || d.onAc === true,
          },
          { sustainSecs: 0, recoverSecs: 60, cooldownSecs: 1800 },
        ),
      );
    }
    return settle(s, items);
  },

  uptime: (ctx) => {
    const s = base("uptime", ctx);
    const d = ctx.data.uptime;
    s.availability = true;
    s.availabilityReason = "Always available — read from the OS";
    if (!d) return s;
    s.health = "healthy";
    s.statusDetail = d.rebootPending
      ? `Reboot pending: ${d.reasons.join(", ")}`
      : "No pending reboot";
    const items: AttentionItem[] = [];
    {
      items.push(
        item(
          {
            key: "reboot-pending",
            cardId: "uptime",
            ruleId: "rebootPending",
            severity: d.rebootPending ? "warning" : "normal",
            title: "A reboot is pending",
            detail: d.reasons.join(", ") || "Windows flagged a pending restart",
            entities: [entityRef("host", "local", "This machine")],
            recovered: !d.rebootPending,
          },
          { sustainSecs: 0, recoverSecs: 0, cooldownSecs: 86_400 },
        ),
      );
    }
    return settle(s, items);
  },

  tailscale: (ctx) => {
    const s = base("tailscale", ctx);
    const d = ctx.data.tailscale;
    if (!d) return s;
    s.availability = d.installed;
    s.availabilityReason = d.installed
      ? `Backend state: ${d.state ?? "unknown"}`
      : "Hidden because the tailscale CLI was not found";
    if (!d.installed) {
      s.health = "unavailable";
      s.statusDetail = "Tailscale not installed";
      return s;
    }
    if (d.error) {
      s.health = "degraded";
      s.statusDetail = d.error;
      return s;
    }
    const running = d.state === "Running";
    s.health = running ? "healthy" : "degraded";
    s.activity = running ? "active" : "stopped";
    s.statusDetail = running
      ? d.selfDirect
        ? "Connected over a direct path"
        : `Relayed via DERP ${d.relay ?? "?"}`
      : (d.state ?? "Not running");
    const items: AttentionItem[] = [];
    if (running) {
      items.push(
        item(
          {
            key: "tailscale-relay",
            cardId: "tailscale",
            ruleId: "tailscaleRelay",
            severity: d.selfDirect ? "normal" : "warning",
            title: "Tailscale is relaying instead of connecting directly",
            detail: `DERP region ${d.relay ?? "unknown"} — expect higher latency`,
            entities: [entityRef("host", "local", "This machine")],
            recovered: d.selfDirect,
          },
          { sustainSecs: 120, recoverSecs: 60, cooldownSecs: 3600 },
        ),
      );
    }
    if (d.keyExpiryUnix != null) {
      const daysLeft = (d.keyExpiryUnix - ctx.nowMs / 1000) / 86_400;
      if (daysLeft < 7) {
        items.push(
          item(
            {
              key: "tailscale-key",
              cardId: "tailscale",
              ruleId: "tailscaleKey",
              severity: daysLeft < 2 ? "critical" : "warning",
              title: `Tailscale key expires in ${Math.max(0, daysLeft).toFixed(0)} day(s)`,
              entities: [],
              recovered: daysLeft > 14,
            },
            { sustainSecs: 0, recoverSecs: 0, cooldownSecs: 86_400 },
          ),
        );
      }
    }
    return settle(s, items);
  },

  docker: (ctx) => {
    const s = base("docker", ctx);
    const d = ctx.data.docker;
    if (!d) return s;
    s.availability = d.installed;
    s.availabilityReason = d.installed
      ? d.daemonUp
        ? "Docker daemon is answering"
        : "Docker is installed but the daemon is not running"
      : "Hidden because docker was not found on PATH";
    if (!d.installed) {
      s.health = "unavailable";
      s.statusDetail = "Docker not installed";
      return s;
    }
    if (!d.daemonUp) {
      s.health = "unavailable";
      s.activity = "stopped";
      s.statusDetail = d.error ?? "Daemon not running";
      return s;
    }
    const unhealthy = d.containers.filter((c) => c.health === "unhealthy");
    // Only containers that declare a healthcheck are evaluable at all.
    const withHealth = d.containers.filter((c) => c.health != null);
    s.health = unhealthy.length > 0 ? "degraded" : "healthy";
    s.activity = d.containers.length > 0 ? "active" : "idle";
    s.statusDetail = `${d.containers.length} running`;
    const items: AttentionItem[] = withHealth.map((c) =>
      item(
        {
          key: `container-unhealthy:${c.name}`,
          cardId: "docker",
          ruleId: "containerUnhealthy",
          severity: c.health === "unhealthy" ? "warning" : "normal",
          title: `Container ${c.name} is ${c.health}`,
          detail: c.status,
          entities: [entityRef("container", c.name, c.name)],
          suggestedActions: ["View logs", "Restart container"],
          recovered: c.health === "healthy",
        },
        { sustainSecs: 30, recoverSecs: 60, cooldownSecs: 1800 },
      ),
    );
    return settle(s, items);
  },

  ollama: (ctx) => {
    const s = base("ollama", ctx);
    const d = ctx.data.ollama;
    if (!d) return s;
    s.availability = d.reachable;
    s.availabilityReason = d.reachable
      ? "Ollama answered on its local API port"
      : "Hidden because Ollama is not listening";
    s.health = d.reachable ? "healthy" : "unavailable";
    s.activity = d.loaded.length > 0 ? "active" : "idle";
    s.statusDetail = d.reachable
      ? `${d.loaded.length} model(s) loaded`
      : "Ollama not running";
    return s;
  },

  winget: (ctx) => {
    const s = base("winget", ctx);
    const d = ctx.data.winget;
    if (!d) return s;
    s.availability = d.installed;
    s.availabilityReason = d.installed
      ? "winget is available"
      : "Hidden because winget was not found";
    if (!d.installed) {
      s.health = "unavailable";
      s.statusDetail = "winget not available";
      return s;
    }
    s.health = d.error ? "degraded" : "healthy";
    // A 6-hour cadence means this is cached by design, not stale by accident.
    s.freshness = "cached";
    s.statusDetail = d.error ?? `${d.updates.length} update(s) available`;
    return s;
  },

  speedtest: (ctx) => {
    const s = base("speedtest", ctx);
    s.availability = true;
    s.availabilityReason = "On-demand only — never polled automatically";
    s.health = "healthy";
    s.freshness = "not_measured";
    s.statusDetail = "Run manually; a test uses roughly 33 MB";
    return s;
  },

  mcp: (ctx) => {
    const s = base("mcp", ctx);
    const d = ctx.data.mcp;
    if (!d) return s;
    s.availability = d.servers.length > 0;
    s.availabilityReason =
      d.servers.length > 0
        ? `Found ${d.servers.length} configured server(s)`
        : "Hidden because no MCP servers are configured";
    if (d.servers.length === 0) {
      s.health = "unknown";
      s.statusDetail = "No MCP servers configured";
      return s;
    }
    const running = d.servers.filter((x) => x.running).length;
    // Configured-but-not-running is normal for on-demand servers, so this is
    // activity, not health. Health here only reflects the config being read.
    s.health = "healthy";
    s.activity = running > 0 ? "active" : "idle";
    s.statusDetail = `${running}/${d.servers.length} with a live process`;
    return s;
  },

  procs: (ctx) => {
    const s = base("procs", ctx);
    const d = ctx.data.procs;
    s.availability = true;
    s.availabilityReason = "Always available — scans the local process table";
    if (!d) return s;
    s.health = "healthy";
    s.activity = d.processes.length > 0 ? "active" : "idle";
    const orphans = d.processes.filter((p) => p.orphaned);
    s.statusDetail = `${d.processes.length} runtime process(es)`;
    const items: AttentionItem[] = [];
    if (ctx.rules.orphanProcs.on) {
      items.push(
        item(
          {
            key: "orphan-procs",
            cardId: "procs",
            ruleId: "orphanProcs",
            severity: orphans.length > 0 ? "warning" : "normal",
            title: `${orphans.length} orphan process${orphans.length === 1 ? "" : "es"}`,
            detail: orphans
              .slice(0, 4)
              .map((p) => `${p.label ?? p.name} (pid ${p.pid})`)
              .join(", "),
            value: orphans.length,
            entities: orphans
              .slice(0, 8)
              .map((p) => entityRef("process", p.pid, p.label ?? p.name)),
            suggestedActions: ["Review and clean up orphans"],
            recovered: orphans.length === 0,
          },
          ctx.rules.orphanProcs,
        ),
      );
    }
    return settle(s, items);
  },

  repos: (ctx) => {
    const s = base("repos", ctx);
    const d = ctx.data.repos;
    s.availability = true;
    if (!d) return s;
    s.availabilityReason = d.authenticated
      ? `Following the gh CLI account ${d.login ?? ""}`.trim()
      : "gh CLI is not signed in";
    if (d.error) {
      s.health = "unavailable";
      s.statusDetail = d.error;
      return s;
    }
    s.health = d.authenticated ? "healthy" : "degraded";
    // A 5-minute cadence against a remote API: cached, not live.
    s.freshness = s.freshness === "stale" ? "stale" : "cached";
    const withCi = d.repos.filter((r) => r.ciStatus != null && r.ciStatus !== "none");
    s.statusDetail = d.authenticated
      ? `${d.repos.length} repositories`
      : "Not signed in — run `gh auth login`";
    const items: AttentionItem[] = withCi.map((r) =>
      item(
        {
          key: `ci-failure:${r.repo}`,
          cardId: "repos",
          ruleId: "ciFailure",
          severity: r.ciStatus === "failure" ? "warning" : "normal",
          title: `${r.repo} CI: ${r.ciStatus}`,
          entities: [entityRef("repository", r.repo, r.repo)],
          suggestedActions: ["Open the run on GitHub"],
          recovered: r.ciStatus === "success",
        },
        { sustainSecs: 0, recoverSecs: 0, cooldownSecs: 3600 },
      ),
    );
    return settle(s, items);
  },

  git: (ctx) => {
    const s = base("git", ctx);
    const d = ctx.data.git;
    if (!d) return s;
    s.availability = d.gitAvailable && (d.repos.length > 0 || d.roots.length > 0);
    s.availabilityReason = !d.gitAvailable
      ? "Hidden because git was not found on PATH"
      : d.roots.length === 0
        ? "No repository folders configured yet"
        : `Scanning ${d.roots.length} folder(s)`;
    s.health = d.gitAvailable ? "healthy" : "unavailable";
    s.statusDetail = d.gitAvailable
      ? `${d.repos.length} working cop${d.repos.length === 1 ? "y" : "ies"}`
      : "git not installed";
    return s;
  },

  diag: (ctx) => {
    const s = base("diag", ctx);
    const d = ctx.data.diag;
    s.availability = true;
    s.availabilityReason = "Always available — the HUD measuring itself";
    if (d) {
      s.health = "healthy";
      s.activity = "active";
      s.statusDetail = `${(d.memBytes / (1 << 20)).toFixed(0)} MB, ${d.cpuPercent.toFixed(1)}% CPU`;
    } else {
      s.statusDetail = "The self-diagnostics probe has not reported yet";
    }
    // Failing collectors are read from provenance, not from the payload —
    // deliberately *outside* the `if (d)`. The self-diagnostics probe is
    // itself a collector, so gating this on its payload would silence the
    // alarm in precisely the situation it exists to report.
    const broken = Object.values(ctx.provenance).filter(
      (p) => p.state !== "disabled" && p.consecutiveFailures >= 3,
    );
    const items: AttentionItem[] = [];
    if (ctx.rules.collectorStale.on) {
      items.push(
        item(
          {
            key: "collectors-failing",
            cardId: "diag",
            ruleId: "collectorStale",
            severity: broken.length > 0 ? "warning" : "normal",
            title: `${broken.length} collector(s) failing`,
            detail: broken.map((p) => p.command).join(", "),
            entities: [],
            suggestedActions: ["Open diagnostics"],
            recovered: broken.length === 0,
          },
          ctx.rules.collectorStale,
        ),
      );
    }
    return settle(s, items);
  },
};

function worstOf(ctx: StatusContext, ids: string[]): FreshnessState {
  const states = ids
    .map((id) => ctx.provenance[id])
    .filter(Boolean)
    .map((p) => provenanceFreshness(p, ctx.nowMs));
  if (states.length === 0) return "not_measured";
  // "Best of" here: sessions are live if *either* agent reported recently.
  return states.includes("live") ? "live" : states[0];
}

/**
 * Composite rules span cards, so they are evaluated after every adapter has
 * run rather than inside one of them.
 */
export function deriveCompositeItems(
  statuses: Record<string, CardStatus>,
  ctx: StatusContext,
): AttentionItem[] {
  const out: AttentionItem[] = [];
  if (!ctx.rules.networkAndGateway.on) return out;
  const lossItem = statuses.netq?.attentionItems.find((i) => i.ruleId === "packetLoss");
  const gatewayBad =
    statuses.openclaw?.attentionItems.some(
      (i) => i.ruleId === "gatewayDown" || i.ruleId === "gatewayErrors",
    ) ?? false;
  if (lossItem && gatewayBad) {
    out.push(
      item(
        {
          key: "composite-net-gateway",
          cardId: "netq",
          ruleId: "networkAndGateway",
          severity: "critical",
          title: "Network loss and gateway errors together",
          detail: "Both the link and OpenClaw are degraded — likely one root cause",
          entities: [...lossItem.entities],
          suggestedActions: ["Open network diagnostics", "Check the gateway"],
          recovered: false,
        },
        { sustainSecs: 30, recoverSecs: 60, cooldownSecs: 900 },
      ),
    );
  }
  return out;
}

/** AttentionItem → Observation for the alert engine. */
export function itemsToObservations(items: readonly AttentionItem[]) {
  return items.map((i) => ({
    key: i.key,
    ruleId: i.ruleId,
    cardId: i.cardId,
    title: i.title,
    message: i.detail ?? i.title,
    severity: i.severity as "warning" | "critical",
    recovered: i.recovered ?? false,
    value: i.value,
    threshold: i.threshold,
    entities: i.entities,
    suggestedActions: i.suggestedActions,
    sustainSecs: i.sustainSecs ?? 0,
    recoverSecs: i.recoverSecs ?? 60,
    cooldownSecs: i.cooldownSecs ?? 900,
  }));
}
