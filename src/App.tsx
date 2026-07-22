import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { load, type Store } from "@tauri-apps/plugin-store";
import { disable, enable } from "@tauri-apps/plugin-autostart";

import { CARD_IDS } from "./types";
import type { ActionResult, AuditEntry, SpeedtestResult, UtilMode } from "./types";
import type { Settings, TimeRange } from "./model/settings";
import { TIME_RANGE_MS } from "./model/settings";
import {
  BUILTIN_PROFILE_PRESETS,
  DEFAULT_SETTINGS,
  SETTINGS_VERSION,
  TIME_RANGES,
  applyProfile,
  captureProfile,
  migrateSettings,
} from "./model/settings";
import { useNow, usePageVisible } from "./hooks";
import { COLLECTORS, useCollectors } from "./useCollectors";
import { useCustomCards } from "./useCustomCards";
import { deriveCardStatus, deriveCompositeItems, itemsToObservations } from "./model/cardStatus";
import type { AttentionItem, CardStatus } from "./model/cardStatus";
import { buildEntityGraph } from "./model/entityGraph";
import type { EntityRef } from "./model/entities";
import { ENTITY_HOME_CARD, entityKey } from "./model/entities";
import { Redactor, maskSecrets } from "./model/privacy";
import type { AlertRecord } from "./model/alerts";
import {
  acknowledgeAlert,
  evaluateAlerts,
  openAlerts,
  pruneAlerts,
  snoozeAlert,
} from "./model/alerts";
import type { ActivityEvent } from "./model/events";
import { appendEvents, makeEvent } from "./model/events";
import type { IncidentSnapshot } from "./model/snapshots";
import { buildSnapshot, pruneSnapshots } from "./model/snapshots";
import type { Layout } from "./model/layout";
import {
  collapseRect,
  defaultRectSize,
  expandRect,
  readingOrder,
  resolveLayout,
  visibleLayout,
} from "./model/layout";
import { recordAll, windowed } from "./model/history";
import type { HistoryStore } from "./model/history";
import { buildDiagnosticExport } from "./model/diagnosticsExport";

import { Card } from "./components/Card";
import type { CardAction } from "./components/Card";
import { CardCanvas } from "./components/CardCanvas";
import { Inspector } from "./components/Inspector";
import type { InspectorTarget } from "./components/Inspector";
import { CommandPalette } from "./components/CommandPalette";
import type { PaletteCommand } from "./components/CommandPalette";
import { AlertCenter } from "./components/AlertCenter";
import { Timeline } from "./components/Timeline";
import { EmptyState } from "./components/StatusBits";
import { CustomCardBody, customAttention } from "./components/CustomCard";
import { ClaudeCardBody } from "./components/ClaudeCard";
import { CodexCardBody } from "./components/CodexCard";
import { SessionsCardBody } from "./components/SessionsCard";
import { OpenClawCardBody } from "./components/OpenClawCard";
import { ProcessesCardBody } from "./components/ProcessesCard";
import { ReposCardBody } from "./components/ReposCard";
import { GitCardBody } from "./components/GitCard";
import { DiagnosticsCardBody } from "./components/DiagnosticsCard";
import { SettingsPanel } from "./components/SettingsPanel";
import { DiagnosticsPanel } from "./components/DiagnosticsPanel";
import { SystemCardBody } from "./components/SystemCard";
import { TailscaleCardBody } from "./components/TailscaleCard";
import { DockerCardBody } from "./components/DockerCard";
import {
  BatteryCardBody,
  DisksCardBody,
  fmtGpuSummary,
  GpuCardBody,
  McpCardBody,
  NetQualityCardBody,
  OllamaCardBody,
  PortsCardBody,
  SpeedtestCardBody,
  ThermalsCardBody,
  UptimeCardBody,
  WingetCardBody,
  WslCardBody,
} from "./components/hardware";
import { fmtCost, fmtDuration, fmtTokens } from "./format";

const APP_VERSION = "0.1.0";
const STORE_FILE = "settings.json";

const ACCENT: Record<string, string> = {
  claude: "#d97757", codex: "#6fd3c7", sessions: "#e0a86f", openclaw: "#e05d44",
  system: "#5fd68b", gpu: "#76b900", thermals: "#ff9e64", disks: "#c8a24d",
  netq: "#64c7ff", ports: "#9d8cff", wsl: "#e88f3c", battery: "#8bd65f",
  uptime: "#8aa0b8", tailscale: "#6ea8fe", docker: "#2496ed", ollama: "#d6d6d6",
  winget: "#5fb8d6", speedtest: "#f2c14e", mcp: "#c79bff", procs: "#8aa7ff",
  repos: "#b98aff", git: "#8ad6b0", diag: "#9aa4b2",
};

const DEFAULT_ORDER: string[] = CARD_IDS.map(([id]) => id);

/** Cards that open at double width the first time they are placed. */
const WIDE_CARDS = new Set(["sessions", "procs", "repos", "git", "diag"]);
const DEFAULT_INTERVALS: Record<string, number> = Object.fromEntries(
  Object.entries(COLLECTORS).map(([id, c]) => [id, c.intervalMs]),
);

/** Saved order merged with defaults: saved ids first, new cards appended. */
function fullOrder(saved: string[]): string[] {
  const known = saved.filter((id) => DEFAULT_ORDER.includes(id));
  return [...known, ...DEFAULT_ORDER.filter((id) => !known.includes(id))];
}

interface CardDesc {
  title: string;
  icon: string;
  summary: ReactNode;
  body: ReactNode;
  actions?: CardAction[];
}

type Panel = "none" | "settings" | "alerts" | "timeline" | "export";

interface InternalError {
  at: number;
  source: string;
  message: string;
}

export default function App() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [panel, setPanel] = useState<Panel>("none");
  const [nonce, setNonce] = useState(0);
  const [alerts, setAlerts] = useState<AlertRecord[]>([]);
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [snapshots, setSnapshots] = useState<IncidentSnapshot[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [speedtests, setSpeedtests] = useState<SpeedtestResult[]>([]);
  const [history, setHistory] = useState<HistoryStore>({});
  const [internalErrors, setInternalErrors] = useState<InternalError[]>([]);
  const [inspect, setInspect] = useState<InspectorTarget | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [focusedCard, setFocusedCard] = useState<string | null>(null);
  const [exportText, setExportText] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const [persistence, setPersistence] = useState({
    ok: true,
    lastSavedAt: null as number | null,
    error: null as string | null,
  });

  const storeRef = useRef<Store | null>(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  // 10 s is the coarsest tick that still lets a 20-second dwell timer fire
  // on schedule; every tick re-renders the whole board, so it is the single
  // biggest lever on idle cost.
  const now = useNow(10_000);
  const visible = usePageVisible();

  // Render-rate sampling for the diagnostics card. A ref, not state, so
  // measuring the render loop cannot itself drive the render loop.
  const renderCount = useRef(0);
  renderCount.current += 1;
  const [renderRate, setRenderRate] = useState(0);
  const lastRenderSample = useRef({ at: Date.now(), count: 0 });
  useEffect(() => {
    const id = window.setInterval(() => {
      const nowMs = Date.now();
      const prev = lastRenderSample.current;
      const dt = Math.max(1, nowMs - prev.at) / 1000;
      const rate = Math.round(((renderCount.current - prev.count) / dt) * 10) / 10;
      lastRenderSample.current = { at: nowMs, count: renderCount.current };
      // Only re-render when the rounded rate actually moved: a diagnostics
      // readout must not be the thing that keeps the app busy.
      setRenderRate((prev2) => (prev2 === rate ? prev2 : rate));
    }, 15_000);
    return () => window.clearInterval(id);
  }, []);

  const noteError = useCallback((source: string, message: string) => {
    setInternalErrors((prev) =>
      [{ at: Date.now(), source, message: maskSecrets(message) }, ...prev].slice(0, 50),
    );
  }, []);

  // ---------- persistence ----------
  useEffect(() => {
    void (async () => {
      try {
        const store = await load(STORE_FILE, { autoSave: false });
        storeRef.current = store;
        const saved = await store.get<unknown>("settings");
        if (saved) setSettings(migrateSettings(saved));
        setAlerts((await store.get<AlertRecord[]>("alerts")) ?? []);
        setEvents((await store.get<ActivityEvent[]>("events")) ?? []);
        setSnapshots((await store.get<IncidentSnapshot[]>("snapshots")) ?? []);
        setAudit((await store.get<AuditEntry[]>("audit")) ?? []);
        setSpeedtests((await store.get<SpeedtestResult[]>("speedtests")) ?? []);
      } catch (e) {
        setPersistence({ ok: false, lastSavedAt: null, error: String(e) });
        noteError("store.load", String(e));
      }
    })();
  }, [noteError]);

  const writeKey = useCallback(
    async (key: string, value: unknown) => {
      const store = storeRef.current;
      if (!store) return;
      try {
        await store.set(key, value);
        await store.save();
        setPersistence({ ok: true, lastSavedAt: Date.now(), error: null });
      } catch (e) {
        setPersistence((p) => ({ ...p, ok: false, error: String(e) }));
        noteError(`store.save(${key})`, String(e));
      }
    },
    [noteError],
  );

  const applySettings = useCallback(
    (patch: Partial<Settings>) => {
      setSettings((prev) => {
        const next = { ...prev, ...patch, schemaVersion: SETTINGS_VERSION };
        void (async () => {
          await writeKey("settings", next);
          if (patch.layering !== undefined) await invoke("set_layering", { mode: next.layering });
          if (patch.locked !== undefined) await invoke("set_locked", { locked: next.locked });
          // Opacity is part of the backdrop now, so either change re-applies it.
          if (patch.background !== undefined || patch.bgOpacity !== undefined) {
            await invoke("set_background", {
              mode: next.background,
              opacity: next.bgOpacity ?? (next.background === "acrylic" ? 55 : 97),
            });
          }
          if (patch.autostart !== undefined) {
            try {
              if (next.autostart) await enable();
              else await disable();
            } catch {
              // dev builds have no autostart entry
            }
          }
        })();
        return next;
      });
    },
    [writeKey],
  );

  // ---------- tray events ----------
  useEffect(() => {
    const subs = [
      listen<string>("layering:changed", (e) =>
        setSettings((prev) => {
          const next = { ...prev, layering: e.payload as Settings["layering"] };
          void writeKey("settings", next);
          return next;
        }),
      ),
      listen<boolean>("lock:changed", (e) =>
        setSettings((prev) => {
          const next = { ...prev, locked: e.payload };
          void writeKey("settings", next);
          return next;
        }),
      ),
      listen("hud:refresh", () => setNonce((n) => n + 1)),
    ];
    return () => {
      for (const sub of subs) void sub.then((un) => un());
    };
  }, [writeKey]);

  // ---------- collectors ----------
  const mode = useCallback(
    (id: string): UtilMode => settings.utilities[id] ?? "auto",
    [settings.utilities],
  );
  const isPolled = useCallback((id: string) => mode(id) !== "off", [mode]);

  // Chicken-and-egg: the battery payload comes from a collector, and the
  // collectors' cadence depends on it. Held in state so the first render
  // assumes AC and the intervals widen once the battery card reports.
  const [onBattery, setOnBattery] = useState(false);
  const collectors = useCollectors({ settings, nonce, isPolled, onBattery });
  const custom = useCustomCards(settings.customCards, nonce);
  const bundle = useMemo(
    () => ({ ...collectors.bundle, custom: custom.results }),
    [collectors.bundle, custom.results],
  );
  const provenance = useMemo(
    () => ({ ...collectors.provenance, ...custom.provenance }),
    [collectors.provenance, custom.provenance],
  );
  const refresh = useMemo(
    () => ({
      ...collectors.refresh,
      ...Object.fromEntries(settings.customCards.map((d) => [d.id, () => custom.refresh(d.id)])),
    }),
    [collectors.refresh, custom, settings.customCards],
  );
  useEffect(() => {
    setOnBattery(bundle.battery?.onAc === false);
  }, [bundle.battery?.onAc]);

  const redactor = useMemo(() => new Redactor(settings.privacy), [settings.privacy]);
  // "Live" is the last few minutes; every other range is what it says.
  const sinceMs = now - TIME_RANGE_MS[settings.timeRange];

  // ---------- derived status ----------
  const statuses = useMemo(() => {
    const ctx = { data: bundle, provenance, rules: settings.alerts, nowMs: now };
    const out: Record<string, CardStatus> = {};
    for (const [id] of CARD_IDS) out[id] = deriveCardStatus(id, ctx);
    // Custom cards have no adapter — their status is the contract's `status`
    // field plus whether the run itself succeeded.
    for (const def of settings.customCards) {
      if (!def.enabled) continue;
      const result = bundle.custom[def.id] ?? null;
      out[def.id] = {
        id: def.id,
        health: result == null ? "unknown" : result.ok ? "healthy" : "unavailable",
        attention: customAttention(result),
        freshness: result == null ? "not_measured" : "live",
        availability: true,
        availabilityReason: `Custom card reading from ${def.kind}: ${def.target}`,
        statusDetail: result?.error ?? result?.payload?.message ?? "",
        conditions: [],
        attentionItems: [],
      };
    }
    return out;
  }, [bundle, provenance, settings.alerts, settings.customCards, now]);

  const composites = useMemo(
    () => deriveCompositeItems(statuses, { data: bundle, provenance, rules: settings.alerts, nowMs: now }),
    [statuses, bundle, provenance, settings.alerts, now],
  );

  const graph = useMemo(() => buildEntityGraph(bundle, redactor), [bundle, redactor]);

  const visibleCard = useCallback(
    (id: string): boolean => {
      const m = mode(id);
      if (m === "off") return false;
      if (m === "on") return true;
      return statuses[id]?.availability !== false;
    },
    [mode, statuses],
  );

  // ---------- alert evaluation ----------
  const alertsRef = useRef(alerts);
  alertsRef.current = alerts;
  useEffect(() => {
    const conditions: AttentionItem[] = [
      ...Object.entries(statuses)
        // A card the user turned off must not keep generating alerts.
        .filter(([id]) => mode(id) !== "off")
        .flatMap(([, s]) => s.conditions),
      ...composites,
    ];
    const nowMs = Date.now();
    const result = evaluateAlerts(alertsRef.current, itemsToObservations(conditions), {
      nowMs,
      master: settings.alerts.master,
      quietHours: settings.alerts.quietHours,
      localHour: new Date(nowMs).getHours(),
    });
    if (result.alerts !== alertsRef.current) {
      const pruned = pruneAlerts(result.alerts, settings.retention.alerts);
      setAlerts(pruned);
      void writeKey("alerts", pruned);
    }
    if (result.events.length > 0) {
      setEvents((prev) => {
        const next = appendEvents(prev, result.events, settings.retention.events);
        if (next !== prev) void writeKey("events", next);
        return next;
      });
    }
    for (const a of result.notify) {
      void invoke("send_alert", {
        key: a.key,
        title: redactor.text(a.title) ?? a.title,
        body: redactor.text(a.message) ?? a.message,
      }).catch((e) => noteError("send_alert", String(e)));
    }
    // Auto-snapshot on a *new* critical, not on every re-notify.
    if (settings.autoSnapshot) {
      const fresh = result.notify.find(
        (a) => a.severity === "critical" && a.notifiedSeverity === "critical" && a.state === "active",
      );
      if (fresh && !snapshots.some((s) => s.reason === fresh.title && nowMs - s.atMs < 300_000)) {
        captureSnapshot(fresh.title);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statuses, composites]);

  // ---------- history ----------
  useEffect(() => {
    const nowMs = Date.now();
    setHistory((prev) =>
      recordAll(
        prev,
        {
          "CPU %": bundle.system?.cpuPercent ?? null,
          "Memory %": bundle.system
            ? (bundle.system.memUsed / Math.max(1, bundle.system.memTotal)) * 100
            : null,
          "Latency ms": bundle.netq?.latencyMs ?? null,
          "Packet loss %": bundle.netq?.lossPercent ?? null,
          "CPU °C": bundle.thermals?.cpuMaxCoreC ?? bundle.thermals?.cpuPackageC ?? null,
          "GPU °C": bundle.gpu?.gpus[0]?.tempC ?? null,
          "GPU util %": bundle.gpu?.gpus[0]?.utilPercent ?? null,
          "Disk read B/s": bundle.disks?.readBps ?? null,
          "Disk write B/s": bundle.disks?.writeBps ?? null,
          "Gateway p95 ms": bundle.openclaw?.p95Ms ?? null,
        },
        nowMs,
        settings.retention.historyPoints,
      ),
    );
  }, [bundle, settings.retention.historyPoints]);

  // ---------- events from state changes ----------
  useEffect(() => {
    const incoming: ActivityEvent[] = [];
    const push = (
      category: ActivityEvent["category"],
      severity: ActivityEvent["severity"],
      title: string,
      dedupeKey: string,
      entities: EntityRef[] = [],
    ) => incoming.push(makeEvent({ category, severity, title, dedupeKey, relatedEntities: entities }));

    if (bundle.tailscale?.installed && bundle.tailscale.state === "Running") {
      push(
        "network",
        bundle.tailscale.selfDirect ? "info" : "warning",
        bundle.tailscale.selfDirect
          ? "Tailscale is connected directly"
          : `Tailscale switched to a relay (DERP ${bundle.tailscale.relay ?? "?"})`,
        `tailscale-path=${bundle.tailscale.selfDirect ? "direct" : "relay"}`,
      );
    }
    if (bundle.docker?.daemonUp) {
      for (const c of bundle.docker.containers) {
        if (c.restartCount != null) {
          push(
            "container",
            c.restartCount > 0 ? "warning" : "info",
            `Container ${c.name} restart count is ${c.restartCount}`,
            `container-restarts:${c.name}=${c.restartCount}`,
            [{ kind: "container", id: c.name, label: c.name }],
          );
        }
      }
    }
    for (const repo of bundle.git?.repos ?? []) {
      push(
        "repository",
        "info",
        `${redactor.repo(repo.name)} is ${repo.dirtyCount > 0 ? `dirty (${repo.dirtyCount} files)` : "clean"} on ${repo.branch ?? "detached HEAD"}`,
        `repo-state:${repo.path}=${repo.branch}/${repo.dirtyCount > 0 ? "dirty" : "clean"}`,
        [{ kind: "repository", id: repo.remoteSlug ?? repo.path, label: repo.name }],
      );
    }
    if (bundle.uptime) {
      push(
        "system",
        bundle.uptime.rebootPending ? "warning" : "info",
        bundle.uptime.rebootPending
          ? `Reboot pending: ${bundle.uptime.reasons.join(", ") || "flagged by Windows"}`
          : "No reboot pending",
        `reboot-pending=${bundle.uptime.rebootPending}`,
      );
    }
    if (incoming.length === 0) return;
    setEvents((prev) => {
      const next = appendEvents(prev, incoming, settings.retention.events);
      if (next !== prev) void writeKey("events", next);
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bundle.tailscale, bundle.docker, bundle.git, bundle.uptime]);

  // ---------- snapshots ----------
  const bundleRef = useRef(bundle);
  bundleRef.current = bundle;
  const eventsRef = useRef(events);
  eventsRef.current = events;
  const captureSnapshot = useCallback(
    (reason: string) => {
      const snap = buildSnapshot(reason, bundleRef.current, alertsRef.current, eventsRef.current);
      setSnapshots((prev) => {
        const next = pruneSnapshots(
          [snap, ...prev],
          settingsRef.current.retention.snapshots,
          settingsRef.current.retention.snapshotBytes,
        );
        void writeKey("snapshots", next);
        return next;
      });
      setToast(`Snapshot captured: ${reason}`);
    },
    [writeKey],
  );

  // ---------- operator actions ----------
  const actionsAllowed = useCallback(
    (cardId: string) => settings.actionsEnabled && !settings.cardActionsDisabled[cardId],
    [settings.actionsEnabled, settings.cardActionsDisabled],
  );

  const runAction = useCallback(
    async (
      cardId: string,
      label: string,
      command: string,
      args: Record<string, unknown>,
      target: string,
      entities: EntityRef[] = [],
    ) => {
      if (!actionsAllowed(cardId)) {
        setToast("Actions are disabled for this card in settings");
        return;
      }
      setToast(`${label}…`);
      try {
        const result = await invoke<ActionResult>(command, args);
        setToast(`${label}: ${result.message}`);
        const entry: AuditEntry = {
          id: `${Date.now().toString(36)}-${label}`,
          atUnix: Math.floor(Date.now() / 1000),
          action: label,
          target,
          ok: result.ok,
          code: result.code,
          message: maskSecrets(result.message),
        };
        setAudit((prev) => {
          const next = [entry, ...prev].slice(0, 200);
          void writeKey("audit", next);
          return next;
        });
        setEvents((prev) => {
          const next = appendEvents(
            prev,
            [
              makeEvent({
                category: "user_action",
                severity: result.ok ? "info" : "warning",
                title: `${label} — ${result.ok ? "succeeded" : "failed"}`,
                detail: maskSecrets(result.message),
                relatedEntities: entities,
                // Every invocation is its own event; actions are not polls.
                dedupeKey: `action:${entry.id}`,
              }),
            ],
            settingsRef.current.retention.events,
          );
          void writeKey("events", next);
          return next;
        });
        setNonce((n) => n + 1);
        return result;
      } catch (e) {
        const message = maskSecrets(String(e));
        setToast(`${label} failed: ${message}`);
        noteError(command, message);
        return undefined;
      }
    },
    [actionsAllowed, noteError, writeKey],
  );

  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 6_000);
    return () => window.clearTimeout(id);
  }, [toast]);

  const copyText = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setToast("Copied to clipboard");
    } catch {
      setToast("Clipboard is unavailable in this window");
    }
  }, []);

  // ---------- layout: a free-placement canvas ----------
  //
  // Every card owns a rectangle. Dropping one never reorders or displaces
  // another; it simply cannot land where something else already is.
  const commitLayout = useCallback(
    (layout: Layout) => {
      applySettings({ layout });
      lastDrag.current = Date.now();
    },
    [applySettings],
  );
  /** A drag that starts on the grip ends with a click on the header — this
   *  stops that click from also collapsing the card. */
  const lastDrag = useRef(0);

  const resetSize = useCallback(
    (id: string) => {
      // Forget the rectangle; the canvas re-places the card at its default
      // size in the first free slot on the next render.
      const layout = { ...settingsRef.current.layout };
      delete layout[id];
      applySettings({ layout });
    },
    [applySettings],
  );

  const toggleCard = (id: string) => {
    if (Date.now() - lastDrag.current < 250) return;
    const collapsing = !settings.collapsed[id];
    const rect = layout[id];
    // Folding changes a card's footprint, not just its look: the space it gives
    // up is genuinely free to drop into, and unfolding grows only as far as it
    // still fits rather than reclaiming ground a neighbour has taken.
    const nextRect = rect
      ? collapsing
        ? collapseRect(rect)
        : expandRect(visibleLayout(layout, visibleIds), id, rect)
      : undefined;
    applySettings({
      collapsed: { ...settings.collapsed, [id]: collapsing },
      ...(nextRect ? { layout: { ...settings.layout, [id]: nextRect } } : {}),
    });
  };
  const markSeenRelease = (repo: string, tag: string) =>
    applySettings({ seenReleases: { ...settings.seenReleases, [repo]: tag } });

  // ---------- navigation ----------
  const customIds = useMemo(
    () => settings.customCards.filter((d) => d.enabled).map((d) => d.id),
    [settings.customCards],
  );
  const visibleIds = useMemo(
    () => [...fullOrder(settings.order), ...customIds].filter((id) => visibleCard(id)),
    [settings.order, customIds, visibleCard],
  );

  // The one place the no-overlap invariant is enforced. Cards keep their
  // rectangle wherever it still fits; anything that does not — a card switched
  // back on into space a neighbour has since taken, an imported profile, a
  // hand-edited settings file — is re-placed rather than allowed to collide.
  const layout = useMemo(
    () => resolveLayout(settings.layout, visibleIds, (id) => defaultRectSize(WIDE_CARDS.has(id))),
    [settings.layout, visibleIds],
  );
  useEffect(() => {
    if (layout !== settingsRef.current.layout) applySettings({ layout });
  }, [layout, applySettings]);

  /** Arrow keys and the export follow what the eye follows: top-left first. */
  const shownOrder = useMemo(() => readingOrder(layout, visibleIds), [layout, visibleIds]);

  const focusCard = useCallback((id: string) => {
    setFocusedCard(id);
    setPanel("none");
    const el = document.querySelector(`[data-card-id="${id}"]`) as HTMLElement | null;
    el?.scrollIntoView({ block: "nearest", behavior: "auto" });
    el?.focus();
  }, []);

  const openEntity = useCallback((ref: EntityRef) => {
    setInspect({ kind: "entity", ref });
    setPanel("none");
  }, []);

  // ---------- keyboard ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target?.isContentEditable === true;

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen(true);
        return;
      }
      if (e.key === "/" && !typing) {
        e.preventDefault();
        setPaletteOpen(true);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "r") {
        e.preventDefault();
        setNonce((n) => n + 1);
        setToast("Refreshing all collectors");
        return;
      }
      if (e.key === "Escape") {
        if (paletteOpen) setPaletteOpen(false);
        else if (inspect) setInspect(null);
        else if (panel !== "none") setPanel("none");
        return;
      }
      if (typing || paletteOpen || inspect) return;
      if (e.key === "ArrowDown" || e.key === "ArrowRight") {
        e.preventDefault();
        step(1);
      } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
        e.preventDefault();
        step(-1);
      } else if (e.key === "Enter" && focusedCard) {
        e.preventDefault();
        setInspect({ kind: "card", id: focusedCard });
      }
    };
    const step = (delta: number) => {
      if (shownOrder.length === 0) return;
      const at = focusedCard ? shownOrder.indexOf(focusedCard) : -1;
      const next = shownOrder[Math.max(0, Math.min(shownOrder.length - 1, at + delta))] ?? shownOrder[0];
      focusCard(next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shownOrder, focusedCard, focusCard, paletteOpen, inspect, panel]);

  // ---------- profiles ----------
  const saveProfile = useCallback(
    (name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      const profile = captureProfile(trimmed, settingsRef.current);
      applySettings({
        profiles: { ...settingsRef.current.profiles, [trimmed]: profile },
        activeProfile: trimmed,
      });
      setToast(`Saved profile "${trimmed}"`);
    },
    [applySettings],
  );

  const useProfile = useCallback(
    (name: string) => {
      const existing = settingsRef.current.profiles[name];
      if (existing) {
        applySettings(applyProfile(settingsRef.current, existing));
        setToast(`Applied profile "${name}"`);
        return;
      }
      const preset = BUILTIN_PROFILE_PRESETS[name];
      if (!preset) return;
      // A preset only names the fields it cares about; the rest is kept.
      applySettings({
        ...(preset.utilities ? { utilities: { ...settingsRef.current.utilities, ...preset.utilities } } : {}),
        ...(preset.privacy !== undefined ? { privacy: preset.privacy } : {}),
        activeProfile: name,
      });
      setToast(`Applied preset "${name}"`);
    },
    [applySettings],
  );

  // ---------- diagnostics export ----------
  const buildExport = useCallback(
    (snapshot?: IncidentSnapshot) =>
      buildDiagnosticExport({
        appVersion: APP_VERSION,
        schemaVersion: settingsRef.current.schemaVersion,
        bundle: bundleRef.current,
        statuses,
        provenance,
        alerts: alertsRef.current,
        events: eventsRef.current,
        settings: settingsRef.current,
        snapshot,
        nowMs: Date.now(),
      }),
    [statuses, provenance],
  );

  // ---------- cards ----------
  const openLocalhost = (port: number) =>
    void invoke("open_url", { url: `http://localhost:${port}` });

  const portsByPid = graph.portsByPid;

  const anyNewRelease = (bundle.repos?.repos ?? []).some(
    (r) =>
      r.release &&
      settings.seenReleases[r.repo] !== r.release.tag &&
      r.release.publishedAt &&
      Date.now() - new Date(r.release.publishedAt).getTime() < 14 * 86_400_000,
  );

  const refreshAction = (id: string): CardAction => ({
    label: "Refresh now",
    hint: `Re-run ${COLLECTORS[id]?.command ?? id}`,
    onSelect: () => void refresh[id]?.(),
  });
  const inspectAction = (id: string): CardAction => ({
    label: "Open inspector",
    onSelect: () => setInspect({ kind: "card", id }),
  });
  const commonActions = (id: string): CardAction[] => [
    inspectAction(id),
    ...(refresh[id] ? [refreshAction(id)] : []),
    { label: "Reset size", onSelect: () => resetSize(id) },
    {
      label: "Hide this card",
      onSelect: () => applySettings({ utilities: { ...settingsRef.current.utilities, [id]: "off" } }),
    },
  ];

  const cards: Record<string, CardDesc> = {
    claude: {
      title: "Claude", icon: "✳",
      summary: bundle.claude?.available
        ? `${fmtCost(bundle.claude.todayCostUsd)} · ${fmtTokens(
            bundle.claude.todayTokens.input + bundle.claude.todayTokens.output +
            bundle.claude.todayTokens.cacheWrite + bundle.claude.todayTokens.cacheRead)}`
        : undefined,
      body: <ClaudeCardBody usage={bundle.claude} redactor={redactor} />,
      actions: commonActions("claude"),
    },
    codex: {
      title: "Codex", icon: "⬢",
      summary: bundle.codex?.primary
        ? `${Math.round(bundle.codex.primary.usedPercent)}% ${bundle.codex.primary.label.toLowerCase()}`
        : undefined,
      body: <CodexCardBody usage={bundle.codex} redactor={redactor} />,
      actions: commonActions("codex"),
    },
    sessions: {
      title: "AI sessions", icon: "◐",
      summary: (() => {
        const n =
          (bundle.claude?.activeSessions.length ?? 0) + (bundle.codex?.activeSessions.length ?? 0);
        return n > 0 ? `${n} active` : undefined;
      })(),
      body: (
        <SessionsCardBody
          claude={bundle.claude}
          codex={bundle.codex}
          redactor={redactor}
          actionsEnabled={actionsAllowed("sessions")}
          onOpenRepo={(cwd) =>
            void runAction("sessions", "Open project folder", "open_path_action", { path: cwd }, cwd)
          }
          onInspect={(row) =>
            openEntity({ kind: "agent_session", id: row.id, label: row.name })
          }
        />
      ),
      actions: commonActions("sessions"),
    },
    openclaw: {
      title: "OpenClaw", icon: "🦞",
      summary: bundle.openclaw
        ? bundle.openclaw.reachable
          ? `up · ${bundle.openclaw.latencyMs ?? "?"} ms`
          : bundle.openclaw.installed ? "down" : undefined
        : undefined,
      body: <OpenClawCardBody status={bundle.openclaw} history={history} sinceMs={sinceMs} />,
      actions: commonActions("openclaw"),
    },
    system: {
      title: "System", icon: "⌁",
      summary: bundle.system
        ? `${bundle.system.cpuPercent.toFixed(0)}% cpu · ${(
            (bundle.system.memUsed / Math.max(1, bundle.system.memTotal)) * 100).toFixed(0)}% ram`
        : undefined,
      body: <SystemCardBody health={bundle.system} redactor={redactor} history={history} />,
      actions: commonActions("system"),
    },
    gpu: {
      title: "GPU", icon: "▣",
      summary: fmtGpuSummary(bundle.gpu),
      body: <GpuCardBody status={bundle.gpu} onKilled={() => void refresh.gpu?.()} />,
      actions: commonActions("gpu"),
    },
    thermals: {
      title: "Thermals", icon: "♨",
      summary: (() => {
        const v = bundle.thermals?.cpuPackageC ?? bundle.thermals?.zoneC;
        return v != null ? `${v.toFixed(0)}°C cpu` : undefined;
      })(),
      body: (
        <ThermalsCardBody
          status={bundle.thermals}
          gpuC={bundle.gpu?.gpus[0]?.tempC ?? null}
          history={history}
          onSetup={() => setPanel("settings")}
        />
      ),
      actions: commonActions("thermals"),
    },
    netq: {
      title: "Network", icon: "↯",
      summary: bundle.netq?.latencyMs != null
        ? `${bundle.netq.latencyMs.toFixed(0)}ms${bundle.netq.lossPercent > 0 ? ` · ${bundle.netq.lossPercent.toFixed(0)}% loss` : ""}`
        : undefined,
      body: (
        <NetQualityCardBody
          status={bundle.netq}
          redactor={redactor}
          attention={statuses.netq?.attention ?? "normal"}
          history={history}
        />
      ),
      actions: commonActions("netq"),
    },
    disks: {
      title: "Disks", icon: "▤",
      summary: bundle.disks && bundle.disks.volumes.length > 0 ? `${bundle.disks.volumes.length} volumes` : undefined,
      body: <DisksCardBody status={bundle.disks} history={history} />,
      actions: commonActions("disks"),
    },
    tailscale: {
      title: "Tailscale", icon: "⧉",
      summary: bundle.tailscale?.installed
        ? bundle.tailscale.state === "Running"
          ? (redactor.ip(bundle.tailscale.ip) ?? "connected")
          : (bundle.tailscale.state ?? undefined)?.toLowerCase()
        : undefined,
      body: <TailscaleCardBody status={bundle.tailscale} redactor={redactor} />,
      actions: commonActions("tailscale"),
    },
    docker: {
      title: "Docker", icon: "◫",
      summary: bundle.docker?.daemonUp
        ? `${bundle.docker.containers.length} running`
        : bundle.docker?.installed ? "daemon down" : undefined,
      body: (
        <DockerCardBody
          status={bundle.docker}
          actionsEnabled={actionsAllowed("docker")}
          onLogs={(name) =>
            void runAction("docker", `View logs for ${name}`, "docker_logs_action", { name, lines: 200 }, name)
              .then((r) => {
                if (r?.detail) setExportText(r.detail), setPanel("export");
              })
          }
          onInspect={(name) => openEntity({ kind: "container", id: name, label: name })}
        />
      ),
      actions: commonActions("docker"),
    },
    wsl: {
      title: "WSL", icon: "⌘",
      summary: bundle.wsl?.installed
        ? `${bundle.wsl.distros.filter((d) => d.state === "Running").length}/${bundle.wsl.distros.length} running`
        : undefined,
      body: (
        <WslCardBody
          status={bundle.wsl}
          actionsEnabled={actionsAllowed("wsl")}
          onInspect={(name) => openEntity({ kind: "wsl_distro", id: name, label: name })}
          onOpenTerminal={(name) =>
            void runAction("wsl", `Open terminal in ${name}`, "open_terminal_action", { dir: name }, name)
          }
          onChanged={() => void refresh.wsl?.()}
        />
      ),
      actions: commonActions("wsl"),
    },
    ollama: {
      title: "Ollama", icon: "🦙",
      summary: bundle.ollama?.reachable ? bundle.ollama.loaded[0]?.name ?? "idle" : undefined,
      body: <OllamaCardBody status={bundle.ollama} />,
      actions: commonActions("ollama"),
    },
    battery: {
      title: "Battery", icon: "▮",
      summary: bundle.battery?.present && bundle.battery.percent != null
        ? `${bundle.battery.percent}%${bundle.battery.onAc === false ? " ⚡off" : ""}`
        : undefined,
      body: <BatteryCardBody status={bundle.battery} />,
      actions: commonActions("battery"),
    },
    uptime: {
      title: "Uptime", icon: "◷",
      summary: bundle.uptime
        ? `${fmtDuration(bundle.uptime.uptimeSecs)}${bundle.uptime.rebootPending ? " · reboot!" : ""}`
        : undefined,
      body: <UptimeCardBody status={bundle.uptime} />,
      actions: commonActions("uptime"),
    },
    winget: {
      title: "Updates", icon: "⇪",
      summary: bundle.winget?.installed
        ? bundle.winget.updates.length > 0 ? `${bundle.winget.updates.length} available` : "up to date"
        : undefined,
      body: (
        <WingetCardBody
          status={bundle.winget}
          onRefresh={() => void refresh.winget?.()}
          onCopy={(text) => void copyText(text)}
        />
      ),
      actions: commonActions("winget"),
    },
    speedtest: {
      title: "Speedtest", icon: "≋",
      summary: undefined,
      body: (
        <SpeedtestCardBody
          history={speedtests}
          onCompleted={(r) => {
            setToast(`Speedtest: ${r.downMbps.toFixed(0)} Mbps down`);
            setSpeedtests((prev) => {
              const next = [r, ...prev].slice(0, 20);
              void writeKey("speedtests", next);
              return next;
            });
          }}
        />
      ),
      actions: commonActions("speedtest"),
    },
    mcp: {
      title: "MCP", icon: "⋈",
      summary: bundle.mcp
        ? `${bundle.mcp.servers.filter((s) => s.running).length}/${bundle.mcp.servers.length} up`
        : undefined,
      body: (
        <McpCardBody
          status={bundle.mcp}
          redactor={redactor}
          actionsEnabled={actionsAllowed("mcp")}
          onHealthCheck={(name) =>
            void runAction("mcp", `Health check ${name}`, "mcp_health_check", { name }, name)
          }
          onInspect={(source, name) =>
            openEntity({ kind: "mcp_server", id: `${source}/${name}`, label: name })
          }
        />
      ),
      actions: commonActions("mcp"),
    },
    ports: {
      title: "Ports", icon: "⇌",
      summary: bundle.ports ? `${bundle.ports.listeners.length} listening` : undefined,
      body: (
        <PortsCardBody
          status={bundle.ports}
          redactor={redactor}
          onOpen={openLocalhost}
          onInspect={(port, proto) =>
            openEntity({ kind: "port", id: `${proto}/${port}`, label: `:${port}` })
          }
        />
      ),
      actions: commonActions("ports"),
    },
    procs: {
      title: "Processes", icon: "⚙",
      summary: bundle.procs ? `${bundle.procs.processes.length} running` : undefined,
      body: (
        <ProcessesCardBody
          payload={bundle.procs}
          portsByPid={portsByPid}
          redactor={redactor}
          onInspect={(pid, label) => openEntity({ kind: "process", id: String(pid), label })}
          onOpenPort={openLocalhost}
        />
      ),
      actions: [
        ...commonActions("procs"),
        {
          label: "Clean up orphan processes",
          destructive: true,
          disabled: !actionsAllowed("procs"),
          hint: "Terminates every process whose parent chain is gone, after review",
          onSelect: () => {
            const targets = (bundle.procs?.processes ?? [])
              .filter((p) => p.orphaned && p.killable)
              .map((p) => ({ pid: p.pid, startTimeUnix: p.startTimeUnix }));
            if (targets.length === 0) {
              setToast("No confirmed orphan processes to clean up");
              return;
            }
            void runAction(
              "procs",
              `Terminate ${targets.length} orphan process(es)`,
              "kill_all_processes",
              { targets },
              targets.map((t) => t.pid).join(","),
            );
          },
        },
      ],
    },
    repos: {
      title: bundle.repos?.login ? `Repos · ${redactor.value("user", bundle.repos.login)}` : "Repos",
      icon: "⌥",
      summary: anyNewRelease ? <span className="badge badge-new">NEW release</span> : undefined,
      body: (
        <ReposCardBody
          payload={bundle.repos}
          seen={settings.seenReleases}
          redactor={redactor}
          onInspect={(repo) => openEntity({ kind: "repository", id: repo, label: repo })}
        />
      ),
      actions: commonActions("repos"),
    },
    git: {
      title: "Local repos", icon: "⎇",
      summary: bundle.git ? `${bundle.git.repos.length} working copies` : undefined,
      body: (
        <GitCardBody
          status={bundle.git}
          redactor={redactor}
          actionsEnabled={actionsAllowed("git")}
          onOpenFolder={(path) =>
            void runAction("git", "Open folder", "open_path_action", { path }, path)
          }
          onInspect={(repo) =>
            openEntity({
              kind: "repository",
              id: repo.remoteSlug ?? repo.path,
              label: repo.name,
            })
          }
          onAddRoot={() => setPanel("settings")}
        />
      ),
      actions: commonActions("git"),
    },
    diag: {
      title: "HUD diagnostics", icon: "◎",
      summary: bundle.diag ? `${(bundle.diag.memBytes / (1 << 20)).toFixed(0)} MB` : undefined,
      body: (
        <DiagnosticsCardBody
          diag={bundle.diag}
          provenance={provenance}
          errors={internalErrors}
          persistence={persistence}
          renderCount={renderCount.current}
          renderRateHz={renderRate}
          onRefreshCollector={(id) => void refresh[id]?.()}
        />
      ),
      actions: [
        ...commonActions("diag"),
        {
          label: "Export redacted diagnostics",
          onSelect: () => {
            setExportText(buildExport());
            setPanel("export");
          },
        },
      ],
    },
  };

  // User-defined cards join the same registry as the built-ins, so they get
  // the shared shell, status semantics, inspector and overflow menu for free.
  for (const def of settings.customCards) {
    if (!def.enabled) continue;
    const result = custom.results[def.id] ?? null;
    cards[def.id] = {
      title: def.title || def.id,
      icon: "◈",
      summary: result?.payload?.metrics[0]
        ? `${result.payload.metrics[0].label}: ${result.payload.metrics[0].value}`
        : undefined,
      body: (
        <CustomCardBody
          result={result}
          title={def.title || def.id}
          onRefresh={() => void custom.refresh(def.id)}
        />
      ),
      actions: [
        inspectAction(def.id),
        { label: "Run now", onSelect: () => void custom.refresh(def.id) },
        { label: "Edit in settings", onSelect: () => setPanel("settings") },
      ],
    };
  }

  // ---------- palette commands ----------
  const paletteCommands: PaletteCommand[] = useMemo(() => {
    const out: PaletteCommand[] = [];
    for (const [id, label] of CARD_IDS) {
      out.push({
        id: `focus:${id}`,
        label: `Focus ${label}`,
        group: "Navigate",
        keywords: [id, "card", "show"],
        run: () => focusCard(id),
      });
      out.push({
        id: `inspect:${id}`,
        label: `Inspect ${label}`,
        group: "Navigate",
        keywords: [id, "detail", "open"],
        run: () => setInspect({ kind: "card", id }),
      });
      if (refresh[id]) {
        out.push({
          id: `refresh:${id}`,
          label: `Refresh ${label} collector`,
          group: "Collectors",
          keywords: [id, "poll", "reload"],
          run: () => void refresh[id]?.(),
        });
      }
    }
    out.push(
      {
        id: "refresh:all", label: "Refresh everything", group: "Collectors",
        keywords: ["reload", "poll"], run: () => setNonce((n) => n + 1),
      },
      {
        id: "show:orphans", label: "Show orphan processes", group: "Find",
        keywords: ["orphan", "leftover", "zombie"],
        run: () => {
          focusCard("procs");
          setInspect({ kind: "card", id: "procs" });
        },
      },
      {
        id: "show:stale", label: "Show stale collectors", group: "Find",
        keywords: ["stale", "broken", "failing"],
        run: () => {
          focusCard("diag");
          setInspect({ kind: "card", id: "diag" });
        },
      },
      {
        id: "open:netdiag", label: "Open network diagnostics", group: "Find",
        keywords: ["network", "latency", "loss", "ping"],
        run: () => setInspect({ kind: "card", id: "netq" }),
      },
      {
        id: "run:speedtest", label: "Run a speed test (~33 MB)", group: "Actions",
        keywords: ["bandwidth", "download", "upload"],
        run: () => {
          focusCard("speedtest");
          setToast("Open the Speedtest card and press Run — it uses bandwidth");
        },
      },
      {
        id: "open:alerts", label: "Open alert center", group: "Navigate",
        keywords: ["alarms", "notifications"], run: () => setPanel("alerts"),
      },
      {
        id: "open:timeline", label: "Open event timeline", group: "Navigate",
        keywords: ["history", "events", "log"], run: () => setPanel("timeline"),
      },
      {
        id: "open:settings", label: "Open settings", group: "Navigate",
        keywords: ["preferences", "config"], run: () => setPanel("settings"),
      },
      {
        id: "toggle:privacy",
        label: settings.privacy ? "Turn privacy mode OFF" : "Turn privacy mode ON",
        group: "Actions",
        keywords: ["redact", "screen share", "presentation"],
        run: () => applySettings({ privacy: !settingsRef.current.privacy }),
      },
      {
        id: "copy:diagnostics", label: "Copy a diagnostic summary", group: "Actions",
        keywords: ["export", "clipboard", "report"],
        run: () => void copyText(buildExport()),
      },
      {
        id: "snapshot:now", label: "Capture an incident snapshot", group: "Actions",
        keywords: ["freeze", "capture", "incident"],
        run: () => captureSnapshot("Manual capture"),
      },
    );
    for (const name of Object.keys({ ...BUILTIN_PROFILE_PRESETS, ...settings.profiles })) {
      out.push({
        id: `profile:${name}`, label: `Switch to profile: ${name}`, group: "Profiles",
        keywords: ["layout", "preset"], run: () => useProfile(name),
      });
    }
    out.push({
      id: "orphans:cleanup",
      label: "Terminate all orphan processes",
      group: "Actions",
      destructive: true,
      hint: "Identity-verified; requires a second Enter",
      run: () => cards.procs.actions?.find((a) => a.destructive)?.onSelect(),
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh, settings.privacy, settings.profiles, focusCard, buildExport, captureSnapshot, copyText, useProfile, applySettings]);

  // ---------- inspector data ----------
  const inspectorProps = useMemo(() => {
    if (!inspect) return null;
    if (inspect.kind === "card") {
      const id = inspect.id;
      // Charts honour the global range rather than dumping the whole ring —
      // "1h" has to mean an hour here too, not just in the timeline.
      const relevantHistory = Object.fromEntries(
        Object.entries(history)
          .filter(([name]) => HISTORY_BY_CARD[id]?.includes(name))
          .map(([name, series]) => [
            name,
            { ...series, points: windowed(series, sinceMs) },
          ]),
      );
      return {
        title: cards[id]?.title ?? id,
        status: statuses[id],
        provenance: provenance[id],
        node: undefined,
        events: events.filter((e) => e.relatedEntities.length === 0 || true).slice(0, 20),
        alerts: alerts.filter((a) => a.cardId === id),
        history: relevantHistory,
        actions: cards[id]?.actions ?? [],
      };
    }
    const node = graph.index.get(inspect.ref);
    const key = entityKey(inspect.ref);
    return {
      title: inspect.ref.label,
      status: statuses[ENTITY_HOME_CARD[inspect.ref.kind]],
      provenance: provenance[ENTITY_HOME_CARD[inspect.ref.kind]],
      node,
      events: events.filter((e) => e.relatedEntities.some((r) => entityKey(r) === key)),
      alerts: alerts.filter((a) => a.relatedEntities.some((r) => entityKey(r) === key)),
      history: undefined,
      actions: entityActions(inspect.ref),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inspect, statuses, provenance, events, alerts, history, graph]);

  function entityActions(ref: EntityRef): CardAction[] {
    const list: CardAction[] = [
      { label: "Copy identifier", onSelect: () => void copyText(`${ref.kind}:${ref.id}`) },
      { label: "Focus owning card", onSelect: () => focusCard(ENTITY_HOME_CARD[ref.kind]) },
    ];
    if (ref.kind === "process") {
      const pid = Number(ref.id);
      const proc = bundle.procs?.processes.find((p) => p.pid === pid);
      list.push({
        label: "Open working directory",
        disabled: !proc?.cwd || !actionsAllowed("procs"),
        hint: proc?.cwd ? undefined : "This process reports no working directory",
        onSelect: () =>
          void runAction("procs", "Open working directory", "open_path_action", { path: proc?.cwd }, ref.id),
      });
      list.push({
        label: "Terminate process",
        destructive: true,
        disabled: !proc?.killable || !actionsAllowed("procs"),
        hint: proc?.killable ? "Verified by (pid, start time)" : "Access denied for this process",
        onSelect: () =>
          void runAction("procs", `Terminate pid ${pid}`, "kill_process", {
            pid, startTimeUnix: proc?.startTimeUnix ?? 0, killTree: false,
          }, ref.id, [ref]),
      });
      if ((proc?.childPids.length ?? 0) > 0) {
        list.push({
          label: `Terminate process tree (${(proc?.childPids.length ?? 0) + 1})`,
          destructive: true,
          disabled: !actionsAllowed("procs"),
          onSelect: () =>
            void runAction("procs", `Terminate tree from pid ${pid}`, "kill_process", {
              pid, startTimeUnix: proc?.startTimeUnix ?? 0, killTree: true,
            }, ref.id, [ref]),
        });
      }
    }
    if (ref.kind === "port") {
      const port = Number(ref.id.split("/")[1] ?? ref.id);
      const listener = bundle.ports?.listeners.find((l) => l.port === port);
      const owner = bundle.procs?.processes.find((p) => p.pid === listener?.pid);
      list.push({ label: "Open in browser", onSelect: () => openLocalhost(port) });
      list.push({
        label: "Copy endpoint",
        onSelect: () => void copyText(`http://localhost:${port}`),
      });
      if (listener) {
        list.push({
          label: `Inspect owning process (pid ${listener.pid})`,
          onSelect: () =>
            openEntity({ kind: "process", id: String(listener.pid), label: listener.process }),
        });
        // Freeing a port means stopping its owner — route it through the same
        // identity-verified path the Processes card uses, never a raw kill.
        list.push({
          label: `Terminate owning process (pid ${listener.pid})`,
          destructive: true,
          disabled: !owner?.killable || !actionsAllowed("procs"),
          hint: owner
            ? owner.killable
              ? "Verified by (pid, start time) before terminating"
              : "Access denied for this process"
            : "The owning process is not in the runtime process table",
          onSelect: () =>
            void runAction(
              "procs",
              `Terminate pid ${listener.pid} to free :${port}`,
              "kill_process",
              { pid: listener.pid, startTimeUnix: owner?.startTimeUnix ?? 0, killTree: false },
              String(listener.pid),
              [ref, { kind: "process", id: String(listener.pid), label: listener.process }],
            ),
        });
      }
    }
    if (ref.kind === "container") {
      for (const verb of ["start", "stop", "restart"] as const) {
        list.push({
          label: `${verb[0].toUpperCase()}${verb.slice(1)} container`,
          destructive: verb !== "start",
          disabled: !actionsAllowed("docker"),
          onSelect: () =>
            void runAction("docker", `${verb} container ${ref.id}`, "docker_action", { verb, name: ref.id }, ref.id, [ref]),
        });
      }
    }
    if (ref.kind === "agent_session") {
      const cwd = ref.id.split(":").slice(1).join(":");
      list.push({
        label: "Copy session identifier",
        onSelect: () => void copyText(ref.id),
      });
      list.push({
        label: "Open project folder",
        disabled: !cwd || !actionsAllowed("sessions"),
        hint: cwd ? undefined : "this transcript recorded no working directory",
        onSelect: () =>
          void runAction("sessions", "Open project folder", "open_path_action", { path: cwd }, cwd, [ref]),
      });
    }
    if (ref.kind === "repository") {
      // Everything the repo rows used to carry as labelled buttons.
      const local = bundle.git?.repos.find((r) => (r.remoteSlug ?? r.path) === ref.id);
      const slug = local?.remoteSlug ?? (ref.id.includes("/") && !ref.id.includes("\\") ? ref.id : null);
      if (slug) {
        list.push({
          label: "Open on GitHub",
          onSelect: () => void invoke("open_url", { url: `https://github.com/${slug}` }),
        });
      }
      const gh = bundle.repos?.repos.find((r) => r.repo === ref.id);
      if (gh?.release) {
        const rel = gh.release;
        list.push({
          label: `Open latest release (${rel.tag})`,
          hint: "Opens the release notes and clears the NEW badge",
          onSelect: () => {
            void invoke("open_url", { url: rel.url });
            markSeenRelease(gh.repo, rel.tag);
          },
        });
      }
      if (local) {
        list.push({
          label: "Open project folder",
          disabled: !actionsAllowed("git"),
          onSelect: () =>
            void runAction("git", "Open folder", "open_path_action", { path: local.path }, local.path, [ref]),
        });
        list.push({
          label: "Fetch",
          disabled: !actionsAllowed("git"),
          hint: "git fetch --all --prune — read-only, never merges",
          onSelect: () =>
            void runAction("git", "Fetch", "git_fetch_action", { dir: local.path }, local.path, [ref]),
        });
        list.push({
          label: "View working-tree changes",
          disabled: !actionsAllowed("git"),
          onSelect: () =>
            void runAction("git", "View changes", "git_status_action", { dir: local.path }, local.path, [ref]).then(
              (r) => {
                if (r?.detail) {
                  setExportText(r.detail);
                  setPanel("export");
                }
              },
            ),
        });
        list.push({
          label: local.testCommand ? `Run tests (${local.testCommand})` : "Run tests",
          disabled: !actionsAllowed("git") || !local.testCommand,
          hint: local.testCommand
            ? "Runs the project's declared test command from a fixed allowlist"
            : "No test command was detected in this project",
          onSelect: () =>
            void runAction(
              "git",
              `Run tests (${local.testCommand})`,
              "run_repo_tests_action",
              { dir: local.path, command: local.testCommand },
              local.path,
              [ref],
            ),
        });
      }
    }
    if (ref.kind === "mcp_server") {
      const name = ref.id.split("/").slice(1).join("/") || ref.label;
      list.push({
        label: "Run health check",
        disabled: !actionsAllowed("mcp"),
        hint: "Starts the configured server and completes an MCP handshake — this is not a passive read",
        onSelect: () =>
          void runAction("mcp", `Health check ${name}`, "mcp_health_check", { name }, name, [ref]),
      });
    }
    if (ref.kind === "wsl_distro") {
      list.push({
        label: "Start distribution",
        disabled: !actionsAllowed("wsl"),
        onSelect: () => void runAction("wsl", `Start ${ref.id}`, "wsl_start_action", { name: ref.id }, ref.id, [ref]),
      });
      list.push({
        label: "Terminate distribution",
        destructive: true,
        disabled: !actionsAllowed("wsl"),
        onSelect: () => void runAction("wsl", `Terminate ${ref.id}`, "wsl_terminate_action", { name: ref.id }, ref.id, [ref]),
      });
    }
    return list;
  }

  // ---------- render ----------
  const effOpacity = settings.bgOpacity ?? (settings.background === "acrylic" ? 55 : 97);
  // In acrylic mode DWM paints the tint; the web view stays transparent so the
  // two never composite over each other. Solid mode has no native backdrop, so
  // there the DOM is the only layer and paints it itself.
  const rootBackground =
    settings.background === "acrylic" ? "transparent" : `rgba(12, 14, 20, ${effOpacity / 100})`;
  const open = openAlerts(alerts);
  const staleCount = Object.values(statuses).filter((s) => s.freshness === "stale").length;
  const headerSummary =
    open.length === 0
      ? staleCount > 0
        ? `${staleCount} source${staleCount === 1 ? "" : "s"} stale`
        : "All systems healthy"
      : `${open.filter((a) => a.severity === "critical").length} critical · ${
          open.filter((a) => a.severity !== "critical").length
        } warning`;

  const autoReasons = Object.fromEntries(
    Object.entries(statuses).map(([id, s]) => [id, s.availabilityReason]),
  );
  const collectorNotes = Object.fromEntries(
    Object.entries(provenance)
      .filter(([, p]) => p.lastError != null)
      .map(([id, p]) => [id, `${p.requires ? `Requires ${p.requires}. ` : ""}${maskSecrets(p.lastError ?? "")}`]),
  );

  return (
    <div
      className={`hud hud-${settings.background}${settings.privacy ? " hud-private" : ""}`}
      style={{ background: rootBackground }}
    >
      <header className="hud-head" {...(!settings.locked ? { "data-tauri-drag-region": true } : {})}>
        <span className="logo" {...(!settings.locked ? { "data-tauri-drag-region": true } : {})}>
          ◉ Dev HUD
        </span>
        <button
          className={`head-summary head-summary-${open.some((a) => a.severity === "critical") ? "bad" : open.length ? "warn" : "ok"}`}
          onClick={() => setPanel(panel === "alerts" ? "none" : "alerts")}
          title="Open the alert center"
        >
          {headerSummary}
        </button>
        {settings.privacy && (
          <span className="privacy-flag" title="Privacy mode: addresses, hostnames, paths and repository names are redacted">
            🛡 Privacy on
          </span>
        )}
        <span className="head-spacer" {...(!settings.locked ? { "data-tauri-drag-region": true } : {})} />
        <label className="range-picker">
          <span className="visually-hidden">Time range</span>
          <select
            value={settings.timeRange}
            onChange={(e) => applySettings({ timeRange: e.target.value as TimeRange })}
            title="Time range for history and the timeline. Cards whose source keeps no history stay live."
          >
            {TIME_RANGES.map(([id, label]) => (
              <option key={id} value={id}>{label}</option>
            ))}
          </select>
        </label>
        <button className="icon-btn" title="Search and commands (Ctrl+K)" aria-label="Search and commands" onClick={() => setPaletteOpen(true)}>
          ⌕
        </button>
        <button className="icon-btn" title="Event timeline" aria-label="Event timeline" onClick={() => setPanel(panel === "timeline" ? "none" : "timeline")}>
          ☰
        </button>
        <button className="icon-btn" title="Refresh all collectors (Ctrl+R)" aria-label="Refresh all collectors" onClick={() => setNonce((n) => n + 1)}>
          ⟳
        </button>
        <button
          className={`icon-btn${settings.locked ? " icon-btn-active" : ""}`}
          title={settings.locked ? "Position and layout are locked — click to unlock" : "Lock position and layout"}
          aria-label={settings.locked ? "Unlock position and layout" : "Lock position and layout"}
          aria-pressed={settings.locked}
          onClick={() => applySettings({ locked: !settings.locked })}
        >
          {settings.locked ? "🔒" : "🔓"}
        </button>
        <button
          className={`icon-btn${panel === "settings" ? " icon-btn-active" : ""}`}
          title="Settings"
          aria-label="Settings"
          onClick={() => setPanel(panel === "settings" ? "none" : "settings")}
        >
          ⚙
        </button>
      </header>

      {panel === "settings" ? (
        <SettingsPanel
          settings={settings}
          onChange={applySettings}
          onClose={() => setPanel("none")}
          thermalsTier={bundle.thermals?.tier ?? null}
          autoReasons={autoReasons}
          collectorNotes={collectorNotes}
          defaultIntervals={DEFAULT_INTERVALS}
          onResetCard={resetSize}
          onResetAllCards={() => applySettings({ layout: {}, sizes: {}, collapsed: {}, order: [] })}
          onSaveProfile={saveProfile}
          onApplyProfile={useProfile}
          onDeleteProfile={(name) => {
            const profiles = { ...settingsRef.current.profiles };
            delete profiles[name];
            applySettings({ profiles });
          }}
          onExportProfiles={() => void copyText(JSON.stringify(settings.profiles, null, 2))}
          onImportProfiles={() => setToast("Paste a profile JSON into the clipboard, then use the palette")}
          onExportDiagnostics={() => {
            setExportText(buildExport());
            setPanel("export");
          }}
        />
      ) : panel === "alerts" ? (
        <AlertCenter
          alerts={alerts}
          snapshots={snapshots}
          redactor={redactor}
          nowMs={now}
          onAcknowledge={(id) => {
            const next = acknowledgeAlert(alerts, id);
            setAlerts(next);
            void writeKey("alerts", next);
          }}
          onSnooze={(id, minutes) => {
            const next = snoozeAlert(alerts, id, minutes);
            setAlerts(next);
            void writeKey("alerts", next);
          }}
          onFocusCard={focusCard}
          onCaptureSnapshot={() => captureSnapshot("Manual capture")}
          onOpenSnapshot={(id) => {
            const snap = snapshots.find((s) => s.id === id);
            if (!snap) return;
            setExportText(buildExport(snap));
            setPanel("export");
          }}
          onDeleteSnapshot={(id) => {
            const next = snapshots.filter((s) => s.id !== id);
            setSnapshots(next);
            void writeKey("snapshots", next);
          }}
          onClose={() => setPanel("none")}
        />
      ) : panel === "timeline" ? (
        <Timeline
          events={events}
          redactor={redactor}
          range={settings.timeRange}
          nowMs={now}
          onOpenEntity={openEntity}
          onClose={() => setPanel("none")}
        />
      ) : panel === "export" ? (
        <DiagnosticsPanel
          text={exportText}
          onCopy={() => void copyText(exportText)}
          onClose={() => setPanel("none")}
        />
      ) : (
        <main className="hud-body">
          {!settings.introDismissed && (
            <IntroCard statuses={statuses} onDismiss={() => applySettings({ introDismissed: true })} />
          )}

          <CardCanvas
            ids={shownOrder}
            layout={layout}
            locked={settings.locked}
            onLayoutChange={commitLayout}
          >
            {(id, handlers) => {
              const c = cards[id];
              if (!c) return null;
              const st = statuses[id];
              return (
                <Card
                  id={id}
                  title={c.title}
                  icon={c.icon}
                  accent={ACCENT[id]}
                  summary={c.summary}
                  collapsed={!!settings.collapsed[id]}
                  onToggle={toggleCard}
                  grip={!settings.locked}
                  {...handlers}
                  health={st?.health}
                  attention={st?.attention}
                  freshness={st?.freshness}
                  lastSuccessAt={provenance[id]?.lastSuccessAt ?? null}
                  statusDetail={st?.statusDetail}
                  actions={c.actions}
                  onInspect={(cardId) => setInspect({ kind: "card", id: cardId })}
                  focused={focusedCard === id}
                >
                  {c.body}
                </Card>
              );
            }}
          </CardCanvas>
        </main>
      )}

      {inspect && inspectorProps && (
        <Inspector
          target={inspect}
          title={inspectorProps.title}
          status={inspectorProps.status}
          provenance={inspectorProps.provenance}
          node={inspectorProps.node}
          events={inspectorProps.events}
          alerts={inspectorProps.alerts}
          actions={inspectorProps.actions}
          history={inspectorProps.history}
          redactor={redactor}
          nowMs={now}
          onClose={() => setInspect(null)}
          onNavigate={openEntity}
          onCopyDiagnostics={() => void copyText(buildExport())}
        />
      )}

      {paletteOpen && (
        <CommandPalette
          commands={paletteCommands}
          index={graph.index}
          onClose={() => setPaletteOpen(false)}
          onOpenEntity={openEntity}
        />
      )}

      {toast && (
        <div className="toast" role="status" aria-live="polite">
          {toast}
          <button className="icon-btn" onClick={() => setToast(null)} aria-label="Dismiss message">
            ✕
          </button>
        </div>
      )}

      {!visible && <span className="visually-hidden">HUD hidden — polling reduced</span>}
      <span className="visually-hidden">{audit.length} recorded operator actions</span>
    </div>
  );
}

/** Which history series belong to which card's inspector. */
const HISTORY_BY_CARD: Record<string, string[]> = {
  system: ["CPU %", "Memory %"],
  netq: ["Latency ms", "Packet loss %"],
  thermals: ["CPU °C", "GPU °C"],
  gpu: ["GPU °C", "GPU util %"],
  disks: ["Disk read B/s", "Disk write B/s"],
  openclaw: ["Gateway p95 ms"],
};

function IntroCard({
  statuses,
  onDismiss,
}: {
  statuses: Record<string, CardStatus>;
  onDismiss: () => void;
}) {
  const rows = Object.entries(statuses)
    .filter(([, s]) => s.availability !== undefined)
    .slice(0, 14);
  return (
    <section className="card card-wide">
      <div className="card-head-row">
        <div className="card-head" style={{ cursor: "default" }}>
          <span className="card-icon" aria-hidden="true">✨</span>
          <span className="card-title">Detected on this machine</span>
          <span className="card-summary" />
        </div>
        <button className="icon-btn" title="Dismiss" aria-label="Dismiss the detection summary" onClick={onDismiss}>
          ✕
        </button>
      </div>
      <div className="card-body">
        {rows.length === 0 ? (
          <EmptyState reason="no_data" detail="Still probing your machine." />
        ) : (
          <div className="chip-row">
            {rows.map(([id, s]) => (
              <span key={id} className="chip" title={s.availabilityReason}>
                {id}: {s.availability ? "detected" : "not found"}
              </span>
            ))}
          </div>
        )}
        <div className="muted small">
          Cards auto-hide for anything not detected — hover a chip for the reason. Drag the ⠿ grip
          to arrange cards; press Ctrl+K to search; override visibility per card in ⚙ settings.
        </div>
      </div>
    </section>
  );
}
