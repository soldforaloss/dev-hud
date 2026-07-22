// Shared status presentation primitives.
//
// Every one of these carries a text or glyph signal in addition to colour, and
// an accessible label — the HUD must stay readable in greyscale and to a
// screen reader.

import type { ReactNode } from "react";
import type {
  ActivityState,
  AttentionState,
  EmptyReason,
  FreshnessState,
  HealthState,
} from "../model/status";
import {
  ACTIVITY_LABEL,
  ATTENTION_GLYPH,
  ATTENTION_LABEL,
  EMPTY_TITLE,
  FRESHNESS_GLYPH,
  FRESHNESS_LABEL,
  HEALTH_GLYPH,
  HEALTH_LABEL,
} from "../model/status";

export function HealthBadge({
  health,
  detail,
  compact,
}: {
  health: HealthState;
  detail?: string;
  compact?: boolean;
}) {
  const label = HEALTH_LABEL[health];
  return (
    <span
      className={`sbadge sbadge-health sbadge-${health}`}
      role="status"
      aria-label={detail ? `${label}. ${detail}` : label}
      title={detail ? `${label} — ${detail}` : label}
    >
      <span aria-hidden="true">{HEALTH_GLYPH[health]}</span>
      {!compact && <span className="sbadge-text">{label}</span>}
    </span>
  );
}

export function AttentionBadge({
  attention,
  detail,
  compact,
}: {
  attention: AttentionState;
  detail?: string;
  compact?: boolean;
}) {
  if (attention === "normal") return null;
  const label = ATTENTION_LABEL[attention];
  return (
    <span
      className={`sbadge sbadge-attn sbadge-${attention}`}
      role="status"
      aria-label={detail ? `${label}. ${detail}` : label}
      title={detail ? `${label} — ${detail}` : label}
    >
      <span aria-hidden="true">{ATTENTION_GLYPH[attention]}</span>
      {!compact && <span className="sbadge-text">{label}</span>}
    </span>
  );
}

export function FreshnessBadge({
  freshness,
  detail,
  compact,
}: {
  freshness: FreshnessState;
  detail?: string;
  compact?: boolean;
}) {
  // "Live" is the expected case — showing it on every card is noise.
  if (freshness === "live") return null;
  const label = FRESHNESS_LABEL[freshness];
  return (
    <span
      className={`sbadge sbadge-fresh sbadge-${freshness}`}
      role="status"
      aria-label={detail ? `${label} data. ${detail}` : `${label} data`}
      title={detail ? `${label} — ${detail}` : label}
    >
      <span aria-hidden="true">{FRESHNESS_GLYPH[freshness]}</span>
      {!compact && <span className="sbadge-text">{label}</span>}
    </span>
  );
}

export function ActivityBadge({ activity }: { activity: ActivityState }) {
  return (
    <span
      className={`sbadge sbadge-activity sbadge-act-${activity}`}
      aria-label={`Activity: ${ACTIVITY_LABEL[activity]}`}
      title={ACTIVITY_LABEL[activity]}
    >
      {ACTIVITY_LABEL[activity]}
    </span>
  );
}

export interface EmptyStateAction {
  label: string;
  onSelect: () => void;
  /** Marks an action that changes system state — styled and confirmed apart. */
  destructive?: boolean;
}

/**
 * The single component every card uses for "there is nothing to show".
 *
 * `reason` is required precisely so the six different nothings — a legitimate
 * zero, an unconfigured source, a denied permission, a dead collector — can
 * never collapse into one grey "—".
 */
export function EmptyState({
  reason,
  detail,
  actions = [],
  compact,
}: {
  reason: EmptyReason;
  detail?: ReactNode;
  actions?: EmptyStateAction[];
  compact?: boolean;
}) {
  return (
    <div className={`empty empty-${reason}`} data-empty-reason={reason} role="note">
      <div className="empty-title">{EMPTY_TITLE[reason]}</div>
      {detail && !compact ? <div className="empty-detail muted small">{detail}</div> : null}
      {actions.length > 0 && (
        <div className="btn-row">
          {actions.map((a) => (
            <button
              key={a.label}
              className={`btn btn-slim${a.destructive ? " btn-danger" : ""}`}
              onClick={a.onSelect}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Value + unit + freshness, the standard way a single number is rendered. */
export function Stat({
  value,
  label,
  hint,
  tone,
  freshness,
  sub,
}: {
  value: ReactNode;
  label: ReactNode;
  hint?: string;
  tone?: string;
  freshness?: FreshnessState;
  sub?: ReactNode;
}) {
  return (
    <div className="stat" title={hint}>
      <div className="stat-num" style={tone ? { color: tone } : undefined}>
        {value}
      </div>
      <div className="stat-label">
        {label}
        {freshness && freshness !== "live" ? (
          <span className="stat-fresh" aria-label={FRESHNESS_LABEL[freshness]}>
            {" "}
            {FRESHNESS_GLYPH[freshness]}
          </span>
        ) : null}
      </div>
      {sub}
    </div>
  );
}
