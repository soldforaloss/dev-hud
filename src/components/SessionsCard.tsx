// Active agent sessions, merged across Claude and Codex.
//
// The only evidence behind this card is transcript mtime, so everything it
// says is phrased as *writing activity*, never as agent state.

import type { JSX } from "react";
import type { ActiveSession, ClaudeUsage, CodexUsage } from "../types";
import type { Redactor } from "../model/privacy";
import { fmtCost, fmtDuration, fmtTokens } from "../format";
import { EmptyState, Stat } from "./StatusBits";
import { DataRow, RowOverflow } from "./DataRow";
import { rowBudget, useCardDensity } from "./density";
import { Dot } from "./viz";

export interface SessionRow {
  id: string;
  provider: "claude" | "codex";
  name: string;
  cwd: string | null;
  model: string | null;
  ageSecs: number;
  tokens: number | null;
  costUsd: number | null;
}

type SessionActivity = "running" | "idle" | "stale";

/**
 * Merge both providers into one list, freshest first. Pure and exported apart
 * from the component so the merge and identity rules can be tested directly.
 */
export function buildSessionRows(
  claude: ClaudeUsage | null,
  codex: CodexUsage | null,
): SessionRow[] {
  const rows: SessionRow[] = [];
  const add = (provider: SessionRow["provider"], sessions: ActiveSession[]) => {
    for (const s of sessions) {
      rows.push({
        // cwd is the stable identity; name is only a fallback for transcripts
        // that never recorded a working directory.
        id: `${provider}:${s.cwd ?? s.name}`,
        provider,
        name: s.name,
        cwd: s.cwd,
        model: s.model,
        ageSecs: s.ageSecs,
        tokens: s.tokens,
        costUsd: s.costUsd,
      });
    }
  };
  if (claude) add("claude", claude.activeSessions);
  if (codex) add("codex", codex.activeSessions);
  return rows.sort((a, b) => a.ageSecs - b.ageSecs);
}

/**
 * Age alone decides the word. A transcript mtime cannot tell an agent waiting
 * on tool approval apart from one that crashed, so "blocked" and "failed" are
 * states this card must never claim to know.
 */
function activityOf(ageSecs: number): SessionActivity {
  if (ageSecs < 120) return "running";
  if (ageSecs < 600) return "idle";
  return "stale";
}

const DOT_STATE: Record<SessionActivity, "good" | "warn" | "off"> = {
  running: "good",
  idle: "warn",
  stale: "off",
};

const NO_MODEL = "model not recorded in this transcript";
const NO_TOKENS = "token total not derivable from this transcript";
const NO_COST = "no cost attributed to this session";
const NO_CWD = "this transcript did not record a working directory";
const ACTIONS_OFF = "Operator actions are switched off for this card in Settings";

function Row({
  row,
  redactor,
  actionsEnabled,
  onOpenRepo,
  onInspect,
}: {
  row: SessionRow;
  redactor: Redactor;
  actionsEnabled: boolean;
  onOpenRepo: (cwd: string) => void;
  onInspect?: (row: SessionRow) => void;
}) {
  const activity = activityOf(row.ageSecs);
  const name = redactor.session(row.name) ?? row.name;
  const cwd = row.cwd == null ? null : redactor.path(row.cwd);
  return (
    <DataRow
      lead={<Dot state={DOT_STATE[activity]} title={activity} />}
      primary={name}
      secondary={row.model ?? "—"}
      value={fmtDuration(row.ageSecs)}
      valueHint={`last transcript write ${fmtDuration(row.ageSecs)} ago`}
      title={[
        `${name} · ${row.provider} · ${activity}`,
        cwd ?? NO_CWD,
        row.model ?? NO_MODEL,
        row.tokens == null ? NO_TOKENS : `${fmtTokens(row.tokens)} tokens`,
        row.costUsd == null ? NO_COST : fmtCost(row.costUsd),
      ].join("\n")}
      onOpen={onInspect ? () => onInspect(row) : undefined}
      action={{
        icon: "↗",
        label: `Open repository folder for ${name}`,
        hint: !actionsEnabled ? ACTIONS_OFF : row.cwd == null ? NO_CWD : `Opens ${cwd}`,
        disabled: !actionsEnabled || row.cwd == null,
        onSelect: () => {
          if (row.cwd != null) onOpenRepo(row.cwd);
        },
      }}
    />
  );
}

export function SessionsCardBody({
  claude,
  codex,
  redactor,
  onOpenRepo,
  onInspect,
  actionsEnabled,
}: {
  claude: ClaudeUsage | null;
  codex: CodexUsage | null;
  redactor: Redactor;
  onOpenRepo: (cwd: string) => void;
  onInspect?: (row: SessionRow) => void;
  actionsEnabled: boolean;
}): JSX.Element {
  const density = useCardDensity();
  const compact = density === "compact";
  const rows = buildSessionRows(claude, codex);

  // Neither provider has answered yet — that is a pending poll, not a zero.
  if (!claude && !codex) {
    return (
      <EmptyState
        reason="no_data"
        detail="Waiting for the first read of the Claude and Codex transcript directories."
        compact={compact}
      />
    );
  }
  if (rows.length === 0) {
    const anyAvailable = claude?.available === true || codex?.available === true;
    return anyAvailable ? (
      <EmptyState
        reason="valid_zero"
        detail="No agent has written to a transcript in the last 10 minutes."
        compact={compact}
      />
    ) : (
      <EmptyState
        reason="not_installed"
        detail="Neither Claude Code nor Codex was detected on this machine."
        compact={compact}
      />
    );
  }

  const running = rows.filter((r) => activityOf(r.ageSecs) === "running").length;

  if (compact) {
    const top = rows[0]; // sorted by age ascending, so [0] is the freshest
    return (
      <>
        <div className="stat-grid stat-grid-2">
          <Stat value={running} label="running" hint="Transcripts written in the last 2 minutes" />
          <Stat value={rows.length} label="sessions" hint="Transcripts written in the last 10 minutes" />
        </div>
        <div className="muted small ip-line">
          {redactor.session(top.name) ?? top.name} · {activityOf(top.ageSecs)} ·{" "}
          {fmtDuration(top.ageSecs)}
        </div>
      </>
    );
  }

  const expanded = density === "expanded";
  const shown = rows.slice(0, rowBudget(density));
  const hidden = rows.length - shown.length;
  const firstHidden = rows[shown.length];
  const counted = rows.filter((r) => r.tokens != null);
  const tokenTotal = counted.reduce((a, r) => a + (r.tokens ?? 0), 0);
  return (
    <>
      <div className={`stat-grid${expanded ? "" : " stat-grid-2"}`}>
        <Stat value={running} label="running" hint="Transcripts written in the last 2 minutes" />
        <Stat value={rows.length} label="sessions" hint="Transcripts written in the last 10 minutes" />
        {expanded && (
          <Stat
            value={counted.length === 0 ? "—" : fmtTokens(tokenTotal)}
            label="tokens"
            hint={
              counted.length === 0
                ? NO_TOKENS
                : `Summed over ${counted.length} of ${rows.length} sessions; the rest record no token count`
            }
          />
        )}
      </div>
      <div className="drow-list">
        {shown.map((row) => (
          <Row
            key={row.id}
            row={row}
            redactor={redactor}
            actionsEnabled={actionsEnabled}
            onOpenRepo={onOpenRepo}
            onInspect={onInspect}
          />
        ))}
      </div>
      {/* Without an inspector to send the reader to, the truncation can only be
          reported, not resolved. */}
      {onInspect && firstHidden ? (
        <RowOverflow hidden={hidden} noun="sessions" onOpen={() => onInspect(firstHidden)} />
      ) : hidden > 0 ? (
        <div className="proc-footer muted small">
          {hidden} more session(s) not shown — enlarge the card
        </div>
      ) : null}
    </>
  );
}
