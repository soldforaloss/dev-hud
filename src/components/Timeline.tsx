// The unified event timeline.
//
// Reads top-down as "what changed, in order" so a user can correlate a
// network dip with a gateway error and a container restart without holding
// three cards in their head.

import { useMemo, useState } from "react";
import type { ActivityEvent, EventCategory, EventSeverity } from "../model/events";
import { EVENT_CATEGORY_LABEL, filterEvents } from "../model/events";
import { entityKey } from "../model/entities";
import type { EntityRef } from "../model/entities";
import type { Redactor } from "../model/privacy";
import type { TimeRange } from "../model/settings";
import { TIME_RANGE_MS } from "../model/settings";
import { fmtClock } from "../format";
import { EmptyState } from "./StatusBits";

export interface TimelineProps {
  events: ActivityEvent[];
  redactor: Redactor;
  range: TimeRange;
  nowMs: number;
  onOpenEntity: (ref: EntityRef) => void;
  onClose: () => void;
}

const CATEGORIES: EventCategory[] = [
  "system",
  "network",
  "process",
  "container",
  "repository",
  "agent",
  "gateway",
  "alert",
  "user_action",
];

export function Timeline({ events, redactor, range, nowMs, onOpenEntity, onClose }: TimelineProps) {
  const [active, setActive] = useState<EventCategory[]>([]);
  const [minSeverity, setMinSeverity] = useState<EventSeverity>("info");

  const shown = useMemo(
    () =>
      filterEvents(events, {
        categories: active.length ? active : undefined,
        minSeverity,
        // "Live" means the last few minutes; every other range is explicit.
        sinceMs: nowMs - TIME_RANGE_MS[range],
      }),
    [events, active, minSeverity, range, nowMs],
  );

  const toggle = (c: EventCategory) =>
    setActive((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));

  return (
    <section className="panel" role="region" aria-label="Event timeline">
      <header className="panel-head">
        <h2 className="panel-title">Timeline</h2>
        <span className="muted small">
          last {range === "live" ? "5m" : range} · {shown.length} event
          {shown.length === 1 ? "" : "s"}
        </span>
        <span className="head-spacer" />
        <button className="icon-btn" onClick={onClose} aria-label="Close timeline">
          ✕
        </button>
      </header>

      <div className="timeline-filters">
        {CATEGORIES.map((c) => (
          <button
            key={c}
            className={`chip chip-toggle${active.includes(c) ? " chip-on" : ""}`}
            aria-pressed={active.includes(c)}
            onClick={() => toggle(c)}
          >
            {EVENT_CATEGORY_LABEL[c]}
          </button>
        ))}
        <span className="head-spacer" />
        <label className="tl-sev">
          <span className="muted small">min severity</span>
          <select
            value={minSeverity}
            onChange={(e) => setMinSeverity(e.target.value as EventSeverity)}
            aria-label="Minimum severity"
          >
            <option value="info">info</option>
            <option value="warning">warning</option>
            <option value="critical">critical</option>
          </select>
        </label>
      </div>

      <div className="panel-body">
        {shown.length === 0 ? (
          <EmptyState
            reason="valid_zero"
            detail="Nothing changed in this window. The timeline records changes, not polls."
          />
        ) : (
          <ol className="tl-list">
            {shown.map((e) => (
              <li key={e.id} className={`tl-row tl-${e.severity}`}>
                <span className="tl-time">{fmtClock(e.atMs)}</span>
                <span className="tl-cat">{EVENT_CATEGORY_LABEL[e.category]}</span>
                <span className="tl-body">
                  <span className="tl-title">{redactor.text(e.title)}</span>
                  {e.detail ? (
                    <span className="tl-detail muted small">{redactor.text(e.detail)}</span>
                  ) : null}
                  {e.relatedEntities.length > 0 && (
                    <span className="tl-entities">
                      {e.relatedEntities.slice(0, 4).map((ref) => (
                        <button
                          key={entityKey(ref)}
                          className="chip chip-link"
                          onClick={() => onOpenEntity(ref)}
                          title={`Inspect ${ref.label}`}
                        >
                          {redactor.text(ref.label)}
                        </button>
                      ))}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
