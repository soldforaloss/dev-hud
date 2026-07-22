// The board.
//
// Cards are absolutely positioned from their own rectangles rather than
// flowed, so moving one never displaces another. A drag tracks the pointer
// freely; the *drop* goes to the last position that did not overlap anything,
// which is what makes a card feel like it slides up against its neighbours and
// stops rather than shoving them aside.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import type { Layout, Rect } from "../model/layout";
import {
  COLS,
  HEADROOM,
  MIN_COL_PX,
  clampRect,
  layoutHeight,
  metricsFor,
  slide,
  pxToUnits,
  rectToPx,
  visibleLayout,
} from "../model/layout";

export type ResizeEdge = "e" | "s" | "se";
export type DragMode = "move" | ResizeEdge;

export interface CardHandlers {
  dragging: boolean;
  resizing: boolean;
  /** True while the current pointer position would overlap another card. */
  blocked: boolean;
  onDragStart: (id: string, e: ReactPointerEvent<HTMLElement>) => void;
  onResizeStart: (id: string, edge: ResizeEdge, e: ReactPointerEvent<HTMLElement>) => void;
}

export interface CardCanvasProps {
  ids: string[];
  layout: Layout;
  /** Locked boards are read-only: no drag, no resize, no handles. */
  locked: boolean;
  onLayoutChange: (layout: Layout) => void;
  children: (id: string, handlers: CardHandlers) => ReactNode;
}

interface DragState {
  id: string;
  mode: DragMode;
  pointerX: number;
  pointerY: number;
  origin: Rect;
  /** Where the pointer says the card is — may overlap a neighbour. */
  current: Rect;
  /** How far along that it actually fits — where it will land. */
  resolved: Rect;
}

export function CardCanvas({
  ids,
  layout,
  locked,
  onLayoutChange,
  children,
}: CardCanvasProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  // The ref is the source of truth and is updated synchronously; the state is
  // only a mirror for rendering. Reading geometry back out of state would mean
  // a pointerup arriving in the same task as the last pointermove commits a
  // stale rectangle — the drag would silently do nothing.
  const dragRef = useRef<DragState | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const apply = useCallback((next: DragState | null) => {
    dragRef.current = next;
    setDrag(next);
  }, []);

  // Measured three ways because no single one is reliable everywhere: layout
  // effect for the first paint, ResizeObserver for pane resizes, window resize
  // for environments where the observer never fires.
  const measure = useCallback(() => {
    const el = ref.current;
    if (el) setWidth((w) => (Math.abs(el.clientWidth - w) < 1 ? w : el.clientWidth));
  }, []);
  // Deliberately every commit, not just on mount. A single missed measurement
  // is not a transient glitch here: it silently sizes every card from the
  // canvas minimum and there is nothing to correct it until the window is
  // resized. One clientWidth read per render is far cheaper than that failure.
  useLayoutEffect(measure);
  useEffect(() => {
    window.addEventListener("resize", measure);
    const el = ref.current;
    const observer =
      el && typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    if (el && observer) observer.observe(el);
    return () => {
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, [measure]);

  const metrics = metricsFor(width);
  const visible = visibleLayout(layout, ids);

  // Everything the pointer handlers read, kept in refs. They are attached once
  // per gesture rather than re-attached whenever a prop changes, so a collector
  // updating mid-drag cannot detach the listeners under the pointer.
  const env = useRef({ metrics, visible, layout, onLayoutChange });
  env.current = { metrics, visible, layout, onLayoutChange };
  const detach = useRef<(() => void) | null>(null);

  const begin = useCallback(
    (id: string, mode: DragMode, e: ReactPointerEvent<HTMLElement>) => {
      if (locked) return;
      const origin = env.current.layout[id];
      if (!origin) return;
      e.preventDefault();
      e.stopPropagation();
      apply({
        id, mode,
        pointerX: e.clientX,
        pointerY: e.clientY,
        origin,
        current: origin,
        resolved: origin,
      });

      const move = (ev: globalThis.PointerEvent) => {
        const state = dragRef.current;
        if (!state) return;
        const { metrics: m, visible: vis } = env.current;
        const { dx, dy } = pxToUnits(ev.clientX - state.pointerX, ev.clientY - state.pointerY, m);
        const o = state.origin;
        const raw: Rect =
          state.mode === "move"
            ? { ...o, x: o.x + dx, y: o.y + dy }
            : {
                ...o,
                w: state.mode === "s" ? o.w : o.w + dx,
                h: state.mode === "e" ? o.h : o.h + dy,
              };
        const candidate = clampRect(raw, m.cols);
        apply({
          ...state,
          current: candidate,
          resolved: slide(vis, state.id, state.origin, candidate, m.cols),
        });
      };
      const finish = () => {
        detach.current?.();
        const state = dragRef.current;
        apply(null);
        if (!state) return;
        // Commit the resolved position, so releasing over a neighbour parks the
        // card against its edge instead of cancelling the whole gesture.
        const landed = state.resolved;
        const o = state.origin;
        if (landed.x !== o.x || landed.y !== o.y || landed.w !== o.w || landed.h !== o.h) {
          env.current.onLayoutChange({ ...env.current.layout, [state.id]: landed });
        }
      };

      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", finish);
      // A release outside the window must never leave a drag wedged — that
      // reads as "the board stopped responding".
      window.addEventListener("pointercancel", finish);
      window.addEventListener("blur", finish);
      detach.current = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", finish);
        window.removeEventListener("blur", finish);
        detach.current = null;
      };
    },
    [apply, locked],
  );

  useEffect(() => () => detach.current?.(), []);

  const rows = layoutHeight(visible) + HEADROOM;
  const canvasHeight = rows * metrics.unitH;
  // The true minimum, not cols × unitW — that is container width *plus a gap*,
  // which left the board permanently scrollable sideways by 8px.
  const canvasWidth = metrics.cols * MIN_COL_PX;

  return (
    <div className={`card-canvas${drag ? " card-canvas-active" : ""}`} ref={ref}>
      <div className="cc-surface" style={{ height: canvasHeight, minWidth: canvasWidth }}>
        {drag && (
          <div
            className="cc-ghost"
            aria-hidden="true"
            style={rectToPx(drag.resolved, metrics)}
          />
        )}
        {ids.map((id) => {
          const live = drag?.id === id ? drag.current : layout[id];
          if (!live) return null;
          const box = rectToPx(live, metrics);
          const active = drag?.id === id;
          const blocked = active ? !sameRect(drag.current, drag.resolved) : false;
          return (
            <div
              key={id}
              className={`cc-slot${active ? " cc-slot-active" : ""}${blocked ? " cc-slot-blocked" : ""}`}
              style={box}
            >
              {children(id, {
                dragging: active && drag.mode === "move",
                resizing: active && drag.mode !== "move",
                blocked,
                onDragStart: (cardId, e) => begin(cardId, "move", e),
                onResizeStart: (cardId, edge, e) => begin(cardId, edge, e),
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function sameRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

export { COLS };
