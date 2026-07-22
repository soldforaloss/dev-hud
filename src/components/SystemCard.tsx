// Host CPU / memory / network.
//
// Every number here has a different notion of "unknown": a queue counter that
// could not be read is not a queue of zero, and an IP the host never resolved
// is not "no network". Both render as "—" with the reason in the tooltip.

import type { JSX } from "react";
import type { SystemHealth } from "../types";
import type { HistoryStore } from "../model/history";
import { seriesStats } from "../model/history";
import type { Redactor } from "../model/privacy";
import { fmtBytes, fmtRate } from "../format";
import { EmptyState, Stat } from "./StatusBits";
import { DataRow } from "./DataRow";
import { rowBudget, useCardDensity } from "./density";
import { HistoryChart, Meter } from "./viz";

function pct(used: number, total: number): number {
  return total > 0 ? (used / total) * 100 : 0;
}

const NO_QUEUE =
  "The Windows processor-queue-length counter could not be read this cycle — this is an unknown, not a queue of zero.";
const QUEUE_HINT =
  "Threads waiting for a core (Windows processor queue length) — the closest analogue to a Unix load average.";
const NO_LOCAL_IP = "no non-loopback IPv4 address was found on any active adapter";
const NO_PUBLIC_IP = "the public address was not resolved (offline, or lookup disabled)";

/** One named series out of the card's history, with its own summary line. */
function SeriesChart({ history, name }: { history: HistoryStore; name: string }): JSX.Element {
  const series = history[name];
  const stats = series ? seriesStats(series.points) : null;
  return (
    <div>
      <div className="muted small ip-line">
        {name}
        {stats
          ? ` · min ${stats.min.toFixed(0)} · avg ${stats.avg.toFixed(0)} · max ${stats.max.toFixed(0)}`
          : " · no samples recorded yet"}
      </div>
      <HistoryChart points={series?.points ?? []} />
    </div>
  );
}

export function SystemCardBody({
  health,
  redactor,
  history,
}: {
  health: SystemHealth | null;
  redactor: Redactor;
  history: HistoryStore;
}): JSX.Element {
  const density = useCardDensity();
  const compact = density === "compact";
  const expanded = density === "expanded";

  if (!health) {
    return (
      <EmptyState
        reason="no_data"
        detail="Waiting for the first sample from the system collector."
        compact={compact}
      />
    );
  }

  const memPct = pct(health.memUsed, health.memTotal);

  if (compact) {
    return (
      <div className="stat-grid stat-grid-2">
        <Stat
          value={`${health.cpuPercent.toFixed(0)}%`}
          label="cpu"
          hint={`CPU ${health.cpuPercent.toFixed(1)}% across all cores`}
        />
        <Stat
          value={`${memPct.toFixed(0)}%`}
          label="ram"
          hint={`RAM ${fmtBytes(health.memUsed)} of ${fmtBytes(health.memTotal)}`}
        />
      </div>
    );
  }

  // Prefer commit charge (Windows): RAM + pagefile the OS has promised out —
  // the number most task managers label "swap/pagefile". Falls back to classic
  // swap on other platforms.
  const hasCommit = health.commitTotal > 0;
  const swapPct = hasCommit
    ? pct(health.commitUsed, health.commitTotal)
    : pct(health.swapUsed, health.swapTotal);
  const swapKnown = hasCommit || health.swapTotal > 0;
  const swapLabel = hasCommit
    ? `commit · ${fmtBytes(health.commitUsed)} / ${fmtBytes(health.commitTotal)}`
    : health.swapTotal > 0
      ? `swap · ${fmtBytes(health.swapUsed)} / ${fmtBytes(health.swapTotal)}`
      : "swap · not reported";
  const localIp = redactor.ip(health.localIp);
  const publicIp = redactor.ip(health.publicIp);
  const top = health.topProcesses.slice(0, rowBudget(density));

  return (
    <>
      <div className="stat-grid stat-grid-2">
        <Stat
          value={`${health.cpuPercent.toFixed(0)}%`}
          label="cpu"
          hint={`CPU ${health.cpuPercent.toFixed(1)}% across all cores`}
          sub={<Meter percent={health.cpuPercent} />}
        />
        <Stat
          value={`${memPct.toFixed(0)}%`}
          label={`ram · ${fmtBytes(health.memUsed)} / ${fmtBytes(health.memTotal)}`}
          hint={`RAM ${fmtBytes(health.memUsed)} of ${fmtBytes(health.memTotal)}`}
          sub={<Meter percent={memPct} />}
        />
        <Stat
          value={swapKnown ? `${swapPct.toFixed(0)}%` : "—"}
          label={swapLabel}
          hint={
            hasCommit
              ? "Commit charge: RAM + pagefile the OS has promised to programs. This is what most tools call swap/pagefile usage on Windows."
              : health.swapTotal > 0
                ? "Swap space in use"
                : "This host reports neither a commit limit nor a swap device"
          }
          sub={swapKnown ? <Meter percent={swapPct} /> : undefined}
        />
        <Stat
          value={<span className="net-num">↓{fmtRate(health.netRxBps)}</span>}
          label={`↑${fmtRate(health.netTxBps)} · network`}
          hint={`Network down ${fmtRate(health.netRxBps)}, up ${fmtRate(health.netTxBps)}`}
        />
        {expanded ? (
          <Stat
            value={health.queueLength == null ? "—" : health.queueLength.toFixed(1)}
            label="processor queue"
            hint={health.queueLength == null ? NO_QUEUE : QUEUE_HINT}
            freshness={health.queueLength == null ? "not_measured" : "live"}
            tone={health.queueLength != null && health.queueLength >= 4 ? "var(--warn)" : undefined}
          />
        ) : null}
      </div>

      <div className="muted small ip-line">
        <span title={localIp ? "LAN address of the active adapter" : NO_LOCAL_IP}>
          lan {localIp ?? "—"}
        </span>
        {" · "}
        <span title={publicIp ? "public address as seen from the internet" : NO_PUBLIC_IP}>
          wan {publicIp ?? "—"}
        </span>
      </div>

      {expanded && (
        <>
          <SeriesChart history={history} name="CPU %" />
          <SeriesChart history={history} name="Memory %" />
          {health.topProcesses.length === 0 ? (
            <div className="muted small">no per-process figures were returned this cycle</div>
          ) : (
            <div className="drow-list">
              {top.map((p) => (
                <DataRow
                  key={p.pid}
                  primary={p.name}
                  secondary={`pid ${p.pid}`}
                  value={`${p.cpuPercent.toFixed(0)}%`}
                  valueHint={`${p.cpuPercent.toFixed(0)}% CPU · ${fmtBytes(p.memBytes)} memory`}
                  title={`${p.name} (pid ${p.pid}) — ${fmtBytes(p.memBytes)}`}
                />
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}
