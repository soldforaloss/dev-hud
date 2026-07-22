import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Provenance } from "./model/provenance";
import { emptyProvenance } from "./model/provenance";

export interface PollOptions {
  args?: Record<string, unknown>;
  enabled?: boolean;
  /** Display name of the collector; defaults to the command. */
  source?: string;
  /** Dependency/permission/port the collector needs, shown when it fails. */
  requires?: string;
  /** Multiplier applied to the interval while the window is hidden. */
  hiddenMultiplier?: number;
  /** Skip polling entirely while the window is hidden (expensive collectors). */
  pauseWhenHidden?: boolean;
}

export interface PollResult<T> {
  data: T | null;
  error: string | null;
  refresh: () => Promise<void>;
  provenance: Provenance;
}

/**
 * Poll a Tauri command on an interval, recording provenance for every attempt.
 *
 * `nonce` forces an immediate refresh when bumped (tray "Refresh now", header
 * button, command palette). Provenance is what lets the UI tell "stale" from
 * "broken" — the two are indistinguishable from the payload alone.
 */
export function usePoll<T>(
  command: string,
  intervalMs: number,
  nonce: number,
  argsOrOptions?: Record<string, unknown> | PollOptions,
  enabledArg = true,
): PollResult<T> {
  const options: PollOptions = isPollOptions(argsOrOptions)
    ? argsOrOptions
    : { args: argsOrOptions, enabled: enabledArg };
  const {
    args,
    enabled = true,
    source = command,
    requires,
    hiddenMultiplier = 1,
    pauseWhenHidden = false,
  } = options;

  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [provenance, setProvenance] = useState<Provenance>(() =>
    emptyProvenance(command, intervalMs, source, requires),
  );
  const inFlight = useRef(false);
  const argsKey = JSON.stringify(args ?? {});
  const visible = usePageVisible();

  const tick = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    const startedAt = Date.now();
    setProvenance((p) => ({ ...p, state: "polling", lastAttemptAt: startedAt }));
    try {
      const result = await invoke<T>(command, args ?? {});
      const duration = Date.now() - startedAt;
      setData(result);
      setError(null);
      setProvenance((p) => ({
        ...p,
        state: "ok",
        lastSuccessAt: Date.now(),
        lastDurationMs: duration,
        lastError: null,
        consecutiveFailures: 0,
        successCount: p.successCount + 1,
      }));
    } catch (e) {
      const duration = Date.now() - startedAt;
      const message = String(e);
      setError(message);
      setProvenance((p) => ({
        ...p,
        state: "error",
        lastDurationMs: duration,
        lastError: message,
        consecutiveFailures: p.consecutiveFailures + 1,
        failureCount: p.failureCount + 1,
      }));
    } finally {
      inFlight.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [command, argsKey]);

  // Keep the static fields in sync when a setting changes the cadence.
  useEffect(() => {
    setProvenance((p) =>
      p.intervalMs === intervalMs && p.source === source && p.requires === requires
        ? p
        : { ...p, intervalMs, source, requires },
    );
  }, [intervalMs, source, requires]);

  useEffect(() => {
    if (!enabled) {
      setProvenance((p) => (p.state === "disabled" ? p : { ...p, state: "disabled" }));
      return;
    }
    if (!visible && pauseWhenHidden) return;
    const effective = visible ? intervalMs : intervalMs * Math.max(1, hiddenMultiplier);
    void tick();
    const id = window.setInterval(() => void tick(), effective);
    return () => window.clearInterval(id);
  }, [tick, intervalMs, nonce, enabled, visible, hiddenMultiplier, pauseWhenHidden]);

  return { data, error, refresh: tick, provenance };
}

function isPollOptions(v: unknown): v is PollOptions {
  if (!v || typeof v !== "object") return false;
  return ["args", "enabled", "source", "requires", "hiddenMultiplier", "pauseWhenHidden"].some(
    (k) => k in (v as Record<string, unknown>),
  );
}

/** Re-render every `ms` so countdowns stay live without re-fetching. */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [ms]);
  return now;
}

/**
 * Whether the HUD is actually on screen. Drives reduced polling while hidden —
 * the widget spends most of its life behind other windows.
 */
export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(
    () => typeof document === "undefined" || document.visibilityState !== "hidden",
  );
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
}

/** Honour the OS "reduce motion" setting for pulses and transitions. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!mq) return;
    setReduced(mq.matches);
    const update = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener?.("change", update);
    return () => mq.removeEventListener?.("change", update);
  }, []);
  return reduced;
}

/** Stable value that only changes when the JSON shape changes. */
export function useStable<T>(value: T): T {
  const key = JSON.stringify(value);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => value, [key]);
}
