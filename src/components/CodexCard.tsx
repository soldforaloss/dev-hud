// Codex usage.
//
// Codex writes its rate-limit snapshot into the session log; there is no API to
// ask. Everything in the gauges is therefore as old as the newest session file
// and is labelled "cached" rather than "live" — a stale 12% is not a live 12%.

import type { JSX } from "react";
import type { CodexUsage, RateWindow } from "../types";
import type { Redactor } from "../model/privacy";
import { fmtCost, fmtCountdown, fmtDuration, fmtTokens, pace } from "../format";
import { EmptyState, Stat } from "./StatusBits";
import { DataRow } from "./DataRow";
import { rowBudget, useCardDensity } from "./density";
import { RedactedSessions } from "./ClaudeCard";
import { Ring } from "./viz";

const CACHED =
  "Read from the newest ~/.codex session log, not from a live API — the window is as old as the last time Codex wrote to disk.";
const NO_WINDOW = "No rate-limit snapshot has appeared in a recent session log";
const NO_PLAN = "no plan recorded in the local session logs";

function tightestWindow(windows: RateWindow[]): RateWindow | null {
  return windows.reduce<RateWindow | null>(
    (worst, w) => (worst == null || w.usedPercent > worst.usedPercent ? w : worst),
    null,
  );
}

export function CodexCardBody({
  usage,
  redactor,
}: {
  usage: CodexUsage | null;
  redactor: Redactor;
}): JSX.Element {
  const density = useCardDensity();
  const compact = density === "compact";
  const expanded = density === "expanded";

  if (!usage) {
    return (
      <EmptyState
        reason="no_data"
        detail="Waiting for the first read of ~/.codex."
        compact={compact}
      />
    );
  }
  if (!usage.available) {
    return (
      <EmptyState
        reason="not_installed"
        detail="~/.codex was not found — Codex does not appear to be installed for this user."
        compact={compact}
      />
    );
  }

  const windows = [usage.primary, usage.secondary].filter(
    (w): w is RateWindow => w != null,
  );
  const tightest = tightestWindow(windows);
  const lastEventMs = usage.lastEventUnix > 0 ? usage.lastEventUnix * 1000 : null;
  const ageSecs = lastEventMs == null ? null : Math.max(0, (Date.now() - lastEventMs) / 1000);

  if (compact) {
    return (
      <>
        <div className="stat-grid stat-grid-2">
          <Stat
            value={tightest ? `${tightest.usedPercent.toFixed(0)}%` : "—"}
            label={tightest ? `${tightest.label} used` : "no window"}
            hint={
              tightest
                ? `${tightest.usedPercent.toFixed(0)}% used, ${Math.max(0, 100 - tightest.usedPercent).toFixed(0)}% left. ${CACHED}`
                : NO_WINDOW
            }
            freshness="cached"
          />
          <Stat
            value={fmtTokens(usage.todayTokensTotal)}
            label="tokens today"
            hint={`${usage.todaySessions} session(s) recorded today`}
          />
        </div>
        <div className="muted small ip-line">rate window cached from session logs</div>
      </>
    );
  }

  const primaryPace = usage.primary ? pace(usage.primary) : null;
  const projects = usage.projectsToday.slice(0, rowBudget(density));

  return (
    <>
      {windows.length > 0 ? (
        <>
          <div className="ring-row">
            {windows.map((w) => (
              <Ring
                key={w.label}
                percent={w.usedPercent}
                label={w.label}
                sub={`${w.usedPercent.toFixed(0)}% used · ${Math.max(0, 100 - w.usedPercent).toFixed(0)}% left`}
              />
            ))}
          </div>
          <div className="muted small ip-line">
            {windows
              .map((w) => `${w.label} resets in ${fmtCountdown(w.resetsAtUnix) || "an unknown time"}`)
              .join(" · ")}
          </div>
        </>
      ) : (
        <EmptyState
          reason="no_data"
          detail="No session log in ~/.codex carries a rate-limit snapshot yet."
          compact={compact}
        />
      )}

      <div className="muted small" title={CACHED}>
        cached from the newest session log
        {ageSecs != null ? ` · written ${fmtDuration(ageSecs)} ago` : " · write time unknown"}
      </div>

      {primaryPace ? <div className="pace">{primaryPace.label}</div> : null}
      <RedactedSessions sessions={usage.activeSessions} redactor={redactor} />

      <div className="stat-grid">
        <Stat
          value={fmtTokens(usage.todayTokensTotal)}
          label="tokens today"
          hint="Summed from today's session logs"
        />
        <Stat
          value={usage.todaySessions}
          label="sessions today"
          hint="Session logs with at least one event dated today"
        />
        <Stat
          value={usage.plan ?? "—"}
          label="plan"
          hint={usage.plan ?? NO_PLAN}
          tone={usage.plan ? undefined : "var(--muted)"}
        />
      </div>

      {ageSecs != null && ageSecs > 86_400 ? (
        <div className="muted small">
          last recorded activity {fmtDuration(ageSecs)} ago — these numbers are not moving
        </div>
      ) : null}

      {expanded &&
        (usage.projectsToday.length === 0 ? (
          <div className="muted small">no project attributed to today's sessions</div>
        ) : (
          <>
            <div className="drow-list">
              {projects.map((p) => {
                const name = redactor.path(p.project) ?? p.project;
                return (
                  <DataRow
                    key={p.project}
                    primary={name}
                    secondary={fmtTokens(p.tokens)}
                    value={fmtCost(p.costUsd)}
                    valueHint={`${fmtCost(p.costUsd)} over ${p.sessions} session(s) today`}
                    title={`${name} — ${p.sessions} session(s), ${p.tokens.toLocaleString()} tokens today`}
                  />
                );
              })}
            </div>
            {usage.projectsToday.length > projects.length && (
              <div className="proc-footer muted small">
                {usage.projectsToday.length - projects.length} more project(s) not shown
              </div>
            )}
          </>
        ))}
    </>
  );
}
