// Small SVG visual primitives: usage ring, sparkline, status dot, history.

import type { HourBucket } from "../types";

export function ringColor(pct: number): string {
  if (pct >= 90) return "var(--bad)";
  if (pct >= 70) return "var(--warn)";
  return "var(--good)";
}

export function Ring({
  percent,
  label,
  sub,
  size = 46,
}: {
  percent: number;
  label: string;
  sub?: string;
  size?: number;
}) {
  const clamped = Math.max(0, Math.min(100, percent));
  const r = (size - 6) / 2;
  const c = 2 * Math.PI * r;
  return (
    <div className="ring" title={`${label}: ${clamped.toFixed(1)}% used`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--ring-track)"
          strokeWidth="4"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={ringColor(clamped)}
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={`${(clamped / 100) * c} ${c}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
        <text x="50%" y="52%" className="ring-num" dominantBaseline="middle" textAnchor="middle">
          {Math.round(clamped)}
        </text>
      </svg>
      <div className="ring-label">{label}</div>
      {sub ? <div className="ring-sub">{sub}</div> : null}
    </div>
  );
}

export function Sparkline({
  buckets,
  width = 300,
  height = 34,
}: {
  buckets: HourBucket[];
  width?: number;
  height?: number;
}) {
  if (buckets.length === 0) return null;
  const max = Math.max(1, ...buckets.map((b) => b.tokens));
  const step = width / Math.max(1, buckets.length - 1);
  const points = buckets.map((b, i) => {
    const x = i * step;
    const y = height - 3 - (b.tokens / max) * (height - 8);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const area = `0,${height} ${points.join(" ")} ${width},${height}`;
  return (
    <svg
      className="spark"
      width="100%"
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
    >
      <polygon points={area} fill="var(--accent-dim)" />
      <polyline
        points={points.join(" ")}
        fill="none"
        stroke="var(--accent)"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Dot({ state, title }: { state: "good" | "warn" | "bad" | "off"; title?: string }) {
  // Colour alone is never the signal: the tooltip carries the same meaning.
  return <span className={`dot dot-${state}`} title={title} role={title ? "img" : undefined} aria-label={title} />;
}

/**
 * Time-series line for the inspector. Points are unevenly spaced (samples are
 * only stored when the value moves), so the x axis is real time rather than
 * the index — otherwise a quiet hour would look like a single step.
 */
export function HistoryChart({
  points,
  height = 44,
  width = 320,
}: {
  points: readonly { atMs: number; value: number }[];
  height?: number;
  width?: number;
}) {
  if (points.length < 2) {
    return <div className="muted small">not enough samples yet</div>;
  }
  const t0 = points[0].atMs;
  const t1 = points[points.length - 1].atMs;
  const span = Math.max(1, t1 - t0);
  let min = Infinity;
  let max = -Infinity;
  for (const p of points) {
    if (p.value < min) min = p.value;
    if (p.value > max) max = p.value;
  }
  const range = Math.max(1e-6, max - min);
  const coords = points.map((p) => {
    const x = ((p.atMs - t0) / span) * width;
    const y = height - 3 - ((p.value - min) / range) * (height - 8);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return (
    <svg
      className="spark"
      width="100%"
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`${points.length} samples, minimum ${min.toFixed(1)}, maximum ${max.toFixed(1)}`}
    >
      <polygon points={`0,${height} ${coords.join(" ")} ${width},${height}`} fill="var(--accent-dim)" />
      <polyline
        points={coords.join(" ")}
        fill="none"
        stroke="var(--accent)"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Thin horizontal usage meter with green/amber/red tone. */
export function Meter({ percent }: { percent: number }) {
  const clamped = Math.max(0, Math.min(100, percent));
  const tone = clamped >= 90 ? "var(--bad)" : clamped >= 70 ? "var(--warn)" : "var(--good)";
  return (
    <div className="meter">
      <div className="meter-fill" style={{ width: `${clamped}%`, background: tone }} />
    </div>
  );
}
