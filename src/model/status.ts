// Shared status semantics for every card and metric.
//
// The four dimensions are deliberately independent: a collector can be
// perfectly *healthy* while its data is *stale*, and a metric can be *live*
// and still demand *attention*. Collapsing them into one dot is the ambiguity
// this module exists to remove.

/** Can the underlying source answer at all? */
export type HealthState = "healthy" | "degraded" | "unavailable" | "unknown";

/** Is the thing the card describes doing work right now? */
export type ActivityState = "active" | "idle" | "stopped" | "starting";

/** Does a human need to look at this? */
export type AttentionState = "normal" | "warning" | "critical";

/** How much do we trust the number's timeliness and derivation? */
export type FreshnessState = "live" | "stale" | "estimated" | "cached" | "not_measured";

/** Why a value is absent — never conflated with a legitimate zero. */
export type EmptyReason =
  | "valid_zero"
  | "no_data"
  | "not_configured"
  | "not_installed"
  | "unsupported"
  | "unavailable"
  | "stale"
  | "estimated"
  | "permission_denied"
  | "collector_error";

export interface MetricEnvelope<T> {
  value: T | null;
  unit?: string;
  health: HealthState;
  activity?: ActivityState;
  attention: AttentionState;
  freshness: FreshnessState;
  /** When the source itself observed the value (ISO-8601). */
  measuredAt?: string;
  /** When the HUD received it (ISO-8601). */
  receivedAt?: string;
  /** Collector identity, e.g. "nvidia-smi" or "LibreHardwareMonitor:8085". */
  source: string;
  /** 0..1 — only meaningful for estimated values. */
  confidence?: number;
  error?: string;
}

// ---------- labels (never rely on colour alone) ----------

export const HEALTH_LABEL: Record<HealthState, string> = {
  healthy: "Healthy",
  degraded: "Degraded",
  unavailable: "Unavailable",
  unknown: "Unknown",
};

export const ACTIVITY_LABEL: Record<ActivityState, string> = {
  active: "Active",
  idle: "Idle",
  stopped: "Stopped",
  starting: "Starting",
};

export const ATTENTION_LABEL: Record<AttentionState, string> = {
  normal: "Normal",
  warning: "Warning",
  critical: "Critical",
};

export const FRESHNESS_LABEL: Record<FreshnessState, string> = {
  live: "Live",
  stale: "Stale",
  estimated: "Estimated",
  cached: "Cached",
  not_measured: "Not measured",
};

/** Text glyph shown alongside every state so colour is reinforcement only. */
export const HEALTH_GLYPH: Record<HealthState, string> = {
  healthy: "●",
  degraded: "◐",
  unavailable: "○",
  unknown: "?",
};

export const ATTENTION_GLYPH: Record<AttentionState, string> = {
  normal: "",
  warning: "▲",
  critical: "■",
};

export const FRESHNESS_GLYPH: Record<FreshnessState, string> = {
  live: "◆",
  stale: "◇",
  estimated: "≈",
  cached: "⌛",
  not_measured: "–",
};

export const EMPTY_TITLE: Record<EmptyReason, string> = {
  valid_zero: "Zero",
  no_data: "No data yet",
  not_configured: "Not configured",
  not_installed: "Not installed",
  unsupported: "Unsupported on this host",
  unavailable: "Temporarily unavailable",
  stale: "Data is stale",
  estimated: "Estimated only",
  permission_denied: "Permission denied",
  collector_error: "Collector failed",
};

// ---------- ordering / aggregation ----------

const HEALTH_RANK: Record<HealthState, number> = {
  healthy: 0,
  unknown: 1,
  degraded: 2,
  unavailable: 3,
};

const ATTENTION_RANK: Record<AttentionState, number> = {
  normal: 0,
  warning: 1,
  critical: 2,
};

const FRESHNESS_RANK: Record<FreshnessState, number> = {
  live: 0,
  cached: 1,
  estimated: 2,
  stale: 3,
  not_measured: 4,
};

export function worstHealth(states: readonly HealthState[]): HealthState {
  return states.reduce<HealthState>(
    (worst, s) => (HEALTH_RANK[s] > HEALTH_RANK[worst] ? s : worst),
    "healthy",
  );
}

export function worstAttention(states: readonly AttentionState[]): AttentionState {
  return states.reduce<AttentionState>(
    (worst, s) => (ATTENTION_RANK[s] > ATTENTION_RANK[worst] ? s : worst),
    "normal",
  );
}

export function worstFreshness(states: readonly FreshnessState[]): FreshnessState {
  return states.reduce<FreshnessState>(
    (worst, s) => (FRESHNESS_RANK[s] > FRESHNESS_RANK[worst] ? s : worst),
    "live",
  );
}

export function attentionRank(state: AttentionState): number {
  return ATTENTION_RANK[state];
}

/** True when this state should surface in the Needs Attention strip. */
export function isActionable(state: AttentionState): boolean {
  return state !== "normal";
}

// ---------- freshness derivation ----------

/**
 * Classify an observation by age. `staleAfterMs` is normally a multiple of the
 * collector's own interval — a 3 s collector is not stale at 4 s.
 */
export function freshnessFromAge(
  ageMs: number | null,
  staleAfterMs: number,
): FreshnessState {
  if (ageMs == null) return "not_measured";
  return ageMs > staleAfterMs ? "stale" : "live";
}

/** A collector that polls every `intervalMs` is stale after 3 missed cycles. */
export function staleThreshold(intervalMs: number): number {
  return Math.max(15_000, intervalMs * 3);
}

// ---------- envelope construction ----------

export interface MetricOptions<T> extends Partial<Omit<MetricEnvelope<T>, "value">> {
  source: string;
}

/**
 * Build an envelope, defaulting the dimensions sensibly: a present value is
 * healthy/live, a null value is unknown/not_measured. Callers override the
 * dimension they actually know something about.
 */
export function metric<T>(value: T | null | undefined, opts: MetricOptions<T>): MetricEnvelope<T> {
  const present = value !== null && value !== undefined;
  return {
    value: present ? (value as T) : null,
    health: present ? "healthy" : "unknown",
    attention: "normal",
    freshness: present ? "live" : "not_measured",
    receivedAt: new Date().toISOString(),
    ...opts,
  };
}

/**
 * Threshold helper shared by cards and the alert engine so a card badge and
 * an alert can never disagree about what "warning" means.
 *
 * `higherIsWorse=false` inverts the comparison (free disk space, battery).
 */
export function attentionFromThresholds(
  value: number | null | undefined,
  warn: number | null | undefined,
  critical: number | null | undefined,
  higherIsWorse = true,
): AttentionState {
  if (value == null) return "normal";
  const over = (limit: number) => (higherIsWorse ? value >= limit : value <= limit);
  if (critical != null && over(critical)) return "critical";
  if (warn != null && over(warn)) return "warning";
  return "normal";
}
