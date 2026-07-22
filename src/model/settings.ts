// Application settings: schema, defaults, and forward migrations.
//
// The store holds one blob under "settings". Every shape change bumps
// SETTINGS_VERSION and adds a step to `migrateSettings`, which is pure and
// tested — a user's layout surviving an upgrade is a correctness property,
// not a nicety.

import type { UtilMode } from "../types";
import type { Layout } from "./layout";
import { flowLayout } from "./layout";

export const SETTINGS_VERSION = 4;

/**
 * Cards that used to occupy a double-width grid cell. Pinned here rather than
 * imported from the card registry because it is a fact about the *old* layout,
 * and a migration must not drift when the registry changes.
 */
const LEGACY_WIDE_CARDS = new Set(["procs", "repos", "sessions", "git", "diag"]);

/** Threshold rule with warning/critical tiers, dwell time and hysteresis. */
export interface ThresholdRule {
  on: boolean;
  /** Enter warning at/beyond this value. */
  warn: number;
  /** Enter critical at/beyond this value. */
  critical: number;
  /** Must hold for this long before firing (seconds). 0 = immediate. */
  sustainSecs: number;
  /** Recover only once the value is back past this (hysteresis). */
  recoverAt: number;
  /** …and stays there this long (seconds). */
  recoverSecs: number;
  /** Suppress re-notification for this long unless severity increases. */
  cooldownSecs: number;
  /** false inverts the comparison (free space, battery percent). */
  higherIsWorse: boolean;
}

export interface BoolRule {
  on: boolean;
  sustainSecs: number;
  /** How long the condition must stay false before the alert closes. */
  recoverSecs: number;
  cooldownSecs: number;
}

export interface AlertRules {
  master: boolean;
  /** Suppress non-critical toasts inside the window (local hours). */
  quietHours: { on: boolean; startHour: number; endHour: number };
  gpuTemp: ThresholdRule;
  cpuTemp: ThresholdRule;
  ram: ThresholdRule;
  /** Fires when a volume's FREE percentage drops — higherIsWorse is false. */
  diskFree: ThresholdRule;
  packetLoss: ThresholdRule;
  latency: ThresholdRule;
  gatewayDown: BoolRule;
  orphanProcs: BoolRule;
  collectorStale: BoolRule;
  newRelease: { on: boolean };
  wanChange: { on: boolean };
  /** Composite: packet loss elevated AND the gateway is unhealthy. */
  networkAndGateway: { on: boolean };
}

export interface RetentionSettings {
  /** Max timeline events kept. */
  events: number;
  /** Max alert records kept (recovered ones are pruned first). */
  alerts: number;
  /** Max incident snapshots kept. */
  snapshots: number;
  /** Max total bytes of snapshot JSON. */
  snapshotBytes: number;
  /** Metric history points per series. */
  historyPoints: number;
}

export type TimeRange = "live" | "15m" | "1h" | "24h" | "7d" | "30d";

export const TIME_RANGES: [TimeRange, string][] = [
  ["live", "Live"],
  ["15m", "15m"],
  ["1h", "1h"],
  ["24h", "24h"],
  ["7d", "7d"],
  ["30d", "30d"],
];

export const TIME_RANGE_MS: Record<TimeRange, number> = {
  live: 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 3_600_000,
  "24h": 86_400_000,
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
};

/** Where a custom card gets its JSON payload from. */
export type CustomCardKind = "command" | "http" | "file";

export interface CustomCardDef {
  id: string;
  title: string;
  kind: CustomCardKind;
  /** Executable (kind=command), URL (kind=http), or absolute path (kind=file). */
  target: string;
  /** argv for kind=command. Never joined into a shell string. */
  args: string[];
  intervalMs: number;
  timeoutMs: number;
  /** Hard cap on accepted payload size. */
  maxBytes: number;
  enabled: boolean;
}

/** A named bundle of layout + behaviour the user can switch between. */
export interface Profile {
  name: string;
  utilities: Record<string, UtilMode>;
  order: string[];
  sizes: Record<string, { span?: number; height?: number }>;
  collapsed: Record<string, boolean>;
  pollIntervals: Record<string, number>;
  layout: Layout;
  background?: "acrylic" | "solid";
  bgOpacity?: number | null;
  layering?: "desktop" | "normal" | "top";
  privacy?: boolean;
  alerts?: Partial<AlertRules>;
  notificationsOn?: boolean;
}

export interface Settings {
  schemaVersion: number;
  layering: "desktop" | "normal" | "top";
  locked: boolean;
  autostart: boolean;
  background: "acrylic" | "solid";
  collapsed: Record<string, boolean>;
  /** Per-card visibility mode; absent = "auto". Off cards are not polled. */
  utilities: Record<string, UtilMode>;
  /** Card display order (ids); missing ids append in default order. */
  order: string[];
  /** Per-card size overrides: column span (1|2) and/or fixed height px.
   *  Superseded by `layout` in schema 4; kept so a downgrade still finds it. */
  sizes: Record<string, { span?: number; height?: number }>;
  /** Canvas rectangle per card, in grid units. The board's source of truth. */
  layout: Layout;
  /** Background opacity 15–100; null = per-mode default (55 acrylic / 97 solid). */
  bgOpacity: number | null;
  /** Window position on launch: restore last dragged spot, or pin top-center. */
  launchMode: "remember" | "center";
  /** Last release tag seen per repo — powers the NEW badge. */
  seenReleases: Record<string, string>;
  lhmPort: number;
  pingHost: string;
  ollamaPort: number;
  alerts: AlertRules;
  introDismissed: boolean;

  // ---- added in schema 2 ----
  /** Redacts addresses, hostnames, paths, repo names everywhere. */
  privacy: boolean;
  /** Per-card poll interval overrides in ms; absent = card default. */
  pollIntervals: Record<string, number>;
  /** Multiply intervals while the HUD is hidden behind other windows. */
  hiddenSlowdown: number;
  /** Skip bandwidth/CPU-heavy collectors while on battery. */
  pauseExpensiveOnBattery: boolean;
  retention: RetentionSettings;
  timeRange: TimeRange;
  /** Master switch for every state-changing operator action. */
  actionsEnabled: boolean;
  /** Per-card action opt-out. */
  cardActionsDisabled: Record<string, boolean>;
  profiles: Record<string, Profile>;
  activeProfile: string | null;
  /** Directories scanned for git repositories. */
  repoRoots: string[];
  customCards: CustomCardDef[];
  /** Temperature display unit. */
  tempUnit: "c" | "f";
  /** Capture an incident snapshot automatically when a critical alert opens. */
  autoSnapshot: boolean;
}

export const DEFAULT_THRESHOLDS: Record<
  "gpuTemp" | "cpuTemp" | "ram" | "diskFree" | "packetLoss" | "latency",
  ThresholdRule
> = {
  gpuTemp: {
    on: true, warn: 80, critical: 88, sustainSecs: 30,
    recoverAt: 75, recoverSecs: 60, cooldownSecs: 900, higherIsWorse: true,
  },
  cpuTemp: {
    on: true, warn: 90, critical: 97, sustainSecs: 30,
    recoverAt: 85, recoverSecs: 60, cooldownSecs: 900, higherIsWorse: true,
  },
  ram: {
    on: true, warn: 88, critical: 95, sustainSecs: 60,
    recoverAt: 80, recoverSecs: 120, cooldownSecs: 900, higherIsWorse: true,
  },
  diskFree: {
    on: true, warn: 10, critical: 5, sustainSecs: 0,
    recoverAt: 15, recoverSecs: 60, cooldownSecs: 3600, higherIsWorse: false,
  },
  packetLoss: {
    on: true, warn: 5, critical: 12, sustainSecs: 90,
    recoverAt: 2, recoverSecs: 60, cooldownSecs: 900, higherIsWorse: true,
  },
  latency: {
    on: false, warn: 150, critical: 400, sustainSecs: 90,
    recoverAt: 100, recoverSecs: 60, cooldownSecs: 900, higherIsWorse: true,
  },
};

export const DEFAULT_ALERTS: AlertRules = {
  master: true,
  quietHours: { on: false, startHour: 23, endHour: 7 },
  ...DEFAULT_THRESHOLDS,
  gatewayDown: { on: true, sustainSecs: 20, recoverSecs: 15, cooldownSecs: 900 },
  orphanProcs: { on: false, sustainSecs: 300, recoverSecs: 60, cooldownSecs: 3600 },
  collectorStale: { on: true, sustainSecs: 120, recoverSecs: 60, cooldownSecs: 1800 },
  newRelease: { on: true },
  wanChange: { on: false },
  networkAndGateway: { on: true },
};

export const DEFAULT_RETENTION: RetentionSettings = {
  events: 500,
  alerts: 200,
  snapshots: 10,
  snapshotBytes: 4_000_000,
  historyPoints: 240,
};

export const DEFAULT_SETTINGS: Settings = {
  schemaVersion: SETTINGS_VERSION,
  layering: "desktop",
  locked: false,
  autostart: true,
  background: "acrylic",
  collapsed: {},
  utilities: {},
  order: [],
  sizes: {},
  layout: {},
  bgOpacity: null,
  launchMode: "remember",
  seenReleases: {},
  lhmPort: 8085,
  pingHost: "1.1.1.1",
  ollamaPort: 11434,
  alerts: DEFAULT_ALERTS,
  introDismissed: false,
  privacy: false,
  pollIntervals: {},
  hiddenSlowdown: 4,
  pauseExpensiveOnBattery: true,
  retention: DEFAULT_RETENTION,
  timeRange: "live",
  actionsEnabled: true,
  cardActionsDisabled: {},
  profiles: {},
  activeProfile: null,
  repoRoots: [],
  customCards: [],
  tempUnit: "c",
  autoSnapshot: true,
};

// ---------- migrations ----------

/** Pre-v2 threshold rule: a single number with no tiers or dwell time. */
interface LegacyThreshold {
  on?: boolean;
  threshold?: number;
}

type LegacySettings = Partial<Settings> & {
  /** v0: per-card booleans, superseded by `utilities` tri-state. */
  enabled?: Record<string, boolean>;
  alerts?: Record<string, unknown>;
};

/**
 * Bring a stored blob of any past shape up to SETTINGS_VERSION.
 *
 * Unknown keys are preserved, missing ones defaulted; the function never
 * throws, because a settings file that fails to parse must degrade to
 * defaults rather than block startup.
 */
export function migrateSettings(raw: unknown): Settings {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_SETTINGS };
  const saved = raw as LegacySettings;
  const from = typeof saved.schemaVersion === "number" ? saved.schemaVersion : 1;

  const utilities: Record<string, UtilMode> = { ...(saved.utilities ?? {}) };
  // v0 → v1: `enabled: {id: false}` meant "hide"; tri-state calls that "off".
  if (saved.enabled) {
    for (const [id, on] of Object.entries(saved.enabled)) {
      if (!on && utilities[id] === undefined) utilities[id] = "off";
    }
  }

  const alerts = migrateAlerts(saved.alerts, from);

  // v3 → v4: the board stopped being an ordered flow and became a canvas.
  // Replay the old order through the same left-to-right shelf packing the grid
  // used, so the first launch after the upgrade looks like the last one before.
  const order = Array.isArray(saved.order) ? saved.order : [];
  const sizes = saved.sizes ?? {};
  const layout =
    saved.layout && Object.keys(saved.layout).length > 0
      ? saved.layout
      : flowLayout(order, sizes, (id) => LEGACY_WIDE_CARDS.has(id));

  const next: Settings = {
    ...DEFAULT_SETTINGS,
    ...(saved as Partial<Settings>),
    schemaVersion: SETTINGS_VERSION,
    utilities,
    order,
    sizes,
    layout,
    collapsed: saved.collapsed ?? {},
    seenReleases: saved.seenReleases ?? {},
    alerts,
    pollIntervals: saved.pollIntervals ?? {},
    retention: { ...DEFAULT_RETENTION, ...(saved.retention ?? {}) },
    cardActionsDisabled: saved.cardActionsDisabled ?? {},
    profiles: saved.profiles ?? {},
    repoRoots: Array.isArray(saved.repoRoots) ? saved.repoRoots : [],
    customCards: Array.isArray(saved.customCards) ? saved.customCards : [],
  };
  // `enabled` is fully absorbed by `utilities`; drop it so it can't resurface.
  delete (next as LegacySettings).enabled;
  return next;
}

function migrateAlerts(raw: unknown, fromVersion: number): AlertRules {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_ALERTS };
  const saved = raw as Record<string, unknown>;
  const out: AlertRules = { ...DEFAULT_ALERTS };

  if (typeof saved.master === "boolean") out.master = saved.master;
  if (isObject(saved.quietHours)) {
    out.quietHours = { ...out.quietHours, ...(saved.quietHours as object) };
  }

  for (const key of Object.keys(DEFAULT_THRESHOLDS) as (keyof typeof DEFAULT_THRESHOLDS)[]) {
    const stored = saved[key];
    if (!isObject(stored)) continue;
    if (fromVersion < 2 || !("warn" in stored)) {
      // v1: {on, threshold} — the single number becomes the critical tier and
      // the warning tier lands a proportional step below it, preserving the
      // user's intent ("tell me at 85°C") while adding the earlier heads-up.
      const legacy = stored as LegacyThreshold;
      const base = DEFAULT_THRESHOLDS[key];
      const critical = typeof legacy.threshold === "number" ? legacy.threshold : base.critical;
      const gap = Math.abs(base.critical - base.warn);
      out[key] = {
        ...base,
        on: legacy.on ?? base.on,
        critical,
        warn: base.higherIsWorse ? critical - gap : critical + gap,
        recoverAt: base.higherIsWorse ? critical - gap * 1.5 : critical + gap * 1.5,
      };
    } else {
      out[key] = { ...DEFAULT_THRESHOLDS[key], ...(stored as Partial<ThresholdRule>) };
    }
  }

  for (const key of ["gatewayDown", "orphanProcs", "collectorStale"] as const) {
    const stored = saved[key];
    if (isObject(stored)) out[key] = { ...DEFAULT_ALERTS[key], ...(stored as Partial<BoolRule>) };
  }
  for (const key of ["newRelease", "wanChange", "networkAndGateway"] as const) {
    const stored = saved[key];
    if (isObject(stored) && typeof (stored as { on?: unknown }).on === "boolean") {
      out[key] = { on: (stored as { on: boolean }).on };
    }
  }
  return out;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

// ---------- profiles ----------

export const BUILTIN_PROFILE_PRESETS: Record<string, Partial<Profile>> = {
  "AI development": {
    utilities: {
      claude: "on", codex: "on", openclaw: "on", sessions: "on", mcp: "on",
      procs: "on", repos: "on", ports: "on",
      gpu: "off", thermals: "off", disks: "off", battery: "off", winget: "off",
      speedtest: "off", uptime: "off", ollama: "auto", wsl: "auto",
    },
  },
  "Network diagnostics": {
    utilities: {
      netq: "on", speedtest: "on", tailscale: "on", ports: "on", system: "on",
      claude: "off", codex: "off", sessions: "off", gpu: "off", thermals: "off",
      disks: "off", winget: "off", repos: "off", mcp: "off",
    },
  },
  "Performance & thermals": {
    utilities: {
      system: "on", thermals: "on", gpu: "on", disks: "on", procs: "on", diag: "on",
      claude: "off", codex: "off", repos: "off", mcp: "off", winget: "off",
      speedtest: "off", tailscale: "off",
    },
  },
  "Repository maintenance": {
    utilities: {
      repos: "on", procs: "on", sessions: "on", winget: "on",
      gpu: "off", thermals: "off", netq: "off", speedtest: "off",
      tailscale: "off", disks: "off", battery: "off",
    },
  },
  "Presentation / privacy": { privacy: true },
  "Minimal ambient": {
    utilities: {
      system: "on", claude: "on", codex: "on",
      gpu: "off", thermals: "off", disks: "off", netq: "off", ports: "off",
      wsl: "off", battery: "off", uptime: "off", tailscale: "off", docker: "off",
      ollama: "off", winget: "off", speedtest: "off", mcp: "off", procs: "off",
      repos: "off", sessions: "off", diag: "off",
    },
  },
};

/** Snapshot the current settings into a profile. */
export function captureProfile(name: string, s: Settings): Profile {
  return {
    name,
    utilities: { ...s.utilities },
    order: [...s.order],
    sizes: { ...s.sizes },
    layout: { ...s.layout },
    collapsed: { ...s.collapsed },
    pollIntervals: { ...s.pollIntervals },
    background: s.background,
    bgOpacity: s.bgOpacity,
    layering: s.layering,
    privacy: s.privacy,
    alerts: s.alerts,
  };
}

/** Fields a profile is allowed to change; everything else is left alone. */
export function applyProfile(s: Settings, p: Profile): Settings {
  return {
    ...s,
    utilities: { ...p.utilities },
    order: [...p.order],
    sizes: { ...p.sizes },
    layout: { ...(p.layout ?? {}) },
    collapsed: { ...p.collapsed },
    pollIntervals: { ...p.pollIntervals },
    ...(p.background ? { background: p.background } : {}),
    ...(p.bgOpacity !== undefined ? { bgOpacity: p.bgOpacity } : {}),
    ...(p.layering ? { layering: p.layering } : {}),
    ...(p.privacy !== undefined ? { privacy: p.privacy } : {}),
    ...(p.alerts ? { alerts: { ...s.alerts, ...p.alerts } } : {}),
    activeProfile: p.name,
  };
}
