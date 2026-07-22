// Claude Code usage.
//
// Two very different things can fill these rings: a quota the provider
// confirmed, and an estimate reconstructed from local transcripts.
// `windowsLive` is the only evidence that separates them, so the card says
// which one it is in words rather than letting the ring imply a quota.

import type { JSX } from "react";
import type { ActiveSession, ClaudeUsage, RateWindow } from "../types";
import type { Redactor } from "../model/privacy";
import { safeText } from "../model/privacy";
import {
  burnRate,
  fmtCost,
  fmtCountdown,
  fmtDuration,
  fmtTokens,
  pace,
  projectedSpend,
} from "../format";
import { EmptyState, Stat } from "./StatusBits";
import { DataRow } from "./DataRow";
import { rowBudget, useCardDensity } from "./density";
import { Dot, Ring, Sparkline } from "./viz";

function shortModel(model: string): string {
  // "claude-sonnet-5" -> "sonnet-5", "claude-opus-4-8" -> "opus-4.8"
  const m = model.replace(/^claude-/, "").replace(/-(\d)-(\d)$/, "-$1.$2");
  return m.length > 14 ? `${m.slice(0, 13)}…` : m;
}

const ESTIMATED =
  "Estimated from the local ~/.claude logs — the provider did not report live limits, so these percentages are this machine's arithmetic, not a quota.";
const LIVE = "Limits as reported by the provider.";
const NO_WINDOW = "No rate-limit window is known for this account yet";
const NO_HOURLY = "no token activity recorded in today's transcripts";
const NO_CWD = "this transcript did not record a working directory";

/**
 * Session strip that redacts — viz's SessionsList prints the raw name and cwd,
 * which would survive privacy mode in the title attribute.
 */
export function RedactedSessions({
  sessions,
  redactor,
}: {
  sessions: ActiveSession[];
  redactor: Redactor;
}): JSX.Element | null {
  if (sessions.length === 0) return null;
  return (
    <div className="sessions">
      {sessions.map((s) => {
        const live = s.ageSecs < 120;
        const name = redactor.session(s.name) ?? s.name;
        const cwd = s.cwd == null ? null : redactor.path(s.cwd);
        return (
          <div className="session" key={s.cwd ?? s.name} title={cwd ?? NO_CWD}>
            <Dot state={live ? "good" : "off"} title={live ? "writing now" : "quiet"} />
            <span className="session-name">{name}</span>
            <span className="session-age">
              {live ? "live" : `${fmtDuration(s.ageSecs)} ago`}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** The window closest to its limit — the one that will bite first. */
function tightestWindow(windows: RateWindow[]): RateWindow | null {
  return windows.reduce<RateWindow | null>(
    (worst, w) => (worst == null || w.usedPercent > worst.usedPercent ? w : worst),
    null,
  );
}

export function ClaudeCardBody({
  usage,
  redactor,
}: {
  usage: ClaudeUsage | null;
  redactor: Redactor;
}): JSX.Element {
  const density = useCardDensity();
  const compact = density === "compact";
  const expanded = density === "expanded";

  if (!usage) {
    return (
      <EmptyState
        reason="no_data"
        detail="Waiting for the first read of ~/.claude."
        compact={compact}
      />
    );
  }
  if (!usage.available) {
    return (
      <EmptyState
        reason="not_installed"
        detail="~/.claude was not found — Claude Code does not appear to be installed for this user."
        compact={compact}
      />
    );
  }

  const tokensToday =
    usage.todayTokens.input +
    usage.todayTokens.output +
    usage.todayTokens.cacheWrite +
    usage.todayTokens.cacheRead;
  const tightest = tightestWindow(usage.windows);
  const providerError = safeText(redactor, usage.providerError);
  const sourceLine = usage.windowsLive
    ? "limits reported by the provider"
    : "limits estimated from local logs";

  if (compact) {
    return (
      <>
        <div className="stat-grid stat-grid-2">
          <Stat
            value={tightest ? `${tightest.usedPercent.toFixed(0)}%` : "—"}
            label={tightest ? `${tightest.label} used` : "no window"}
            hint={
              tightest
                ? `${tightest.usedPercent.toFixed(0)}% used, ${Math.max(0, 100 - tightest.usedPercent).toFixed(0)}% left. ${usage.windowsLive ? LIVE : ESTIMATED}`
                : NO_WINDOW
            }
            freshness={usage.windowsLive ? "live" : "estimated"}
          />
          <Stat
            value={fmtCost(usage.todayCostUsd)}
            label="today"
            hint={`${tokensToday.toLocaleString()} tokens attributed to today's local transcripts`}
          />
        </div>
        <div className="muted small ip-line">{sourceLine}</div>
      </>
    );
  }

  const fiveHour = usage.windows.find((w) => w.label === "5h");
  const fiveHourPace = fiveHour ? pace(fiveHour) : null;
  const blockActive = usage.blockEndsUnix > Date.now() / 1000;
  const rate = burnRate(usage.blockCostUsd, usage.blockStartedUnix);
  const projected = projectedSpend(
    usage.blockCostUsd,
    usage.blockStartedUnix,
    usage.blockEndsUnix,
  );
  const projects = usage.projectsToday.slice(0, rowBudget(density));

  return (
    <>
      {usage.windows.length > 0 ? (
        <>
          <div className="ring-row">
            {usage.windows.map((w) => (
              <Ring
                key={w.label}
                percent={w.usedPercent}
                label={w.label}
                sub={`${w.usedPercent.toFixed(0)}% used · ${Math.max(0, 100 - w.usedPercent).toFixed(0)}% left`}
              />
            ))}
          </div>
          <div className="muted small ip-line">
            {usage.windows
              .map((w) => `${w.label} resets in ${fmtCountdown(w.resetsAtUnix) || "an unknown time"}`)
              .join(" · ")}
          </div>
        </>
      ) : (
        <EmptyState
          reason={usage.providerError ? "unavailable" : "no_data"}
          detail={
            usage.providerError
              ? `The provider did not return rate-limit windows: ${providerError}`
              : "No rate-limit window has been seen in the local logs yet."
          }
          compact={compact}
        />
      )}

      <div className="muted small" title={usage.windowsLive ? LIVE : ESTIMATED}>
        {sourceLine}
        {providerError ? ` · provider said: ${providerError}` : ""}
      </div>

      {fiveHourPace ? <div className="pace">{fiveHourPace.label}</div> : null}
      <RedactedSessions sessions={usage.activeSessions} redactor={redactor} />

      <div className="stat-grid">
        <Stat
          value={fmtCost(usage.todayCostUsd)}
          label="today ≈"
          hint="Cost derived from today's local transcripts, not a provider invoice"
          freshness="estimated"
        />
        <Stat
          value={fmtTokens(tokensToday)}
          label="tokens today"
          hint={`${usage.todayTokens.input.toLocaleString()} in · ${usage.todayTokens.output.toLocaleString()} out · ${usage.todayTokens.cacheWrite.toLocaleString()} cache write · ${usage.todayTokens.cacheRead.toLocaleString()} cache read`}
        />
        <Stat
          value={fmtCost(usage.weekCostUsd)}
          label="7d ≈"
          hint={`${usage.weekTokensTotal.toLocaleString()} tokens over the last 7 days of transcripts`}
          freshness="estimated"
        />
        <Stat
          value={blockActive ? fmtTokens(usage.blockTokensTotal) : "—"}
          label={blockActive ? `block · ${fmtCountdown(usage.blockEndsUnix)}` : "no active block"}
          hint={
            blockActive
              ? `Active 5h block: ${usage.blockTokensTotal.toLocaleString()} tokens, ${fmtCost(usage.blockCostUsd)}, ends in ${fmtCountdown(usage.blockEndsUnix)}`
              : "No 5h block is open — the last one has already expired"
          }
        />
      </div>

      {/* Burn rate and the projection are derived from the observed rate in the
          current block; both are labelled as estimates because that is what
          they are — the provider publishes neither. */}
      {expanded && blockActive && (rate != null || projected != null) ? (
        <div className="stat-grid stat-grid-2">
          <Stat
            value={rate != null ? `${fmtCost(rate)}/h` : "—"}
            label="burn rate"
            hint={
              rate != null
                ? "Spend per hour so far in the active 5h block"
                : "The block is too young to derive a meaningful rate"
            }
            freshness={rate != null ? "estimated" : "not_measured"}
          />
          <Stat
            value={projected != null ? fmtCost(projected) : "—"}
            label="block at this pace"
            hint={
              projected != null
                ? `Projected block spend by ${fmtCountdown(usage.blockEndsUnix)} from now if the current rate holds`
                : "Not enough elapsed time to project"
            }
            freshness={projected != null ? "estimated" : "not_measured"}
          />
        </div>
      ) : null}

      {expanded ? (
      <div className="stat-grid stat-grid-2">
        <Stat
          value={fmtTokens(usage.todayTokens.cacheRead)}
          label="cache reads"
          hint="Tokens served from the prompt cache today — cheaper than fresh input"
        />
        <Stat
          value={fmtTokens(usage.todayTokens.cacheWrite)}
          label="cache writes"
          hint="Tokens written into the prompt cache today"
        />
      </div>
      ) : null}

      {usage.hourly.length > 0 ? (
        <Sparkline buckets={usage.hourly} />
      ) : (
        <div className="muted small">{NO_HOURLY}</div>
      )}

      {usage.modelsToday.length === 0 ? (
        <div className="muted small">no model attributed to today's usage</div>
      ) : expanded ? (
        <div className="drow-list">
          {usage.modelsToday.map((m) => (
            <DataRow
              key={m.model}
              primary={shortModel(m.model)}
              secondary={fmtTokens(m.tokens)}
              value={fmtCost(m.costUsd)}
              valueHint={`${fmtCost(m.costUsd)} across ${m.tokens.toLocaleString()} tokens`}
              title={`${m.model} — ${m.tokens.toLocaleString()} tokens`}
            />
          ))}
        </div>
      ) : null}

      {expanded &&
        (usage.projectsToday.length === 0 ? (
          <div className="muted small">no project attributed to today's usage</div>
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
