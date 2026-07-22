// Free-placement card canvas.
//
// The board used to be a CSS grid whose order you permuted, so moving a card
// meant *displacing* another one — you could never simply put two short cards
// one above the other. Here every card owns a rectangle and the only rule is
// that rectangles may not overlap: a card slides until it meets another card's
// edge, and stops.
//
// The rectangle is in grid units rather than pixels. That is not a retreat to
// a grid layout — the units are fine enough (36 columns, 20px rows) to feel
// continuous, but integers keep collision exact, keep cards aligned with each
// other, and make the whole model comparable and testable.

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Height to restore when a collapsed card is expanded again. */
  hExpanded?: number;
}

export type Layout = Record<string, Rect>;

export const COLS = 36;
/** Height of one row, before the gap. */
export const ROW_H = 20;
export const GAP = 8;
/** Below this the canvas scrolls horizontally instead of crushing cards. */
export const MIN_COL_PX = 14;

export const MIN_W = 3;
export const MIN_H = 4;
/** Rows a collapsed card occupies — its header and nothing else. */
export const COLLAPSED_H = 3;

/** Spare rows kept below the lowest card so there is always somewhere to drop. */
export const HEADROOM = 6;

export const DEFAULT_W = 5;
export const DEFAULT_H = 11;
export const WIDE_W = 10;

export function defaultRectSize(wide: boolean): { w: number; h: number } {
  return { w: wide ? WIDE_W : DEFAULT_W, h: DEFAULT_H };
}

export function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export function clampRect(rect: Rect, cols = COLS): Rect {
  const w = Math.min(cols, Math.max(MIN_W, Math.round(rect.w)));
  const h = Math.max(MIN_H, Math.round(rect.h));
  return {
    w,
    h,
    x: Math.min(cols - w, Math.max(0, Math.round(rect.x))),
    y: Math.max(0, Math.round(rect.y)),
    // Carried through so moving or resizing a folded card does not lose the
    // height it should reopen to.
    ...(rect.hExpanded != null ? { hExpanded: rect.hExpanded } : {}),
  };
}

/**
 * Fold a card down to its header, remembering the height to come back to.
 *
 * Collapsing edits the *stored* rectangle rather than being applied at render
 * time. That is what keeps "what a card occupies" and "what a card looks like"
 * the same thing: the freed space is genuinely free to drop into, and
 * expanding can never reclaim ground something else has taken.
 */
export function collapseRect(rect: Rect): Rect {
  if (rect.h <= COLLAPSED_H) return rect;
  return { ...rect, h: COLLAPSED_H, hExpanded: rect.h };
}

/**
 * Restore a folded card, growing only as far as it actually fits.
 *
 * If a neighbour has taken the space below, the card expands to meet it rather
 * than overlapping it or refusing to open.
 */
export function expandRect(
  layout: Layout,
  id: string,
  rect: Rect,
  cols = COLS,
): Rect {
  const target = Math.max(MIN_H, rect.hExpanded ?? DEFAULT_H);
  if (target <= rect.h) return stripExpanded(rect);
  const grown = slide(layout, id, rect, { ...rect, h: target }, cols);
  return stripExpanded(grown);
}

function stripExpanded(rect: Rect): Rect {
  const { hExpanded: _ignored, ...rest } = rect;
  return rest;
}

/** Ids whose rectangle intersects `rect`, ignoring `selfId`. */
export function collisions(layout: Layout, selfId: string | null, rect: Rect): string[] {
  const hits: string[] = [];
  for (const [id, other] of Object.entries(layout)) {
    if (id === selfId) continue;
    if (overlaps(rect, other)) hits.push(id);
  }
  return hits;
}

export function fits(layout: Layout, selfId: string | null, rect: Rect, cols = COLS): boolean {
  if (rect.x < 0 || rect.y < 0 || rect.x + rect.w > cols) return false;
  if (rect.w < MIN_W || rect.h < MIN_H) return false;
  return collisions(layout, selfId, rect).length === 0;
}

/** Lowest occupied row, i.e. how tall the canvas currently needs to be. */
export function layoutHeight(layout: Layout): number {
  let bottom = 0;
  for (const rect of Object.values(layout)) {
    if (rect.y + rect.h > bottom) bottom = rect.y + rect.h;
  }
  return bottom;
}

/**
 * The furthest point along origin → target that the card can actually occupy.
 *
 * Without this, "slide until you hit something" depends on how often the
 * pointer reports: one fast flick delivers a single event whose position is
 * already inside a neighbour, and the card would refuse to move at all rather
 * than travelling as far as it fits. Interpolating makes the result depend on
 * where the pointer *is*, not on how it got there.
 *
 * Applies to size as well as position, so dragging an edge hard against a
 * neighbour grows the card right up to it.
 */
export function slide(
  layout: Layout,
  selfId: string | null,
  origin: Rect,
  target: Rect,
  cols = COLS,
): Rect {
  if (fits(layout, selfId, target, cols)) return target;
  const steps = Math.max(
    Math.abs(target.x - origin.x),
    Math.abs(target.y - origin.y),
    Math.abs(target.w - origin.w),
    Math.abs(target.h - origin.h),
  );
  for (let i = steps - 1; i > 0; i -= 1) {
    const t = i / steps;
    const candidate = clampRect(
      {
        x: Math.round(origin.x + (target.x - origin.x) * t),
        y: Math.round(origin.y + (target.y - origin.y) * t),
        w: Math.round(origin.w + (target.w - origin.w) * t),
        h: Math.round(origin.h + (target.h - origin.h) * t),
      },
      cols,
    );
    if (fits(layout, selfId, candidate, cols)) return candidate;
  }
  return origin;
}

/**
 * First free slot, scanning top-to-bottom then left-to-right.
 *
 * Used for cards the user has never placed — a newly added card, or one
 * switched back on — so nothing ever lands on top of something else.
 */
export function autoPlace(
  layout: Layout,
  size: { w: number; h: number },
  cols = COLS,
): Rect {
  const w = Math.min(cols, Math.max(MIN_W, size.w));
  const h = Math.max(MIN_H, size.h);
  const limit = layoutHeight(layout) + h + 1;
  for (let y = 0; y <= limit; y += 1) {
    for (let x = 0; x + w <= cols; x += 1) {
      const candidate = { x, y, w, h };
      if (collisions(layout, null, candidate).length === 0) return candidate;
    }
  }
  return { x: 0, y: layoutHeight(layout), w, h };
}

/**
 * Produce a layout in which no two visible cards overlap — whatever it was
 * handed.
 *
 * This is the guarantee, not a tidy-up. A stored rectangle can conflict for
 * reasons no drag is responsible for: a card was hidden while its neighbour
 * moved into that space and is now switched back on, a profile was imported
 * from another window size, a settings file was edited by hand. Re-validating
 * every rectangle on every render is cheap, and it means the invariant holds
 * by construction rather than by every caller remembering to check.
 *
 * Cards keep their position where they can. Ones that cannot are re-placed in
 * the first free slot, in reading order, so the result is deterministic.
 * Returns the *same reference* when nothing had to change.
 */
export function resolveLayout(
  layout: Layout,
  visible: readonly string[],
  sizeOf: (id: string) => { w: number; h: number },
  cols = COLS,
): Layout {
  const known = visible.filter((id) => layout[id]);
  const placed: Layout = {};
  const displaced: string[] = [];
  let changed = false;

  for (const id of readingOrder(layout, known)) {
    const rect = clampRect(layout[id], cols);
    if (fits(placed, id, rect, cols)) {
      placed[id] = rect;
      if (!sameRect(rect, layout[id])) changed = true;
    } else {
      displaced.push(id);
    }
  }

  for (const id of [...visible.filter((v) => !layout[v]), ...displaced]) {
    const existing = layout[id];
    const size = existing ? { w: existing.w, h: existing.h } : sizeOf(id);
    placed[id] = autoPlace(placed, size, cols);
    changed = true;
  }

  // Hidden cards keep their remembered rectangle; it is re-validated the moment
  // they become visible again.
  return changed ? { ...layout, ...placed } : layout;
}

function sameRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

/** Only the rectangles of currently visible cards — what collision runs against. */
export function visibleLayout(layout: Layout, visible: readonly string[]): Layout {
  const out: Layout = {};
  for (const id of visible) {
    if (layout[id]) out[id] = layout[id];
  }
  return out;
}

/**
 * Top-to-bottom, left-to-right — what arrow-key navigation and the diagnostics
 * export mean by "the next card". Cards whose tops are within a row of each
 * other count as the same visual row.
 */
export function readingOrder(layout: Layout, ids: readonly string[]): string[] {
  return [...ids].sort((a, b) => {
    const ra = layout[a];
    const rb = layout[b];
    if (!ra || !rb) return 0;
    if (Math.abs(ra.y - rb.y) > 1) return ra.y - rb.y;
    return ra.x - rb.x;
  });
}

/**
 * Convert a pre-canvas layout (an order plus optional span/height overrides)
 * into rectangles, packing shelf-style in the saved order.
 *
 * The old board flowed cards left-to-right and wrapped, so reproducing that
 * flow is what makes an upgrade look like nothing happened.
 */
export function flowLayout(
  order: readonly string[],
  sizes: Record<string, { span?: number; height?: number }>,
  isWide: (id: string) => boolean,
  cols = COLS,
): Layout {
  // Shelf packing: cards flow left to right and each new shelf starts below the
  // tallest card of the last, which is what the old CSS grid did.
  const out: Layout = {};
  let x = 0;
  let shelfTop = 0;
  let shelfBottom = 0;
  for (const id of order) {
    const saved = sizes[id];
    const wide = saved?.span != null ? saved.span >= 2 : isWide(id);
    const w = Math.min(cols, wide ? WIDE_W : DEFAULT_W);
    const h = saved?.height
      ? Math.max(MIN_H, Math.round((saved.height + GAP) / (ROW_H + GAP)))
      : DEFAULT_H;
    if (x + w > cols) {
      x = 0;
      shelfTop = shelfBottom;
    }
    out[id] = { x, y: shelfTop, w, h };
    x += w;
    shelfBottom = Math.max(shelfBottom, shelfTop + h);
  }
  return out;
}

// ---------- pixel conversion ----------

export interface CanvasMetrics {
  /** Width of one column including its gap. */
  unitW: number;
  /** Height of one row including its gap. */
  unitH: number;
  cols: number;
}

export function metricsFor(containerWidth: number, cols = COLS): CanvasMetrics {
  const usable = Math.max(containerWidth, cols * MIN_COL_PX);
  return { unitW: (usable + GAP) / cols, unitH: ROW_H + GAP, cols };
}

export function rectToPx(rect: Rect, m: CanvasMetrics) {
  return {
    left: rect.x * m.unitW,
    top: rect.y * m.unitH,
    width: Math.max(1, rect.w * m.unitW - GAP),
    height: Math.max(1, rect.h * m.unitH - GAP),
  };
}

/** Pixel delta → whole grid units, rounded to the nearest cell. */
export function pxToUnits(dx: number, dy: number, m: CanvasMetrics) {
  return { dx: Math.round(dx / m.unitW), dy: Math.round(dy / m.unitH) };
}
