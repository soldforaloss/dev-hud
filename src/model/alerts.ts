// Persistent, stateful alerts.
//
// The hard part of alerting is not the comparison, it is everything around it:
// a threshold crossed for one poll is noise, a threshold un-crossed for one
// poll is not a recovery, and re-notifying every cycle trains people to
// ignore the toasts. This module owns dwell time, hysteresis, cooldown,
// dedupe, quiet hours, acknowledgement and snooze. It is pure — same inputs,
// same outputs — so all of that is testable without a clock or a UI.

import type { EntityRef } from "./entities";
import type { ActivityEvent } from "./events";
import { makeEvent } from "./events";

export type AlertSeverity = "info" | "warning" | "critical";
export type AlertState = "active" | "acknowledged" | "snoozed" | "recovered";

export interface AlertRecord {
  id: string;
  ruleId: string;
  /** Card that owns this condition — the strip navigates back to it. */
  cardId: string;
  /** Dedupe identity: one record per rule *instance* (per GPU, per volume). */
  key: string;
  severity: AlertSeverity;
  state: AlertState;
  title: string;
  message: string;
  firstSeenAt: string;
  lastSeenAt: string;
  recoveredAt?: string;
  currentValue?: unknown;
  threshold?: unknown;
  relatedEntities: EntityRef[];
  suggestedActions?: string[];

  // --- engine bookkeeping (persisted so restarts don't re-fire everything) ---
  /** False while the condition is true but hasn't held for `sustainSecs`. */
  armed: boolean;
  /** When the raw condition first went non-normal in this episode. */
  pendingSinceMs?: number;
  /** When the value first re-entered the recovery band. */
  recoveringSinceMs?: number;
  lastNotifiedAtMs?: number;
  notifiedSeverity?: AlertSeverity;
  snoozedUntilMs?: number;
  ackedAtMs?: number;
}

/**
 * One evaluated condition for one instance, produced by the cards.
 *
 * `severity` is the *raw* verdict for this instant; `recovered` is the
 * hysteresis band, which is deliberately not the inverse of `severity` — the
 * gap between them is what stops flapping.
 */
export interface Observation {
  key: string;
  ruleId: string;
  cardId: string;
  title: string;
  message: string;
  severity: AlertSeverity | "normal";
  recovered: boolean;
  value?: unknown;
  threshold?: unknown;
  entities?: EntityRef[];
  suggestedActions?: string[];
  sustainSecs: number;
  recoverSecs: number;
  cooldownSecs: number;
}

export interface EvaluateOptions {
  nowMs: number;
  master: boolean;
  quietHours: { on: boolean; startHour: number; endHour: number };
  /** Local hour 0–23; injected so tests don't depend on the wall clock. */
  localHour: number;
  /** Drop an armed alert whose source stopped reporting for this long. */
  orphanTimeoutMs?: number;
}

export interface EvaluateResult {
  alerts: AlertRecord[];
  /** Records that should raise a toast right now. */
  notify: AlertRecord[];
  events: ActivityEvent[];
}

const SEVERITY_RANK: Record<AlertSeverity, number> = { info: 0, warning: 1, critical: 2 };

export function severityRank(s: AlertSeverity): number {
  return SEVERITY_RANK[s];
}

/** Quiet hours may wrap midnight (23 → 7). */
export function inQuietHours(
  hour: number,
  q: { on: boolean; startHour: number; endHour: number },
): boolean {
  if (!q.on) return false;
  if (q.startHour === q.endHour) return false;
  return q.startHour < q.endHour
    ? hour >= q.startHour && hour < q.endHour
    : hour >= q.startHour || hour < q.endHour;
}

let alertSeq = 0;

/**
 * Fold this cycle's observations into the persisted alert set.
 *
 * Never mutates `prev`; returns a new array so React state updates cleanly.
 */
export function evaluateAlerts(
  prev: readonly AlertRecord[],
  observations: readonly Observation[],
  opts: EvaluateOptions,
): EvaluateResult {
  const { nowMs, master, orphanTimeoutMs = 600_000 } = opts;
  const quiet = inQuietHours(opts.localHour, opts.quietHours);
  const byKey = new Map(prev.map((a) => [a.key, a]));
  const seen = new Set<string>();
  const out: AlertRecord[] = [];
  const notify: AlertRecord[] = [];
  const events: ActivityEvent[] = [];

  for (const obs of observations) {
    seen.add(obs.key);
    const existing = byKey.get(obs.key);
    const record = stepOne(existing, obs, nowMs, notify, events, { master, quiet });
    if (record) out.push(record);
  }

  // Records whose observation vanished — a collector went away, a volume was
  // unmounted, a container was removed. Held briefly (the source may come
  // back next poll), then closed as recovered rather than left forever.
  for (const a of prev) {
    if (seen.has(a.key)) continue;
    const lastSeen = Date.parse(a.lastSeenAt);
    if (a.state === "recovered" || nowMs - lastSeen > orphanTimeoutMs) {
      if (a.state !== "recovered" && a.armed) {
        events.push(
          makeEvent(
            {
              category: "alert",
              severity: "info",
              title: `${a.title} cleared`,
              detail: "Source stopped reporting this condition",
              relatedEntities: a.relatedEntities,
              dedupeKey: `alert:${a.key}=recovered`,
            },
            nowMs,
          ),
        );
      }
      out.push(
        a.state === "recovered"
          ? a
          : { ...a, state: "recovered", recoveredAt: new Date(nowMs).toISOString() },
      );
    } else {
      out.push(a);
    }
  }

  // Return the *same array reference* when nothing actually changed. The UI
  // re-derives card status from a fresh object every render, so handing back a
  // new-but-equal array here would feed a setState→render→evaluate loop.
  const unchanged =
    out.length === prev.length && out.every((a, i) => a === prev[i]);
  return { alerts: unchanged ? (prev as AlertRecord[]) : out, notify, events };
}

function stepOne(
  existing: AlertRecord | undefined,
  obs: Observation,
  nowMs: number,
  notify: AlertRecord[],
  events: ActivityEvent[],
  gate: { master: boolean; quiet: boolean },
): AlertRecord | null {
  const nowIso = new Date(nowMs).toISOString();
  const triggering = obs.severity !== "normal";

  // ---- nothing wrong, nothing recorded ----
  if (!triggering && (!existing || existing.state === "recovered")) {
    return existing ?? null;
  }

  // ---- new episode ----
  if (!existing || existing.state === "recovered") {
    const severity = obs.severity as AlertSeverity;
    alertSeq += 1;
    const armed = obs.sustainSecs <= 0;
    const record: AlertRecord = {
      id: `${nowMs.toString(36)}-${alertSeq.toString(36)}`,
      ruleId: obs.ruleId,
      cardId: obs.cardId,
      key: obs.key,
      severity,
      state: "active",
      title: obs.title,
      message: obs.message,
      firstSeenAt: nowIso,
      lastSeenAt: nowIso,
      currentValue: obs.value,
      threshold: obs.threshold,
      relatedEntities: obs.entities ?? [],
      ...(obs.suggestedActions ? { suggestedActions: obs.suggestedActions } : {}),
      armed,
      pendingSinceMs: nowMs,
    };
    if (armed) fire(record, nowMs, notify, events, gate);
    return record;
  }

  // ---- ongoing episode ----
  const next: AlertRecord = {
    ...existing,
    lastSeenAt: nowIso,
    message: obs.message,
    currentValue: obs.value,
    threshold: obs.threshold,
    relatedEntities: obs.entities ?? existing.relatedEntities,
  };

  // A snooze that has run out returns the alert to active.
  if (next.state === "snoozed" && next.snoozedUntilMs != null && nowMs >= next.snoozedUntilMs) {
    next.state = "active";
    next.snoozedUntilMs = undefined;
  }

  if (triggering) {
    const severity = obs.severity as AlertSeverity;
    next.recoveringSinceMs = undefined;
    next.pendingSinceMs ??= nowMs;

    // Dwell: hold fire until the condition has persisted long enough.
    if (!next.armed && nowMs - (next.pendingSinceMs ?? nowMs) >= obs.sustainSecs * 1000) {
      next.armed = true;
      next.severity = severity;
      fire(next, nowMs, notify, events, gate);
      return next;
    }

    const escalated = SEVERITY_RANK[severity] > SEVERITY_RANK[next.severity];
    next.severity = severity;
    if (!next.armed) return next;

    if (escalated) {
      // An escalation is news regardless of cooldown, ack or snooze.
      next.state = "active";
      next.ackedAtMs = undefined;
      next.snoozedUntilMs = undefined;
      fire(next, nowMs, notify, events, gate);
      return next;
    }

    const cooled =
      next.lastNotifiedAtMs == null || nowMs - next.lastNotifiedAtMs >= obs.cooldownSecs * 1000;
    if (next.state === "active" && cooled) fire(next, nowMs, notify, events, gate);
    return next;
  }

  // ---- value is back below the threshold ----
  if (!obs.recovered) {
    // In the hysteresis dead-band: no longer triggering, not yet recovered.
    next.recoveringSinceMs = undefined;
    return next;
  }
  next.recoveringSinceMs ??= nowMs;
  if (nowMs - next.recoveringSinceMs < obs.recoverSecs * 1000) return next;

  next.state = "recovered";
  next.recoveredAt = nowIso;
  next.armed = false;
  next.pendingSinceMs = undefined;
  next.recoveringSinceMs = undefined;
  events.push(
    makeEvent(
      {
        category: "alert",
        severity: "info",
        title: `${next.title} recovered`,
        detail: next.message,
        relatedEntities: next.relatedEntities,
        dedupeKey: `alert:${next.key}=recovered`,
      },
      nowMs,
    ),
  );
  // Recovery notifications are always worth delivering, quiet hours included:
  // "it's fixed" is the message people most want after being woken.
  if (gate.master) notify.push(next);
  return next;
}

function fire(
  record: AlertRecord,
  nowMs: number,
  notify: AlertRecord[],
  events: ActivityEvent[],
  gate: { master: boolean; quiet: boolean },
): void {
  events.push(
    makeEvent(
      {
        category: "alert",
        severity: record.severity === "critical" ? "critical" : "warning",
        title: record.title,
        detail: record.message,
        relatedEntities: record.relatedEntities,
        dedupeKey: `alert:${record.key}=${record.severity}`,
      },
      nowMs,
    ),
  );
  if (!gate.master) return;
  // Quiet hours hold back warnings; a critical still gets through.
  if (gate.quiet && record.severity !== "critical") return;
  record.lastNotifiedAtMs = nowMs;
  record.notifiedSeverity = record.severity;
  notify.push(record);
}

// ---------- user actions on alerts ----------

export function acknowledgeAlert(alerts: readonly AlertRecord[], id: string, nowMs = Date.now()) {
  return alerts.map((a) =>
    a.id === id && a.state !== "recovered"
      ? { ...a, state: "acknowledged" as AlertState, ackedAtMs: nowMs }
      : a,
  );
}

export function snoozeAlert(
  alerts: readonly AlertRecord[],
  id: string,
  minutes: number,
  nowMs = Date.now(),
) {
  return alerts.map((a) =>
    a.id === id && a.state !== "recovered"
      ? { ...a, state: "snoozed" as AlertState, snoozedUntilMs: nowMs + minutes * 60_000 }
      : a,
  );
}

/** Retention: recovered alerts are dropped first, then the oldest. */
export function pruneAlerts(alerts: readonly AlertRecord[], cap: number): AlertRecord[] {
  if (alerts.length <= cap) return alerts as AlertRecord[];
  const open = alerts.filter((a) => a.state !== "recovered");
  const closed = alerts
    .filter((a) => a.state === "recovered")
    .sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt));
  return [...open, ...closed].slice(0, cap);
}

export function openAlerts(alerts: readonly AlertRecord[]): AlertRecord[] {
  return alerts.filter((a) => a.state !== "recovered" && a.armed);
}

/**
 * Critical before warning, then longest-running first — an alert that has been
 * shouting for an hour outranks one that appeared this second. Acknowledged
 * and snoozed records sink below active ones of the same severity.
 */
export function rankAlerts(alerts: readonly AlertRecord[]): AlertRecord[] {
  const stateRank = (s: AlertState) => (s === "active" ? 0 : s === "acknowledged" ? 1 : 2);
  return [...alerts].sort((a, b) => {
    const bySeverity = severityRank(b.severity) - severityRank(a.severity);
    if (bySeverity !== 0) return bySeverity;
    const byState = stateRank(a.state) - stateRank(b.state);
    if (byState !== 0) return byState;
    return Date.parse(a.firstSeenAt) - Date.parse(b.firstSeenAt);
  });
}
