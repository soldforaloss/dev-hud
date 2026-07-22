// Persistent alert center.
//
// Toasts are still delivered, but a toast is a notification, not a record.
// Everything the toast said — when it started, what the value was, what the
// threshold was, what recovered it and when — lives here and survives both
// dismissal and restart.

import { useState } from "react";
import type { AlertRecord, AlertState } from "../model/alerts";
import { rankAlerts } from "../model/alerts";
import type { Redactor } from "../model/privacy";
import type { IncidentSnapshot } from "../model/snapshots";
import { fmtBytes, fmtClock, fmtSpan } from "../format";
import { EmptyState } from "./StatusBits";

type Tab = "open" | "history" | "snapshots";

export interface AlertCenterProps {
  alerts: AlertRecord[];
  snapshots: IncidentSnapshot[];
  redactor: Redactor;
  nowMs: number;
  onAcknowledge: (id: string) => void;
  onSnooze: (id: string, minutes: number) => void;
  onFocusCard: (cardId: string) => void;
  onCaptureSnapshot: () => void;
  onOpenSnapshot: (id: string) => void;
  onDeleteSnapshot: (id: string) => void;
  onClose: () => void;
}

export function AlertCenter({
  alerts,
  snapshots,
  redactor,
  nowMs,
  onAcknowledge,
  onSnooze,
  onFocusCard,
  onCaptureSnapshot,
  onOpenSnapshot,
  onDeleteSnapshot,
  onClose,
}: AlertCenterProps) {
  const [tab, setTab] = useState<Tab>("open");
  const open = rankAlerts(alerts.filter((a) => a.state !== "recovered" && a.armed));
  const history = alerts
    .filter((a) => a.state === "recovered")
    .sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt));

  return (
    <section className="panel" role="region" aria-label="Alert center">
      <header className="panel-head">
        <h2 className="panel-title">Alert center</h2>
        <nav className="panel-tabs" role="tablist">
          <Tabs tab={tab} setTab={setTab} counts={{ open: open.length, history: history.length, snapshots: snapshots.length }} />
        </nav>
        <span className="head-spacer" />
        <button className="icon-btn" onClick={onClose} aria-label="Close alert center">
          ✕
        </button>
      </header>

      <div className="panel-body">
        {tab === "open" &&
          (open.length === 0 ? (
            <EmptyState
              reason="valid_zero"
              detail="Nothing is firing. Recovered alerts move to History."
            />
          ) : (
            open.map((a) => (
              <AlertRow
                key={a.id}
                alert={a}
                redactor={redactor}
                nowMs={nowMs}
                onAcknowledge={onAcknowledge}
                onSnooze={onSnooze}
                onFocusCard={onFocusCard}
              />
            ))
          ))}

        {tab === "history" &&
          (history.length === 0 ? (
            <EmptyState reason="no_data" detail="No alert has recovered yet this session." />
          ) : (
            history.map((a) => (
              <AlertRow
                key={a.id}
                alert={a}
                redactor={redactor}
                nowMs={nowMs}
                onAcknowledge={onAcknowledge}
                onSnooze={onSnooze}
                onFocusCard={onFocusCard}
              />
            ))
          ))}

        {tab === "snapshots" && (
          <>
            <div className="btn-row">
              <button className="btn btn-slim" onClick={onCaptureSnapshot}>
                Capture snapshot now
              </button>
            </div>
            {snapshots.length === 0 ? (
              <EmptyState
                reason="valid_zero"
                detail="Snapshots are captured automatically when a critical alert opens, or manually here. All values are redacted before they are stored."
              />
            ) : (
              snapshots.map((s) => (
                <div className="snap-row" key={s.id}>
                  <button
                    className="snap-open"
                    onClick={() => onOpenSnapshot(s.id)}
                    title={s.reason}
                  >
                    <span className="snap-time">{fmtClock(s.atMs)}</span>
                    <span className="snap-reason">{s.reason}</span>
                    <span className="muted small">{fmtBytes(s.sizeBytes)}</span>
                  </button>
                  <button
                    className="btn btn-slim btn-danger"
                    onClick={() => onDeleteSnapshot(s.id)}
                    aria-label={`Delete snapshot from ${fmtClock(s.atMs)}`}
                  >
                    Delete
                  </button>
                </div>
              ))
            )}
          </>
        )}
      </div>
    </section>
  );
}

function Tabs({
  tab,
  setTab,
  counts,
}: {
  tab: Tab;
  setTab: (t: Tab) => void;
  counts: Record<Tab, number>;
}) {
  const entries: [Tab, string][] = [
    ["open", "Open"],
    ["history", "History"],
    ["snapshots", "Snapshots"],
  ];
  return (
    <>
      {entries.map(([id, label]) => (
        <button
          key={id}
          role="tab"
          aria-selected={tab === id}
          className={`panel-tab${tab === id ? " panel-tab-on" : ""}`}
          onClick={() => setTab(id)}
        >
          {label} ({counts[id]})
        </button>
      ))}
    </>
  );
}

function AlertRow({
  alert,
  redactor,
  nowMs,
  onAcknowledge,
  onSnooze,
  onFocusCard,
}: {
  alert: AlertRecord;
  redactor: Redactor;
  nowMs: number;
  onAcknowledge: (id: string) => void;
  onSnooze: (id: string, minutes: number) => void;
  onFocusCard: (cardId: string) => void;
}) {
  const first = Date.parse(alert.firstSeenAt);
  const end = alert.recoveredAt ? Date.parse(alert.recoveredAt) : nowMs;
  return (
    <article className={`alert-row alert-${alert.severity} alert-state-${alert.state}`}>
      <header className="alert-row-head">
        <span className="alert-sev" aria-label={`Severity ${alert.severity}`}>
          {alert.severity === "critical" ? "■ Critical" : alert.severity === "warning" ? "▲ Warning" : "● Info"}
        </span>
        <button className="alert-title" onClick={() => onFocusCard(alert.cardId)}>
          {redactor.text(alert.title)}
        </button>
        <span className="alert-state-tag">{stateLabel(alert.state)}</span>
      </header>
      <p className="alert-message">{redactor.text(alert.message)}</p>
      <dl className="alert-facts">
        <Fact k="First seen" v={fmtClock(first)} />
        <Fact k="Last seen" v={fmtClock(Date.parse(alert.lastSeenAt))} />
        <Fact k="Duration" v={fmtSpan(first, end)} />
        {alert.currentValue != null ? <Fact k="Value" v={String(alert.currentValue)} /> : null}
        {alert.threshold != null ? <Fact k="Threshold" v={String(alert.threshold)} /> : null}
        {alert.recoveredAt ? <Fact k="Recovered" v={fmtClock(Date.parse(alert.recoveredAt))} /> : null}
      </dl>
      {alert.relatedEntities.length > 0 && (
        <div className="alert-entities">
          {alert.relatedEntities.slice(0, 6).map((e, i) => (
            <span className="chip" key={`${e.kind}-${e.id}-${i}`}>
              {redactor.text(e.label)}
            </span>
          ))}
        </div>
      )}
      {alert.suggestedActions && alert.suggestedActions.length > 0 && (
        <p className="muted small">Suggested: {alert.suggestedActions.join(" · ")}</p>
      )}
      {alert.state !== "recovered" && (
        <div className="btn-row">
          <button className="btn btn-slim" onClick={() => onAcknowledge(alert.id)}>
            Acknowledge
          </button>
          <button className="btn btn-slim" onClick={() => onSnooze(alert.id, 30)}>
            Snooze 30m
          </button>
          <button className="btn btn-slim" onClick={() => onSnooze(alert.id, 240)}>
            Snooze 4h
          </button>
        </div>
      )}
    </article>
  );
}

function stateLabel(state: AlertState): string {
  return state === "active"
    ? "Active"
    : state === "acknowledged"
      ? "Acknowledged"
      : state === "snoozed"
        ? "Snoozed"
        : "Recovered";
}

function Fact({ k, v }: { k: string; v: string }) {
  return (
    <div className="alert-fact">
      <dt>{k}</dt>
      <dd>{v}</dd>
    </div>
  );
}
