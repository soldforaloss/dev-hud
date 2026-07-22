// Bounded metric history.
//
// Cards want a trend line; the HUD runs for weeks. Every series is a fixed-
// capacity ring, and a sample is only appended when it differs meaningfully
// from the last one, so a flat metric costs nothing and memory is bounded by
// construction rather than by hoping the user restarts.

export interface Sample {
  atMs: number;
  value: number;
}

export interface Series {
  points: Sample[];
  /** Set when the series has been truncated — the UI says "since HH:MM". */
  oldestMs: number | null;
}

export const EMPTY_SERIES: Series = { points: [], oldestMs: null };

export function pushSample(
  series: Series | undefined,
  value: number | null | undefined,
  atMs: number,
  cap: number,
  minDelta = 0,
): Series {
  const base = series ?? EMPTY_SERIES;
  if (value == null || !Number.isFinite(value)) return base;
  const last = base.points[base.points.length - 1];
  // Collapse a flat line: keep the first and the newest, drop the middle.
  if (last && Math.abs(last.value - value) <= minDelta && base.points.length >= 2) {
    const prev = base.points[base.points.length - 2];
    if (Math.abs(prev.value - last.value) <= minDelta) {
      const points = base.points.slice(0, -1);
      points.push({ atMs, value });
      return { points, oldestMs: base.oldestMs ?? points[0]?.atMs ?? null };
    }
  }
  const points = [...base.points, { atMs, value }];
  const trimmed = points.length > cap ? points.slice(points.length - cap) : points;
  return { points: trimmed, oldestMs: trimmed[0]?.atMs ?? null };
}

/** Points inside the window, oldest first. */
export function windowed(series: Series | undefined, sinceMs: number): Sample[] {
  if (!series) return [];
  return series.points.filter((p) => p.atMs >= sinceMs);
}

export function seriesStats(points: readonly Sample[]): {
  min: number;
  max: number;
  avg: number;
  last: number;
} | null {
  if (points.length === 0) return null;
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const p of points) {
    if (p.value < min) min = p.value;
    if (p.value > max) max = p.value;
    sum += p.value;
  }
  return { min, max, avg: sum / points.length, last: points[points.length - 1].value };
}

/** A whole card's worth of series, keyed by metric name. */
export type HistoryStore = Record<string, Series>;

export function recordAll(
  store: HistoryStore,
  updates: Record<string, number | null | undefined>,
  atMs: number,
  cap: number,
): HistoryStore {
  let changed = false;
  const next: HistoryStore = { ...store };
  for (const [key, value] of Object.entries(updates)) {
    const before = store[key];
    const after = pushSample(before, value, atMs, cap);
    if (after !== before) {
      next[key] = after;
      changed = true;
    }
  }
  return changed ? next : store;
}
