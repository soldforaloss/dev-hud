// Local git working copies.
//
// Read-only by design: every action here either opens something or fetches.
// Nothing in this card can rewrite history, stage, discard or push — a HUD
// that can destroy uncommitted work at one click is not a HUD.

import type { JSX } from "react";
import type { LocalRepo, LocalReposStatus } from "../types";
import type { Redactor } from "../model/privacy";
import { safeText } from "../model/privacy";
import { fmtAgoMs } from "../format";
import { EmptyState } from "./StatusBits";
import { DataRow, RowOverflow } from "./DataRow";
import { rowBudget, useCardDensity } from "./density";
import { Dot } from "./viz";

const NO_TEST_COMMAND = "No test command detected in this project";
const NO_COMMIT = "no commits on this branch yet";
const NO_BRANCH = "detached HEAD or unborn branch";
const ACTIONS_OFF = "Operator actions are switched off for this card in Settings";

function RepoRow({
  repo,
  redactor,
  actionsEnabled,
  onOpenFolder,
  onInspect,
}: {
  repo: LocalRepo;
  redactor: Redactor;
  actionsEnabled: boolean;
  onOpenFolder: (path: string) => void;
  onInspect?: (repo: LocalRepo) => void;
}) {
  const name = redactor.repo(repo.name) ?? repo.name;
  const path = redactor.path(repo.path) ?? repo.path;

  if (repo.error) {
    // A working copy we cannot read must not take the rest of the list with it.
    const message = safeText(redactor, repo.error) ?? "unreadable";
    return (
      <div className="repo repo-err" title={`${name} — ${message}`}>
        <span className="repo-name">{name}</span>
        <span className="muted small">{message}</span>
      </div>
    );
  }

  const committedMs = repo.lastCommitUnix == null ? null : Date.now() - repo.lastCommitUnix * 1000;
  const subject = safeText(redactor, repo.lastCommitSubject);
  const slug = redactor.repo(repo.remoteSlug);
  const dirty = repo.dirtyCount > 0;
  // Zero ahead/behind is a real zero and reads as "clean" — show nothing.
  const drift = [repo.ahead > 0 ? `↑${repo.ahead}` : null, repo.behind > 0 ? `↓${repo.behind}` : null]
    .filter(Boolean)
    .join(" ");

  return (
    <DataRow
      lead={
        <Dot
          state={dirty ? "warn" : "good"}
          title={dirty ? `${repo.dirtyCount} file(s) with uncommitted changes` : "working tree clean"}
        />
      }
      primary={name}
      secondary={repo.branch ?? "—"}
      value={drift || (dirty ? `${repo.dirtyCount}✎` : undefined)}
      valueHint={
        drift
          ? `${repo.ahead} commit(s) ahead, ${repo.behind} behind upstream`
          : dirty
            ? `${repo.dirtyCount} file(s) with uncommitted changes`
            : undefined
      }
      tone={dirty ? "warn" : undefined}
      title={[
        name,
        path,
        repo.branch ? `branch ${repo.branch}` : NO_BRANCH,
        repo.upstream ? `upstream ${repo.upstream}` : "branch has no upstream",
        slug ? `remote ${slug}` : "no remote configured",
        dirty ? `${repo.dirtyCount} file(s) with uncommitted changes` : "working tree clean",
        subject ? `${subject} · ${fmtAgoMs(committedMs)}` : NO_COMMIT,
        safeText(redactor, repo.testCommand) ?? NO_TEST_COMMAND,
      ].join("\n")}
      onOpen={onInspect ? () => onInspect(repo) : undefined}
      action={{
        icon: "↗",
        label: `Open folder for ${name}`,
        hint: actionsEnabled ? `Opens ${path}` : ACTIONS_OFF,
        disabled: !actionsEnabled,
        onSelect: () => onOpenFolder(repo.path),
      }}
    />
  );
}

export function GitCardBody({
  status,
  redactor,
  actionsEnabled,
  onOpenFolder,
  onInspect,
  onAddRoot,
}: {
  status: LocalReposStatus | null;
  redactor: Redactor;
  actionsEnabled: boolean;
  onOpenFolder: (path: string) => void;
  onInspect?: (repo: LocalRepo) => void;
  onAddRoot: () => void;
}): JSX.Element {
  const density = useCardDensity();
  const compact = density === "compact";

  // Configuring a scan root is how the user escapes the empty state, so it is
  // offered even when operator actions are switched off.
  const addRoot = { label: "Add a repository folder", onSelect: onAddRoot };

  if (!status) {
    return (
      <EmptyState
        reason="no_data"
        detail="Waiting for the first scan of the configured folders."
        compact={compact}
      />
    );
  }
  if (!status.gitAvailable) {
    return <EmptyState reason="not_installed" detail="git was not found on PATH." compact={compact} />;
  }
  if (status.roots.length === 0) {
    return (
      <EmptyState
        reason="not_configured"
        detail="No folders are being scanned for git working copies."
        actions={[addRoot]}
        compact={compact}
      />
    );
  }
  if (status.repos.length === 0) {
    return (
      <EmptyState
        reason="valid_zero"
        detail={`Scanned ${status.roots.length} folder(s) and found no git working copies.`}
        actions={[addRoot]}
        compact={compact}
      />
    );
  }

  const shown = status.repos.slice(0, rowBudget(density));
  const hidden = status.repos.length - shown.length;
  const firstHidden = status.repos[shown.length];
  const dirty = status.repos.filter((r) => !r.error && r.dirtyCount > 0).length;
  const broken = status.repos.filter((r) => r.error).length;
  return (
    <>
      <div className="drow-list">
        {shown.map((repo) => (
          <RepoRow
            key={repo.path}
            repo={repo}
            redactor={redactor}
            actionsEnabled={actionsEnabled}
            onOpenFolder={onOpenFolder}
            onInspect={onInspect}
          />
        ))}
      </div>
      {/* Without an inspector to send the reader to, the truncation can only be
          reported in the footer, not resolved. */}
      {onInspect && firstHidden && (
        <RowOverflow hidden={hidden} noun="working copies" onOpen={() => onInspect(firstHidden)} />
      )}
      {!compact && (
        <div className="proc-footer muted small">
          {status.repos.length} repositories · {dirty} with uncommitted changes
          {broken > 0 ? ` · ${broken} unreadable` : ""}
          {!onInspect && hidden > 0 ? ` · ${hidden} not shown` : ""}
        </div>
      )}
    </>
  );
}
