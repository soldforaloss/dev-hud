// The HUD watching itself: its own resource use, every collector's timing,
// and the errors it swallowed.
//
// Secrets are masked here even though this card has no Redactor — a collector
// error can quote a command line, and a token must never reach the screen in
// any mode.

import type { JSX } from "react";
import type { SelfDiagnostics } from "../types";
import type { Provenance } from "../model/provenance";
import { dataAgeMs, describePollState, formatInterval } from "../model/provenance";
import { maskSecrets } from "../model/privacy";
import { fmtAgoMs, fmtBytes, fmtClock, fmtDuration, fmtPercent } from "../format";
import { EmptyState, Stat } from "./StatusBits";
import { DataRow } from "./DataRow";
import { rowBudget, useCardDensity } from "./density";

/**
 * A poll is slow when it eats a real share of its own budget — not against a
 * fixed millisecond count. Ten seconds is nothing for a six-hourly winget
 * check and alarming for a three-second process scan, so the old flat 1000ms
 * threshold flagged the wrong collectors.
 */
function isSlow(durationMs: number | null, intervalMs: number): boolean {
  if (durationMs == null) return false;
  return durationMs > Math.max(250, intervalMs * 0.25);
}
/** Matches collectorHealth's "unavailable" threshold — one definition of failing. */
const FAILING_STREAK = 3;

function isFailing(p: Provenance): boolean {
  return p.consecutiveFailures >= FAILING_STREAK;
}

/** Worst first: failing, then still-running collectors slowest first, then off. */
function severity(p: Provenance): number {
  if (p.state === "disabled") return 2;
  if (p.consecutiveFailures > 0 || p.state === "error") return 0;
  return 1;
}

function sortWorstFirst(entries: [string, Provenance][]): [string, Provenance][] {
  return [...entries].sort((a, b) => {
    const delta = severity(a[1]) - severity(b[1]);
    if (delta !== 0) return delta;
    return (b[1].lastDurationMs ?? -1) - (a[1].lastDurationMs ?? -1);
  });
}

/** One word for the cell; describePollState's full sentence is the tooltip. */
function stateWord(p: Provenance): string {
  if (p.state === "disabled") return "disabled";
  if (isFailing(p)) return "failing";
  switch (p.state) {
    case "error":
      return "error";
    case "polling":
      return "polling";
    case "ok":
      return "ok";
    default:
      return "idle";
  }
}

function CollectorRow({
  id,
  p,
  expanded,
  onRefreshCollector,
}: {
  id: string;
  p: Provenance;
  expanded: boolean;
  onRefreshCollector: (cardId: string) => void;
}) {
  const slow = isSlow(p.lastDurationMs, p.intervalMs);
  const failing = isFailing(p);
  const error = p.lastError == null ? null : maskSecrets(p.lastError);
  const took = p.lastDurationMs == null ? "—" : `${Math.round(p.lastDurationMs)} ms`;
  return (
    <>
      <DataRow
        primary={id}
        secondary={`${formatInterval(p.intervalMs)} · ${took}${slow ? " slow" : ""}`}
        value={stateWord(p)}
        valueHint={`${describePollState(p)} — ${p.successCount} ok, ${p.failureCount} failed`}
        tone={failing ? "bad" : slow ? "warn" : undefined}
        title={
          `${id} — ${p.source}
polls every ${formatInterval(p.intervalMs)}, last took ${took}` +
          (slow ? " (a large share of its own cadence)" : "") +
          `
last success ${fmtAgoMs(dataAgeMs(p))} · ${p.successCount} ok, ${p.failureCount} failed`
        }
        action={{
          icon: "⟳",
          label: `Refresh the ${id} collector now`,
          hint: `Re-runs ${p.command} now`,
          onSelect: () => onRefreshCollector(id),
        }}
      />
      {expanded && error ? <div className="drow-note muted small">{error}</div> : null}
    </>
  );
}

export function DiagnosticsCardBody({
  diag,
  provenance,
  errors,
  persistence,
  renderCount,
  renderRateHz,
  onRefreshCollector,
}: {
  diag: SelfDiagnostics | null;
  provenance: Record<string, Provenance>;
  errors: { at: number; source: string; message: string }[];
  persistence: { ok: boolean; lastSavedAt: number | null; error: string | null };
  renderCount: number;
  renderRateHz: number;
  onRefreshCollector: (cardId: string) => void;
}): JSX.Element {
  const density = useCardDensity();
  const compact = density === "compact";
  const expanded = density === "expanded";

  const entries = sortWorstFirst(Object.entries(provenance));
  const active = entries.filter(([, p]) => p.state !== "disabled");
  const failing = active.filter(([, p]) => isFailing(p)).length;

  if (compact) {
    return (
      <>
        {diag ? (
          <div className="stat-grid stat-grid-2">
            <Stat value={fmtBytes(diag.memBytes)} label="hud memory" hint="Resident memory of the HUD process" />
            <Stat value={fmtPercent(diag.cpuPercent)} label="hud cpu" hint="CPU share of the HUD process" />
          </div>
        ) : (
          <EmptyState reason="no_data" compact />
        )}
        <div className="muted small ip-line">
          {active.length} collectors, {failing} failing
        </div>
      </>
    );
  }

  const shown = entries.slice(0, rowBudget(density));
  const recent = [...errors].sort((a, b) => b.at - a.at).slice(0, 10);
  return (
    <>
      {diag ? (
        <div className="stat-grid">
          <Stat value={fmtBytes(diag.memBytes)} label="hud memory" hint="Resident memory of the HUD process" />
          <Stat value={fmtPercent(diag.cpuPercent)} label="hud cpu" hint="CPU share of the HUD process" />
          <Stat value={fmtDuration(diag.uptimeSecs)} label="uptime" hint="Time since the HUD process started" />
          <Stat
            value={`${renderRateHz.toFixed(1)} Hz`}
            label="ui renders"
            hint={`${renderCount} renders since launch`}
          />
          <Stat
            value={active.length}
            label="collectors"
            hint={`${active.length} enabled, ${failing} failing, ${entries.length - active.length} disabled`}
          />
          <Stat
            value={persistence.ok ? "saved" : "failed"}
            label="persistence"
            tone={persistence.ok ? undefined : "var(--bad)"}
            hint={
              persistence.error ??
              (persistence.lastSavedAt == null
                ? "nothing has been written to the settings store yet"
                : `last written at ${fmtClock(persistence.lastSavedAt)}`)
            }
          />
        </div>
      ) : (
        // The backend probe is what failed; collector timing is measured in the
        // frontend, so the table below is still real data and must stay visible.
        <EmptyState
          reason="no_data"
          detail="The self-diagnostics probe has not reported yet — collector timing below is measured in the UI and is unaffected."
        />
      )}

      {entries.length === 0 ? (
        <EmptyState reason="valid_zero" detail="No collectors are registered." />
      ) : (
        <div className="proc-list">
          {shown.map(([id, p]) => (
            <CollectorRow
              key={id}
              id={id}
              p={p}
              expanded={expanded}
              onRefreshCollector={onRefreshCollector}
            />
          ))}
        </div>
      )}
      {entries.length > shown.length && (
        <div className="proc-footer muted small">
          {entries.length - shown.length} more collector(s) not shown — enlarge the card
        </div>
      )}

      {!persistence.ok && persistence.error && (
        <div className="muted small ip-line">settings store: {maskSecrets(persistence.error)}</div>
      )}

      {recent.length > 0 && (
        <>
          <div className="muted small ip-line">recent internal errors</div>
          <div className="drow-list">
            {recent.map((e, i) => {
              const message = maskSecrets(e.message);
              return (
                <DataRow
                  key={`${e.at}-${i}`}
                  primary={message}
                  secondary={e.source}
                  value={fmtClock(e.at)}
                  valueHint={`${e.source} reported this at ${fmtClock(e.at)}`}
                  title={`${e.source} — ${message}`}
                  tone="bad"
                />
              );
            })}
          </div>
        </>
      )}
    </>
  );
}
