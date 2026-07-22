// The shared right-side inspector.
//
// Progressive disclosure is the whole point: the board stays glanceable and
// everything detailed — history, provenance, related entities, logs, actions —
// lives here. One component serves both cards and individual entities so
// there is exactly one place that knows how a detail view is laid out.

import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import type { EntityNode, EntityRef } from "../model/entities";
import { ENTITY_GLYPH, ENTITY_LABEL, entityKey } from "../model/entities";
import type { CardStatus } from "../model/cardStatus";
import type { Provenance } from "../model/provenance";
import { dataAgeMs, describePollState, formatInterval } from "../model/provenance";
import type { ActivityEvent } from "../model/events";
import type { AlertRecord } from "../model/alerts";
import type { Redactor } from "../model/privacy";
import type { Series } from "../model/history";
import { seriesStats } from "../model/history";
import { fmtAgoMs, fmtClock, fmtSpan } from "../format";
import { ActivityBadge, AttentionBadge, FreshnessBadge, HealthBadge } from "./StatusBits";
import type { CardAction } from "./Card";
import { HistoryChart } from "./viz";

export type InspectorTarget =
  | { kind: "card"; id: string }
  | { kind: "entity"; ref: EntityRef };

export interface InspectorProps {
  target: InspectorTarget;
  title: string;
  status?: CardStatus;
  provenance?: Provenance;
  node?: EntityNode;
  events: ActivityEvent[];
  alerts: AlertRecord[];
  actions: CardAction[];
  history?: Record<string, Series>;
  /** Free-form extra detail supplied by the owning card. */
  extra?: ReactNode;
  redactor: Redactor;
  nowMs: number;
  onClose: () => void;
  onNavigate: (ref: EntityRef) => void;
  onCopyDiagnostics: () => void;
}

export function Inspector({
  target,
  title,
  status,
  provenance,
  node,
  events,
  alerts,
  actions,
  history,
  extra,
  redactor,
  nowMs,
  onClose,
  onNavigate,
  onCopyDiagnostics,
}: InspectorProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const restoreFocus = useRef<Element | null>(null);

  useEffect(() => {
    restoreFocus.current = document.activeElement;
    panelRef.current?.focus();
    return () => {
      if (restoreFocus.current instanceof HTMLElement) restoreFocus.current.focus();
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      // Keep Tab inside the panel — it is a modal surface over the board.
      if (e.key !== "Tab" || !panelRef.current) return;
      const focusable = panelRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const targetKey = target.kind === "card" ? `card:${target.id}` : entityKey(target.ref);

  return (
    <aside
      className="inspector"
      role="dialog"
      aria-modal="true"
      aria-label={`${title} inspector`}
      tabIndex={-1}
      ref={panelRef}
    >
      <header className="insp-head">
        <span className="insp-kind">
          {target.kind === "entity" ? (
            <>
              <span aria-hidden="true">{ENTITY_GLYPH[target.ref.kind]}</span>{" "}
              {ENTITY_LABEL[target.ref.kind]}
            </>
          ) : (
            "Card"
          )}
        </span>
        <h2 className="insp-title">{title}</h2>
        <button className="icon-btn" onClick={onClose} aria-label="Close inspector (Escape)">
          ✕
        </button>
      </header>

      <div className="insp-body">
        {status && (
          <Section label="Current state">
            <div className="insp-badges">
              <HealthBadge health={status.health} detail={status.statusDetail} />
              <AttentionBadge attention={status.attention} detail={status.statusDetail} />
              {status.activity ? <ActivityBadge activity={status.activity} /> : null}
              <FreshnessBadge freshness={status.freshness} detail={status.statusDetail} />
            </div>
            {status.statusDetail ? <p className="insp-line">{status.statusDetail}</p> : null}
            <p className="insp-line muted small">{status.availabilityReason}</p>
          </Section>
        )}

        {node && node.facts.length > 0 && (
          <Section label="Details">
            <dl className="insp-facts">
              {node.facts.map(([k, v], i) => (
                <div className="insp-fact" key={`${k}-${i}`}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
          </Section>
        )}

        {history && Object.keys(history).length > 0 && (
          <Section label="History">
            {Object.entries(history).map(([name, series]) => {
              const stats = seriesStats(series.points);
              return (
                <div className="insp-series" key={name}>
                  <div className="insp-series-head">
                    <span>{name}</span>
                    <span className="muted small">
                      {stats
                        ? `min ${stats.min.toFixed(1)} · avg ${stats.avg.toFixed(1)} · max ${stats.max.toFixed(1)}`
                        : "no samples yet"}
                    </span>
                  </div>
                  <HistoryChart points={series.points} />
                  {series.oldestMs ? (
                    <div className="muted small">since {fmtClock(series.oldestMs)}</div>
                  ) : null}
                </div>
              );
            })}
          </Section>
        )}

        {node && node.relations.length > 0 && (
          <Section label="Related">
            <div className="insp-relations">
              {node.relations.map((r, i) => (
                <button
                  key={`${r.label}-${entityKey(r.to)}-${i}`}
                  className="insp-relation"
                  onClick={() => onNavigate(r.to)}
                  title={`${r.label}: ${ENTITY_LABEL[r.to.kind]} ${r.to.label}`}
                >
                  <span className="insp-rel-label">{r.label}</span>
                  <span className="insp-rel-glyph" aria-hidden="true">
                    {ENTITY_GLYPH[r.to.kind]}
                  </span>
                  <span className="insp-rel-name">{r.to.label}</span>
                </button>
              ))}
            </div>
          </Section>
        )}

        {provenance && (
          <Section label="Data provenance">
            <dl className="insp-facts">
              <Fact k="Collector" v={provenance.source} />
              <Fact k="Command" v={provenance.command} />
              <Fact k="Polling" v={describePollState(provenance)} />
              <Fact k="Interval" v={formatInterval(provenance.intervalMs)} />
              <Fact
                k="Last attempt"
                v={provenance.lastAttemptAt ? fmtAgoMs(nowMs - provenance.lastAttemptAt) : "never"}
              />
              <Fact k="Last success" v={fmtAgoMs(dataAgeMs(provenance, nowMs))} />
              <Fact
                k="Poll duration"
                v={provenance.lastDurationMs != null ? `${provenance.lastDurationMs} ms` : "—"}
              />
              <Fact
                k="Outcomes"
                v={`${provenance.successCount} ok · ${provenance.failureCount} failed`}
              />
              {provenance.requires ? <Fact k="Requires" v={provenance.requires} /> : null}
              {provenance.lastError ? (
                <Fact k="Last error" v={redactor.text(provenance.lastError) ?? ""} />
              ) : null}
            </dl>
          </Section>
        )}

        {alerts.length > 0 && (
          <Section label="Alerts">
            <ul className="insp-list">
              {alerts.map((a) => (
                <li key={a.id} className={`insp-alert insp-alert-${a.severity}`}>
                  <span className="insp-alert-title">{redactor.text(a.title)}</span>
                  <span className="muted small">
                    {a.state} · {fmtSpan(Date.parse(a.firstSeenAt), a.recoveredAt ? Date.parse(a.recoveredAt) : nowMs)}
                  </span>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {extra ? <Section label="More">{extra}</Section> : null}

        {events.length > 0 && (
          <Section label="Recent events">
            <ul className="insp-list">
              {events.slice(0, 20).map((e) => (
                <li key={e.id} className={`insp-event insp-event-${e.severity}`}>
                  <span className="insp-event-time">{fmtClock(e.atMs)}</span>
                  <span className="insp-event-title">{redactor.text(e.title)}</span>
                </li>
              ))}
            </ul>
          </Section>
        )}

        <Section label="Actions">
          <div className="insp-actions">
            {actions.map((a) => (
              <button
                key={a.label}
                className={`btn btn-slim${a.destructive ? " btn-danger" : ""}`}
                disabled={a.disabled}
                title={a.hint}
                onClick={a.onSelect}
              >
                {a.label}
              </button>
            ))}
            <button className="btn btn-slim" onClick={onCopyDiagnostics}>
              Copy diagnostics
            </button>
          </div>
          <p className="muted small">Identifier: <code>{targetKey}</code></p>
        </Section>
      </div>
    </aside>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="insp-section">
      <h3 className="insp-section-label">{label}</h3>
      {children}
    </section>
  );
}

function Fact({ k, v }: { k: string; v: string }) {
  return (
    <div className="insp-fact">
      <dt>{k}</dt>
      <dd>{v}</dd>
    </div>
  );
}
