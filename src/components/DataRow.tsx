// The one row every list card uses.
//
// Two layout columns, and only two:
//
//   [dot] identity …………………………………………  value
//    8px  the only thing that truncates   fixed
//
// Two children cannot collide, so "elements overlapping at awkward widths" is
// not a bug that can occur here — it is excluded by the structure. Only one
// element is ever allowed to truncate, and it is always the same one, so a
// card narrowing behaves predictably instead of breaking somewhere new each
// time.
//
// Everything else — a second metric, badges, the pid, the full command, every
// action — is in the inspector, which the whole row opens. The hover action is
// absolutely positioned, so it costs zero layout width and cannot push
// anything.

import type { ReactNode } from "react";

export interface RowAction {
  /** A single glyph. Anything needing a word belongs in the inspector. */
  icon: string;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  hint?: string;
}

export interface DataRowProps {
  /** Status dot. Fixed width, never grows. */
  lead?: ReactNode;
  /** The identifier — the only element allowed to truncate. */
  primary: ReactNode;
  /** Dim continuation of the identifier; truncates with it, not beside it. */
  secondary?: ReactNode;
  /** One short value. Never truncated, never moves. */
  value?: ReactNode;
  /** What the value means — a bare number is never left unexplained. */
  valueHint?: string;
  valueTone?: string;
  /** Opens the inspector for this entity. */
  onOpen?: () => void;
  /** The row's one obvious verb. Overlaid on hover; costs no layout width. */
  action?: RowAction;
  /** Full detail for the tooltip; the readable version is in the inspector. */
  title?: string;
  /** Needs attention — paired with the tooltip, never colour alone. */
  tone?: "warn" | "bad";
}

export function DataRow({
  lead,
  primary,
  secondary,
  value,
  valueHint,
  valueTone,
  onOpen,
  action,
  title,
  tone,
}: DataRowProps) {
  const body = (
    <>
      {lead ? (
        <span className="drow-lead" aria-hidden="true">
          {lead}
        </span>
      ) : null}
      <span className="drow-primary">
        {primary}
        {secondary ? <span className="drow-dim"> {secondary}</span> : null}
      </span>
      {value != null && value !== "" ? (
        <span
          className="drow-value"
          title={valueHint}
          aria-label={valueHint}
          style={valueTone ? { color: valueTone } : undefined}
        >
          {value}
        </span>
      ) : null}
    </>
  );

  return (
    <div className={`drow${tone ? ` drow-${tone}` : ""}`} title={title}>
      {onOpen ? (
        <button className="drow-open" onClick={onOpen} title={title}>
          {body}
        </button>
      ) : (
        <span className="drow-open drow-static">{body}</span>
      )}
      {action ? (
        <button
          className="drow-action"
          onClick={action.onSelect}
          disabled={action.disabled}
          aria-label={action.label}
          title={action.hint ?? action.label}
        >
          <span aria-hidden="true">{action.icon}</span>
        </button>
      ) : null}
    </div>
  );
}

/**
 * "3 more" footer for a list the card was too short to finish.
 *
 * A truncated list that does not say it is truncated is a lie, and the point
 * of moving detail behind a click is that the click must be findable.
 */
export function RowOverflow({
  hidden,
  onOpen,
  noun,
}: {
  hidden: number;
  onOpen: () => void;
  noun: string;
}) {
  if (hidden <= 0) return null;
  return (
    <button className="drow-more" onClick={onOpen}>
      {hidden} more {noun}
    </button>
  );
}
