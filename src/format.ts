// Tiny formatting helpers shared across cards.

export function fmtTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

export function fmtCost(usd: number): string {
  if (usd >= 100) return `$${usd.toFixed(0)}`;
  if (usd >= 10) return `$${usd.toFixed(1)}`;
  return `$${usd.toFixed(2)}`;
}

export function fmtRate(bps: number): string {
  if (bps >= 1 << 20) return `${(bps / (1 << 20)).toFixed(1)} MB/s`;
  if (bps >= 1024) return `${(bps / 1024).toFixed(0)} KB/s`;
  return `${bps.toFixed(0)} B/s`;
}

export function fmtBytes(bytes: number): string {
  if (bytes >= 1 << 30) return `${(bytes / (1 << 30)).toFixed(1)} GB`;
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(0)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

export function fmtDuration(secs: number): string {
  if (secs < 60) return `${Math.floor(secs)}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    return m > 0 ? `${h}h${m}m` : `${h}h`;
  }
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  return h > 0 ? `${d}d${h}h` : `${d}d`;
}

/** "resets in 3h 12m" style countdown; empty when in the past/unknown. */
export function fmtCountdown(unixSecs: number): string {
  if (!unixSecs) return "";
  const delta = unixSecs - Date.now() / 1000;
  if (delta <= 0) return "now";
  return fmtDuration(delta);
}

export function fmtAgo(iso: string | null): string {
  if (!iso) return "";
  const delta = Date.now() / 1000 - new Date(iso).getTime() / 1000;
  if (delta < 0) return "now";
  if (delta < 3600) return `${Math.max(1, Math.floor(delta / 60))}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  if (delta < 86400 * 30) return `${Math.floor(delta / 86400)}d ago`;
  return `${Math.floor(delta / (86400 * 30))}mo ago`;
}

/** "just now" / "12s ago" / "4m ago" from an elapsed millisecond count. */
export function fmtAgoMs(deltaMs: number | null): string {
  if (deltaMs == null) return "never";
  if (deltaMs < 2_000) return "just now";
  return `${fmtDuration(deltaMs / 1000)} ago`;
}

/** Wall-clock time for timeline rows; 24h so ordering reads unambiguously. */
export function fmtClock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function fmtPercent(value: number | null | undefined, digits = 0): string {
  return value == null ? "—" : `${value.toFixed(digits)}%`;
}

/** Elapsed time between two epoch-ms stamps, or "ongoing" when unresolved. */
export function fmtSpan(fromMs: number, toMs: number | null): string {
  return fmtDuration(Math.max(0, ((toMs ?? Date.now()) - fromMs) / 1000));
}

/**
 * Spend per hour so far in a window.
 *
 * Null for the first few minutes: dividing by a two-minute elapsed time turns
 * one request into "$40/hour", which is a fiction, not a forecast.
 */
export function burnRate(
  costUsd: number,
  startedUnix: number,
  nowMs = Date.now(),
): number | null {
  if (!startedUnix) return null;
  const elapsedHours = (nowMs / 1000 - startedUnix) / 3600;
  if (elapsedHours < 5 / 60) return null;
  return costUsd / elapsedHours;
}

/**
 * What the window would cost by its reset if the current rate held.
 *
 * Explicitly a projection of the observed rate — it is labelled as such in the
 * UI, never presented as a provider figure.
 */
export function projectedSpend(
  costUsd: number,
  startedUnix: number,
  endsUnix: number,
  nowMs = Date.now(),
): number | null {
  const rate = burnRate(costUsd, startedUnix, nowMs);
  if (rate == null || !endsUnix) return null;
  const remainingHours = (endsUnix - nowMs / 1000) / 3600;
  if (remainingHours <= 0) return costUsd;
  return costUsd + rate * remainingHours;
}

/**
 * CodexBar-style pace: compare used% against elapsed% of the window.
 * Positive = reserve (under even burn), negative = deficit.
 */
export function pace(win: {
  usedPercent: number;
  resetsAtUnix: number;
  windowMinutes: number;
}): { deltaPct: number; label: string } | null {
  if (!win.resetsAtUnix || !win.windowMinutes) return null;
  const total = win.windowMinutes * 60;
  const remaining = win.resetsAtUnix - Date.now() / 1000;
  if (remaining <= 0 || remaining >= total) return null;
  const elapsedPct = ((total - remaining) / total) * 100;
  if (elapsedPct < 3) return null; // too early to be meaningful
  const delta = elapsedPct - win.usedPercent;
  const label =
    Math.abs(delta) < 2
      ? "on pace"
      : delta > 0
        ? `${delta.toFixed(0)}% in reserve`
        : `${(-delta).toFixed(0)}% over pace`;
  return { deltaPct: delta, label };
}
