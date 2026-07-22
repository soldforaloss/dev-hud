// GitHub repositories.
//
// The repo slug is the identifying value here, so the *rendered* name always
// comes from the redactor; the raw slug is only ever handed to `open_url` and
// to the inspector, never printed into the DOM.

import { invoke } from "@tauri-apps/api/core";
import type { JSX } from "react";
import type { GithubPayload, RepoStatus } from "../types";
import type { Redactor } from "../model/privacy";
import { safeText } from "../model/privacy";
import { fmtAgo, fmtTokens } from "../format";
import { EmptyState, Stat } from "./StatusBits";
import { DataRow, RowOverflow } from "./DataRow";
import { rowBudget, useCardDensity } from "./density";
import { Dot } from "./viz";

const NO_STARS = "star count not returned by the API";
const NO_PRS = "open PR count not returned by the API";
const NO_ISSUES = "open issue count not returned by the API";
const NO_RELEASE = "this repository has published no release";
const NO_PUSH = "push time not returned by the API";
const NO_BRANCH = "default branch not returned by the API";
const AUTH_HINT = "Run `gh auth login` in a terminal, then re-check this card.";

function ciState(status: string | null): "good" | "warn" | "bad" | "off" {
  switch (status) {
    case "success":
      return "good";
    case "failure":
    case "cancelled":
    case "timed_out":
      return "bad";
    case "pending":
      return "warn";
    default:
      return "off";
  }
}

/** A release is "new" if unseen and published within the last 14 days. */
function isNewRelease(r: RepoStatus, seen: Record<string, string>): boolean {
  if (!r.release) return false;
  if (seen[r.repo] === r.release.tag) return false;
  if (!r.release.publishedAt) return false;
  const age = Date.now() - new Date(r.release.publishedAt).getTime();
  return age < 14 * 86_400_000;
}

function Row({
  r,
  seen,
  redactor,
  onInspect,
}: {
  r: RepoStatus;
  seen: Record<string, string>;
  redactor: Redactor;
  onInspect: (repo: string) => void;
}) {
  const open = (url: string) => void invoke("open_url", { url });
  const slug = redactor.repo(r.repo) ?? r.repo;
  const name = slug.split("/")[1] ?? slug;

  if (!r.ok) {
    // A repository we cannot read still gets a row, because "missing from the
    // list" and "failed to load" are different facts.
    const message = safeText(redactor, r.error) ?? "unreadable";
    return (
      <DataRow
        lead={<Dot state="off" title="this repository could not be read" />}
        primary={name}
        secondary={message}
        tone="bad"
        title={`${slug} — ${message}`}
        onOpen={() => onInspect(r.repo)}
      />
    );
  }

  const fresh = isNewRelease(r, seen);
  const ciLabel = r.ciStatus ?? "no run";
  const tag = r.release?.tag ?? null;
  // An unseen release is the one destination that beats the repo page, and
  // following it is exactly what marks it seen. Once seen, ↗ is the repo again.
  const target = fresh && r.release ? r.release : null;
  return (
    <DataRow
      lead={<Dot state={ciState(r.ciStatus)} title={`CI: ${ciLabel}`} />}
      primary={name}
      secondary={r.defaultBranch ?? "—"}
      value={target ? "NEW" : `★ ${r.stars != null ? fmtTokens(r.stars) : "—"}`}
      valueHint={
        target
          ? `${target.tag} was released ${r.release?.publishedAt ? fmtAgo(r.release.publishedAt) : "recently"} — open it from the inspector`
          : r.stars == null
            ? NO_STARS
            : `${r.stars} stars`
      }
      valueTone={target ? "var(--good)" : undefined}
      title={[
        slug,
        `CI: ${ciLabel}`,
        r.defaultBranch ? `default branch ${r.defaultBranch}` : NO_BRANCH,
        r.stars == null ? NO_STARS : `${r.stars} stars`,
        r.openPrs == null ? NO_PRS : `${r.openPrs} open pull requests`,
        r.openIssues == null ? NO_ISSUES : `${r.openIssues} open issues`,
        tag
          ? `release ${tag}${r.release?.publishedAt ? ` · ${fmtAgo(r.release.publishedAt)}` : ""}`
          : NO_RELEASE,
        r.pushedAt ? `pushed ${fmtAgo(r.pushedAt)}` : NO_PUSH,
      ].join("\n")}
      onOpen={() => onInspect(r.repo)}
      action={{
        icon: "↗",
        label: `Open ${slug} on GitHub`,
        hint: `Opens ${slug} on GitHub`,
        onSelect: () => open(`https://github.com/${r.repo}`),
      }}
    />
  );
}

export function ReposCardBody({
  payload,
  seen,
  redactor,
  onInspect,
}: {
  payload: GithubPayload | null;
  seen: Record<string, string>;
  redactor: Redactor;
  onInspect: (repo: string) => void;
}): JSX.Element {
  const density = useCardDensity();
  const compact = density === "compact";

  if (!payload) {
    return <EmptyState reason="no_data" detail="Waiting for the first GitHub query." compact={compact} />;
  }
  // A failed call is not an empty account — say which one it was, and what to
  // type to fix it.
  if (payload.error) {
    const message = safeText(redactor, payload.error) ?? "the GitHub API call failed";
    return (
      <EmptyState
        reason={payload.authenticated ? "collector_error" : "not_configured"}
        detail={payload.authenticated ? message : `${message}. ${AUTH_HINT}`}
        compact={compact}
      />
    );
  }
  if (!payload.authenticated) {
    return (
      <EmptyState reason="not_configured" detail={`Not signed in to GitHub. ${AUTH_HINT}`} compact={compact} />
    );
  }
  if (payload.repos.length === 0) {
    return (
      <EmptyState
        reason="valid_zero"
        detail="This account has no repositories the token can see."
        compact={compact}
      />
    );
  }

  const broken = payload.repos.filter((r) => !r.ok);
  const failing = payload.repos.filter((r) => r.ok && ciState(r.ciStatus) === "bad");
  const fresh = payload.repos.filter((r) => isNewRelease(r, seen));

  if (compact) {
    return (
      <div className="stat-grid stat-grid-2">
        <Stat value={payload.repos.length} label="repos" hint="Repositories returned for this account" />
        <Stat
          value={failing.length}
          label="failing CI"
          hint={
            failing.length === 0
              ? "No repository reports a failed CI run. Repositories with no run at all are not counted."
              : failing.map((r) => redactor.repo(r.repo)).join(", ")
          }
          tone={failing.length > 0 ? "var(--bad)" : undefined}
        />
      </div>
    );
  }

  const shown = payload.repos.slice(0, rowBudget(density));
  const firstHidden = payload.repos[shown.length];
  return (
    <>
      <div className="drow-list">
        {shown.map((r) => (
          <Row
            key={r.repo}
            r={r}
            seen={seen}
            redactor={redactor}
            onInspect={onInspect}
          />
        ))}
      </div>
      {firstHidden && (
        <RowOverflow
          hidden={payload.repos.length - shown.length}
          noun="repositories"
          onOpen={() => onInspect(firstHidden.repo)}
        />
      )}
      <div className="proc-footer muted small">
        {payload.repos.length} repositories
        {fresh.length > 0 ? ` · ${fresh.length} new release(s)` : ""}
        {failing.length > 0 ? ` · ${failing.length} failing CI` : ""}
        {broken.length > 0 ? ` · ${broken.length} unreadable` : ""}
      </div>
    </>
  );
}
