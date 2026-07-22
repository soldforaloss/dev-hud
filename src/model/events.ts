// The unified event timeline.
//
// A timeline is only useful if it records *changes*. Appending every poll
// would bury the one line that explains the incident, so every producer must
// pass a `dedupeKey`: an event whose key matches the previous event for the
// same subject is dropped.

import type { EntityRef } from "./entities";

export type EventCategory =
  | "system"
  | "network"
  | "process"
  | "container"
  | "repository"
  | "agent"
  | "gateway"
  | "alert"
  | "user_action";

export type EventSeverity = "info" | "warning" | "critical";

export interface ActivityEvent {
  id: string;
  /** ISO-8601 for the contract; `atMs` is the sort key. */
  timestamp: string;
  atMs: number;
  category: EventCategory;
  severity: EventSeverity;
  title: string;
  detail?: string;
  relatedEntities: EntityRef[];
  /** Collapses repeats of the same state; not shown to the user. */
  dedupeKey: string;
}

export const EVENT_CATEGORY_LABEL: Record<EventCategory, string> = {
  system: "System",
  network: "Network",
  process: "Process",
  container: "Container",
  repository: "Repository",
  agent: "Agent",
  gateway: "Gateway",
  alert: "Alert",
  user_action: "Action",
};

export interface EventInput {
  category: EventCategory;
  severity?: EventSeverity;
  title: string;
  detail?: string;
  relatedEntities?: EntityRef[];
  /** Defaults to `${category}:${title}` — pass one when the title varies. */
  dedupeKey?: string;
}

let seq = 0;

export function makeEvent(input: EventInput, atMs = Date.now()): ActivityEvent {
  seq += 1;
  return {
    id: `${atMs.toString(36)}-${seq.toString(36)}`,
    timestamp: new Date(atMs).toISOString(),
    atMs,
    category: input.category,
    severity: input.severity ?? "info",
    title: input.title,
    ...(input.detail ? { detail: input.detail } : {}),
    relatedEntities: input.relatedEntities ?? [],
    dedupeKey: input.dedupeKey ?? `${input.category}:${input.title}`,
  };
}

/**
 * Append with per-key suppression and a hard cap.
 *
 * Returns the same array reference when nothing was added, so React can skip
 * the re-render — this runs on every poll of every card.
 */
export function appendEvents(
  log: readonly ActivityEvent[],
  incoming: readonly ActivityEvent[],
  cap: number,
): ActivityEvent[] {
  if (incoming.length === 0) return log as ActivityEvent[];
  const lastByKey = new Map<string, ActivityEvent>();
  for (const e of log) {
    const prefix = e.dedupeKey.split("=")[0];
    const prev = lastByKey.get(prefix);
    if (!prev || prev.atMs < e.atMs) lastByKey.set(prefix, e);
  }
  const added: ActivityEvent[] = [];
  for (const e of incoming) {
    const prefix = e.dedupeKey.split("=")[0];
    const prev = lastByKey.get(prefix);
    // Same subject in the same state as last time → not a change.
    if (prev && prev.dedupeKey === e.dedupeKey) continue;
    lastByKey.set(prefix, e);
    added.push(e);
  }
  if (added.length === 0) return log as ActivityEvent[];
  const merged = [...added, ...log];
  merged.sort((a, b) => b.atMs - a.atMs);
  return merged.slice(0, cap);
}

export function filterEvents(
  log: readonly ActivityEvent[],
  filter: {
    categories?: EventCategory[];
    minSeverity?: EventSeverity;
    sinceMs?: number;
    entityKey?: string;
    entityKeyOf?: (ref: EntityRef) => string;
  },
): ActivityEvent[] {
  const rank: Record<EventSeverity, number> = { info: 0, warning: 1, critical: 2 };
  const min = filter.minSeverity ? rank[filter.minSeverity] : 0;
  return log.filter((e) => {
    if (filter.categories?.length && !filter.categories.includes(e.category)) return false;
    if (rank[e.severity] < min) return false;
    if (filter.sinceMs != null && e.atMs < filter.sinceMs) return false;
    if (filter.entityKey && filter.entityKeyOf) {
      if (!e.relatedEntities.some((r) => filter.entityKeyOf!(r) === filter.entityKey)) return false;
    }
    return true;
  });
}
