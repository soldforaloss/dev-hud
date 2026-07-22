// Polling for user-defined cards.
//
// Deliberately not built on `usePoll`: the number of custom cards changes at
// runtime, and one hook per card would violate the rules of hooks. One effect
// owns every timer instead, keyed on the definitions themselves.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { CustomCardDef } from "./model/settings";
import type { CustomCardResult } from "./types";
import type { Provenance } from "./model/provenance";
import { emptyProvenance } from "./model/provenance";

export interface CustomCardState {
  results: Record<string, CustomCardResult | null>;
  provenance: Record<string, Provenance>;
  refresh: (id: string) => Promise<void>;
}

/** Clamp what the settings editor accepts, so a bad number can't spin a loop. */
function sanitize(def: CustomCardDef) {
  return {
    id: def.id,
    kind: def.kind,
    target: def.target,
    args: def.args ?? [],
    timeoutMs: Math.min(30_000, Math.max(250, def.timeoutMs || 5_000)),
    maxBytes: Math.min(65_536, Math.max(64, def.maxBytes || 8_192)),
    intervalMs: Math.min(86_400_000, Math.max(5_000, def.intervalMs || 60_000)),
  };
}

export function useCustomCards(defs: CustomCardDef[], nonce: number): CustomCardState {
  const enabled = useMemo(
    () => defs.filter((d) => d.enabled && d.target.trim() !== "").map(sanitize),
    [defs],
  );
  const key = useMemo(() => JSON.stringify(enabled), [enabled]);

  const [results, setResults] = useState<Record<string, CustomCardResult | null>>({});
  const [provenance, setProvenance] = useState<Record<string, Provenance>>({});
  const inFlight = useRef<Set<string>>(new Set());
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const run = useCallback(async (id: string) => {
    const spec = enabledRef.current.find((d) => d.id === id);
    if (!spec || inFlight.current.has(id)) return;
    inFlight.current.add(id);
    const startedAt = Date.now();
    setProvenance((p) => ({
      ...p,
      [id]: { ...(p[id] ?? emptyProvenance(`custom:${id}`, spec.intervalMs, spec.target)), state: "polling", lastAttemptAt: startedAt },
    }));
    try {
      const result = await invoke<CustomCardResult>("run_custom_card", { spec });
      setResults((r) => ({ ...r, [id]: result }));
      setProvenance((p) => {
        const prev = p[id] ?? emptyProvenance(`custom:${id}`, spec.intervalMs, spec.target);
        // A card that answers with a malformed payload is a *failed* poll:
        // the process ran, but nothing usable came back, and the card must
        // not show the previous payload as if it were current.
        return {
          ...p,
          [id]: result.ok
            ? { ...prev, state: "ok", lastSuccessAt: Date.now(), lastDurationMs: result.durationMs, lastError: null, consecutiveFailures: 0, successCount: prev.successCount + 1 }
            : { ...prev, state: "error", lastDurationMs: result.durationMs, lastError: result.error, consecutiveFailures: prev.consecutiveFailures + 1, failureCount: prev.failureCount + 1 },
        };
      });
    } catch (e) {
      setProvenance((p) => {
        const prev = p[id] ?? emptyProvenance(`custom:${id}`, spec.intervalMs, spec.target);
        return {
          ...p,
          [id]: { ...prev, state: "error", lastError: String(e), consecutiveFailures: prev.consecutiveFailures + 1, failureCount: prev.failureCount + 1 },
        };
      });
    } finally {
      inFlight.current.delete(id);
    }
  }, []);

  useEffect(() => {
    const timers = enabled.map((d) => {
      void run(d.id);
      return window.setInterval(() => void run(d.id), d.intervalMs);
    });
    // Drop state for cards the user deleted, so a removed card cannot linger.
    const live = new Set(enabled.map((d) => d.id));
    setResults((r) => pruneTo(r, live));
    setProvenance((p) => pruneTo(p, live));
    return () => timers.forEach((t) => window.clearInterval(t));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, nonce, run]);

  return { results, provenance, refresh: run };
}

function pruneTo<T>(map: Record<string, T>, live: Set<string>): Record<string, T> {
  const stale = Object.keys(map).filter((id) => !live.has(id));
  if (stale.length === 0) return map;
  const next = { ...map };
  for (const id of stale) delete next[id];
  return next;
}
