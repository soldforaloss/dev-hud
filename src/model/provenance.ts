// Collector provenance: where a number came from and how the fetch went.
//
// Every card can answer "is this stale, or is the collector broken?" from
// this record alone — the two look identical on the surface and must not.

import type { FreshnessState, HealthState } from "./status";
import { freshnessFromAge, staleThreshold } from "./status";

export type PollState = "idle" | "polling" | "ok" | "error" | "disabled";

export interface Provenance {
  /** Human-readable collector name, e.g. "get_gpu_status (nvidia-smi)". */
  source: string;
  /** The Tauri command backing it. */
  command: string;
  intervalMs: number;
  state: PollState;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastDurationMs: number | null;
  lastError: string | null;
  consecutiveFailures: number;
  successCount: number;
  failureCount: number;
  /** Dependency the collector needs — shown when it fails. */
  requires?: string;
}

export function emptyProvenance(
  command: string,
  intervalMs: number,
  source = command,
  requires?: string,
): Provenance {
  return {
    source,
    command,
    intervalMs,
    state: "idle",
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastDurationMs: null,
    lastError: null,
    consecutiveFailures: 0,
    successCount: 0,
    failureCount: 0,
    ...(requires ? { requires } : {}),
  };
}

/** Age of the newest successful poll, in ms. Null when nothing succeeded. */
export function dataAgeMs(p: Provenance, now = Date.now()): number | null {
  return p.lastSuccessAt == null ? null : Math.max(0, now - p.lastSuccessAt);
}

/**
 * Freshness of whatever the card is currently displaying.
 *
 * A disabled collector is `not_measured`, not `stale`: nothing is wrong, the
 * user turned it off.
 */
export function provenanceFreshness(p: Provenance, now = Date.now()): FreshnessState {
  if (p.state === "disabled") return "not_measured";
  if (p.lastSuccessAt == null) return "not_measured";
  return freshnessFromAge(dataAgeMs(p, now), staleThreshold(p.intervalMs));
}

/**
 * Health of the collector itself — distinct from the health of the thing it
 * measures. One transient failure is degraded; three in a row is unavailable.
 */
export function collectorHealth(p: Provenance): HealthState {
  if (p.state === "disabled") return "unknown";
  if (p.consecutiveFailures >= 3) return "unavailable";
  if (p.consecutiveFailures > 0) return "degraded";
  if (p.lastSuccessAt == null) return "unknown";
  return "healthy";
}

/** One-line explanation for the inspector's provenance block. */
export function describePollState(p: Provenance): string {
  switch (p.state) {
    case "disabled":
      return "Disabled — card is set to off, collector is not polled";
    case "polling":
      return "Poll in flight";
    case "error":
      return p.lastError ? `Last poll failed: ${p.lastError}` : "Last poll failed";
    case "ok":
      return `Polling every ${formatInterval(p.intervalMs)}`;
    default:
      return "Not started";
  }
}

export function formatInterval(ms: number): string {
  if (ms >= 3_600_000) return `${Math.round(ms / 3_600_000)}h`;
  if (ms >= 60_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 1000)}s`;
}
