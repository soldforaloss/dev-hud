import { useEffect, useId, useRef, useState } from "react";
import type { CSSProperties, PointerEvent, ReactNode } from "react";
import type { AttentionState, FreshnessState, HealthState } from "../model/status";
import { DensityProvider, useDensity } from "./density";
import type { ResizeEdge } from "./CardCanvas";
import { fmtAgoMs } from "../format";

export interface CardAction {
  label: string;
  onSelect: () => void;
  /** State-changing actions get a confirm step and distinct styling. */
  destructive?: boolean;
  disabled?: boolean;
  hint?: string;
}

/**
 * The shared card shell.
 *
 * The header is the contract every card honours: title, the four independent
 * status dimensions, when the data last landed, an explicit overflow menu for
 * actions (never a bare `×`), and an Inspect affordance. Reordering and
 * resizing use pointer events driven from App — HTML5 drag-and-drop aborts in
 * WebView2 when React re-renders the dragged node.
 */
export function Card({
  id,
  title,
  icon,
  summary,
  collapsed,
  onToggle,
  accent,
  grip,
  dragging,
  resizing,
  blocked,
  onDragStart,
  onResizeStart,
  health = "unknown",
  attention = "normal",
  freshness = "live",
  lastSuccessAt,
  statusDetail,
  actions = [],
  onInspect,
  focused,
  children,
}: {
  id: string;
  title: string;
  icon: ReactNode;
  /** Right-aligned compact info shown even when collapsed. */
  summary?: ReactNode;
  collapsed: boolean;
  onToggle: (id: string) => void;
  accent?: string;
  /** Show the move grip and resize handles (hidden while the board is locked). */
  grip?: boolean;
  dragging?: boolean;
  resizing?: boolean;
  /** The pointer is currently over another card — this position won't commit. */
  blocked?: boolean;
  onDragStart?: (id: string, e: PointerEvent<HTMLElement>) => void;
  onResizeStart?: (id: string, edge: ResizeEdge, e: PointerEvent<HTMLElement>) => void;
  health?: HealthState;
  attention?: AttentionState;
  freshness?: FreshnessState;
  lastSuccessAt?: number | null;
  /** Extra context for the header badges' tooltips/aria labels. */
  statusDetail?: string;
  actions?: CardAction[];
  onInspect?: (id: string) => void;
  focused?: boolean;
  children: ReactNode;
}) {
  // Measure the card frame, never the body. The body's size is a *function of*
  // the density we pick, so observing it closes a feedback loop: denser
  // content grows the box, the bigger box asks for denser content, forever.
  // The frame is sized by the grid, so it is a stable input.
  const frameRef = useRef<HTMLElement | null>(null);
  const density = useDensity(frameRef);
  const style: CSSProperties = {};
  if (accent) {
    Object.assign(style, {
      "--accent": accent,
      "--accent-dim": `color-mix(in srgb, ${accent} 18%, transparent)`,
    });
  }
  const updated = lastSuccessAt ? fmtAgoMs(Date.now() - lastSuccessAt) : null;
  const flag = headerFlag({ health, attention, freshness, statusDetail, updated });

  return (
    <section
      ref={frameRef}
      data-card-id={id}
      data-density={density}
      data-attention={attention}
      data-health={health}
      className={`card${collapsed ? " card-collapsed" : ""}${dragging ? " card-dragging" : ""}${resizing ? " card-resizing" : ""}${blocked ? " card-blocked" : ""}${focused ? " card-focused" : ""}${attention !== "normal" ? ` card-attn-${attention}` : ""}`}
      style={style}
      tabIndex={-1}
      aria-label={`${title} card`}
    >
      <div className="card-head-row">
        <button
          className="card-head"
          onClick={(e) => {
            if ((e.target as HTMLElement).closest(".grip")) return;
            onToggle(id);
          }}
          title={collapsed ? "Expand" : "Collapse"}
          aria-expanded={!collapsed}
        >
          {grip && (
            <span
              className="grip"
              title="Drag to move this card anywhere on the board"
              aria-hidden="true"
              onPointerDown={(e) => onDragStart?.(id, e)}
            >
              ⠿
            </span>
          )}
          <span className="card-icon" aria-hidden="true">
            {icon}
          </span>
          <span className="card-title">{title}</span>
          {/* The header carries the card's name and nothing else. Words here —
              "Healthy", "Active", a summary figure — competed with the title
              for the same line, so every card broke differently as it narrowed.
              One glyph appears when something is wrong, and it is the only
              thing that ever joins the name. */}
          {flag ? (
            <span className="card-flag" role="img" aria-label={flag.label} title={flag.label}>
              {flag.glyph}
            </span>
          ) : null}
          {/* A collapsed card has no body, so the summary is its entire
              content. Expanded, it only ever repeated a number already below. */}
          {collapsed && summary ? <span className="card-summary">{summary}</span> : null}
          <span className={`chevron${collapsed ? " chevron-closed" : ""}`} aria-hidden="true">
            ▾
          </span>
        </button>
        {onInspect && (
          <button
            className="icon-btn card-inspect"
            title={`Inspect ${title}`}
            aria-label={`Inspect ${title}`}
            onClick={() => onInspect(id)}
          >
            ⤢
          </button>
        )}
        {actions.length > 0 && <OverflowMenu title={title} actions={actions} />}
      </div>
      {!collapsed && (
        <div className="card-body">
          <DensityProvider value={density}>{children}</DensityProvider>
        </div>
      )}
      {grip && !collapsed && (
        <>
          <span
            className="resize-edge resize-e"
            title="Drag to change width"
            aria-hidden="true"
            onPointerDown={(e) => onResizeStart?.(id, "e", e)}
          />
          <span
            className="resize-edge resize-s"
            title="Drag to change height"
            aria-hidden="true"
            onPointerDown={(e) => onResizeStart?.(id, "s", e)}
          />
          <span
            className="resize-grip"
            title="Drag to resize in both directions"
            aria-hidden="true"
            onPointerDown={(e) => onResizeStart?.(id, "se", e)}
          >
            ◢
          </span>
        </>
      )}
    </section>
  );
}

/**
 * The single worst thing about a card, as one glyph — and only when it is
 * news.
 *
 * Four status dimensions used to render four badges side by side. In a card
 * two hundred pixels wide that is more status than name. Only the worst one
 * earns a place, it is never a word, and its full meaning is in the label —
 * which is what a screen reader and a tooltip read.
 *
 * `degraded` and `estimated` are deliberately absent. Both are steady states
 * on a normal machine, not events: thermals sit on the WMI fallback whenever
 * LibreHardwareMonitor is not installed, Claude and Codex always estimate
 * rate limits from local logs, an unauthenticated GitHub is degraded forever,
 * and any service you simply do not run is degraded by definition. Marking
 * those puts a glyph on most of the cards most of the time, which is how a
 * signal turns back into decoration. They stay in `data-health`, the tooltip
 * and the inspector, where a standing property belongs.
 *
 * What survives is what changed: attention (which has its own dwell and
 * hysteresis), a card that cannot report at all, and data that stopped
 * arriving.
 */
function headerFlag(s: {
  health: HealthState;
  attention: AttentionState;
  freshness: FreshnessState;
  statusDetail?: string;
  updated: string | null;
}): { glyph: string; label: string } | null {
  const detail = s.statusDetail ? ` — ${s.statusDetail}` : "";
  if (s.attention === "critical") return { glyph: "■", label: `Critical${detail}` };
  if (s.attention === "warning") return { glyph: "▲", label: `Warning${detail}` };
  if (s.health === "unavailable") return { glyph: "○", label: `Unavailable${detail}` };
  if (s.freshness === "stale") {
    return { glyph: "◇", label: `Stale — last update ${s.updated ?? "unknown"}${detail}` };
  }
  return null;
}

/**
 * Explicit action menu. Replaces the old row-level `×` buttons: a destructive
 * action must be named, not guessed from an icon.
 */
export function OverflowMenu({ title, actions }: { title: string; actions: CardAction[] }) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
        setConfirming(null);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className={`overflow-wrap${open ? " overflow-wrap-open" : ""}`} ref={wrapRef}>
      <button
        className={`icon-btn${open ? " icon-btn-active" : ""}`}
        title={`${title} actions`}
        aria-label={`${title} actions`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => {
          setOpen((o) => !o);
          setConfirming(null);
        }}
      >
        ⋯
      </button>
      {open && (
        <div className="overflow-menu" role="menu" id={menuId}>
          {actions.map((a) => {
            const armed = confirming === a.label;
            return (
              <button
                key={a.label}
                role="menuitem"
                className={`overflow-item${a.destructive ? " overflow-danger" : ""}${armed ? " overflow-armed" : ""}`}
                disabled={a.disabled}
                title={a.hint}
                onClick={() => {
                  if (a.destructive && !armed) {
                    setConfirming(a.label);
                    return;
                  }
                  setOpen(false);
                  setConfirming(null);
                  a.onSelect();
                }}
              >
                {armed ? `Confirm: ${a.label}` : a.label}
                {a.destructive && !armed ? <span className="overflow-warn"> ⚠</span> : null}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
