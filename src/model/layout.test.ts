import { describe, expect, it } from "vitest";
import type { Layout, Rect } from "./layout";
import {
  COLS,
  COLLAPSED_H,
  DEFAULT_H,
  DEFAULT_W,
  MIN_H,
  MIN_W,
  autoPlace,
  clampRect,
  collapseRect,
  collisions,
  expandRect,
  fits,
  flowLayout,
  layoutHeight,
  metricsFor,
  overlaps,
  pxToUnits,
  readingOrder,
  rectToPx,
  resolveLayout,
  visibleLayout,
} from "./layout";

/** No two rectangles in a layout may intersect — the whole invariant. */
function assertNoOverlap(layout: Layout) {
  for (const [id, rect] of Object.entries(layout)) {
    expect(collisions(layout, id, rect), `${id} overlaps`).toEqual([]);
  }
}

const r = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });

describe("overlap", () => {
  it("treats touching edges as free, not colliding", () => {
    // The whole point: a card may sit flush against its neighbour.
    expect(overlaps(r(0, 0, 5, 5), r(5, 0, 5, 5))).toBe(false);
    expect(overlaps(r(0, 0, 5, 5), r(0, 5, 5, 5))).toBe(false);
  });

  it("detects a genuine intersection in either axis", () => {
    expect(overlaps(r(0, 0, 5, 5), r(4, 0, 5, 5))).toBe(true);
    expect(overlaps(r(0, 0, 5, 5), r(0, 4, 5, 5))).toBe(true);
    expect(overlaps(r(0, 0, 10, 10), r(3, 3, 2, 2))).toBe(true);
  });
});

describe("two small cards stacked in one column", () => {
  it("is a legal arrangement", () => {
    const layout: Layout = { top: r(0, 0, 5, 5), bottom: r(0, 5, 5, 5) };
    expect(collisions(layout, "top", layout.top)).toEqual([]);
    expect(fits(layout, "bottom", r(0, 5, 5, 5))).toBe(true);
  });

  it("lets a third card land beside them, not on them", () => {
    const layout: Layout = { top: r(0, 0, 5, 5), bottom: r(0, 5, 5, 5) };
    expect(fits(layout, null, r(0, 2, 5, 5))).toBe(false); // straddles both
    expect(fits(layout, null, r(5, 0, 5, 10))).toBe(true); // sits alongside
  });
});

describe("clamping", () => {
  it("keeps a card inside the canvas", () => {
    expect(clampRect(r(-4, -2, 5, 5))).toMatchObject({ x: 0, y: 0 });
    expect(clampRect(r(COLS + 10, 0, 5, 5)).x).toBe(COLS - 5);
  });

  it("enforces a minimum size in both axes", () => {
    const tiny = clampRect(r(0, 0, 1, 1));
    expect(tiny.w).toBe(MIN_W);
    expect(tiny.h).toBe(MIN_H);
  });

  it("never lets a card be wider than the canvas", () => {
    expect(clampRect(r(0, 0, 999, 5)).w).toBe(COLS);
  });
});

describe("fits", () => {
  const layout: Layout = { a: r(10, 10, 6, 6) };

  it("rejects anything overlapping a neighbour", () => {
    expect(fits(layout, null, r(12, 12, 6, 6))).toBe(false);
  });

  it("accepts the cell immediately past a neighbour's edge", () => {
    expect(fits(layout, null, r(16, 10, 6, 6))).toBe(true);
    expect(fits(layout, null, r(10, 16, 6, 6))).toBe(true);
  });

  it("ignores the card being moved", () => {
    expect(fits(layout, "a", r(10, 10, 6, 6))).toBe(true);
  });

  it("rejects anything off the canvas", () => {
    expect(fits({}, null, r(-1, 0, 5, 5))).toBe(false);
    expect(fits({}, null, r(COLS - 2, 0, 5, 5))).toBe(false);
  });
});

describe("collapsing", () => {
  it("frees the space below and remembers what to reopen to", () => {
    const folded = collapseRect(r(0, 0, 5, 20));
    expect(folded.h).toBe(COLLAPSED_H);
    expect(folded.hExpanded).toBe(20);
    // The freed rows are genuinely free — a drop there must be accepted.
    expect(fits({ a: folded }, null, r(0, COLLAPSED_H, 5, 5))).toBe(true);
  });

  it("shrinks the canvas it was the tallest thing in", () => {
    expect(layoutHeight({ a: r(0, 0, 5, 20) })).toBe(20);
    expect(layoutHeight({ a: collapseRect(r(0, 0, 5, 20)) })).toBe(COLLAPSED_H);
  });

  it("reopens to its previous height when the space is still there", () => {
    const folded = collapseRect(r(0, 0, 5, 20));
    const opened = expandRect({ a: folded }, "a", folded);
    expect(opened.h).toBe(20);
    expect(opened.hExpanded).toBeUndefined();
  });

  it("reopens only as far as it fits when a neighbour took the space", () => {
    // This is the path that used to produce a genuine overlap: fold, let
    // something else move underneath, then unfold.
    const folded = collapseRect(r(0, 0, 5, 20));
    const layout: Layout = { a: folded, b: r(0, COLLAPSED_H + 4, 5, 5) };
    const opened = expandRect(layout, "a", folded);
    expect(opened.h).toBe(COLLAPSED_H + 4);
    assertNoOverlap({ ...layout, a: opened });
  });

  it("carries the remembered height through a move or resize", () => {
    const folded = collapseRect(r(0, 0, 5, 20));
    expect(clampRect({ ...folded, x: 7 }).hExpanded).toBe(20);
  });

  it("is a no-op on a card that is already short", () => {
    const tiny = r(0, 0, 5, COLLAPSED_H);
    expect(collapseRect(tiny)).toEqual(tiny);
  });
});

describe("auto placement", () => {
  it("fills the first free slot rather than stacking at the origin", () => {
    const layout: Layout = { a: r(0, 0, 5, 5) };
    expect(autoPlace(layout, { w: 5, h: 5 })).toEqual(r(5, 0, 5, 5));
  });

  it("wraps to the next row when the first is full", () => {
    const layout: Layout = {};
    for (let i = 0; i * 6 + 6 <= COLS; i += 1) layout[`c${i}`] = r(i * 6, 0, 6, 5);
    const placed = autoPlace(layout, { w: 6, h: 5 });
    expect(placed.y).toBeGreaterThan(0);
    expect(collisions(layout, null, placed)).toEqual([]);
  });

  it("finishes the top row before dropping into a gap lower down", () => {
    const layout: Layout = { tall: r(0, 0, 5, 20), short: r(5, 0, 5, 5) };
    // Free space exists under `short`, but the top row is still open further
    // right — a card should land where the eye goes first.
    expect(autoPlace(layout, { w: 5, h: 5 })).toEqual(r(10, 0, 5, 5));
  });

  it("uses the gap under a short card once the top row is full", () => {
    const layout: Layout = { tall: r(0, 0, 5, 20), short: r(5, 0, 5, 5) };
    for (let x = 10; x + 5 <= COLS; x += 5) layout[`fill${x}`] = r(x, 0, 5, 5);
    const placed = autoPlace(layout, { w: 5, h: 5 });
    expect(placed).toEqual(r(5, 5, 5, 5)); // directly under the short card
  });

  it("always returns something that does not collide", () => {
    const layout: Layout = { a: r(0, 0, COLS, 8) };
    expect(collisions(layout, null, autoPlace(layout, { w: COLS, h: 8 }))).toEqual([]);
  });
});

describe("resolveLayout", () => {
  const size = () => ({ w: DEFAULT_W, h: DEFAULT_H });

  it("returns the same reference when the layout is already valid", () => {
    const layout: Layout = { a: r(0, 0, 5, 5), b: r(5, 0, 5, 5) };
    expect(resolveLayout(layout, ["a", "b"], size)).toBe(layout);
  });

  it("places cards that lack a rectangle", () => {
    const layout: Layout = { a: r(0, 0, 5, 5) };
    const next = resolveLayout(layout, ["a", "b"], size);
    expect(next.a).toEqual(layout.a);
    expect(next.b).toBeDefined();
    assertNoOverlap(next);
  });

  it("does not let a hidden card reserve a hole", () => {
    const layout: Layout = { hidden: r(0, 0, COLS, 40) };
    const next = resolveLayout(layout, ["b"], size);
    expect(next.b).toEqual({ x: 0, y: 0, w: DEFAULT_W, h: DEFAULT_H });
  });

  it("keeps a remembered rectangle when it still fits", () => {
    const layout: Layout = { a: r(12, 7, 6, 6) };
    expect(resolveLayout(layout, ["a"], size).a).toEqual(r(12, 7, 6, 6));
  });

  it("re-places a card whose remembered spot was taken while it was hidden", () => {
    // Hide `a`, move `b` onto its rectangle, switch `a` back on. Before the
    // resolve pass this silently produced two cards stacked on each other.
    const layout: Layout = { a: r(0, 0, 5, 5), b: r(0, 0, 5, 5) };
    const next = resolveLayout(layout, ["b", "a"], size);
    assertNoOverlap({ a: next.a, b: next.b });
    expect(next.b).toEqual(r(0, 0, 5, 5)); // the one already in place keeps it
  });

  it("keeps its own size when re-placing, not the default", () => {
    const layout: Layout = { a: r(0, 0, 9, 7), b: r(0, 0, 5, 5) };
    const next = resolveLayout(layout, ["b", "a"], size);
    expect(next.a.w).toBe(9);
    expect(next.a.h).toBe(7);
  });

  it("untangles a layout where everything collides", () => {
    const layout: Layout = {
      a: r(0, 0, 8, 8), b: r(1, 1, 8, 8), c: r(2, 2, 8, 8), d: r(3, 3, 8, 8),
    };
    const next = resolveLayout(layout, ["a", "b", "c", "d"], size);
    assertNoOverlap(next);
    expect(Object.keys(next)).toHaveLength(4);
  });

  it("pulls a card that hangs off the edge back inside", () => {
    const layout: Layout = { a: { x: COLS - 2, y: 0, w: 9, h: 5 } };
    const next = resolveLayout(layout, ["a"], size);
    expect(next.a.x + next.a.w).toBeLessThanOrEqual(COLS);
  });

  it("is idempotent", () => {
    const messy: Layout = { a: r(0, 0, 8, 8), b: r(1, 1, 8, 8), c: r(2, 2, 8, 8) };
    const once = resolveLayout(messy, ["a", "b", "c"], size);
    expect(resolveLayout(once, ["a", "b", "c"], size)).toBe(once);
  });

  it("leaves hidden cards' rectangles untouched", () => {
    const layout: Layout = { a: r(0, 0, 5, 5), hidden: r(0, 0, 5, 5) };
    expect(resolveLayout(layout, ["a"], size).hidden).toEqual(r(0, 0, 5, 5));
  });
});

describe("reading order", () => {
  it("goes top to bottom, then left to right", () => {
    const layout: Layout = {
      topRight: r(20, 0, 5, 5),
      topLeft: r(0, 0, 5, 5),
      below: r(0, 6, 5, 5),
    };
    expect(readingOrder(layout, ["below", "topRight", "topLeft"])).toEqual([
      "topLeft",
      "topRight",
      "below",
    ]);
  });

  it("treats near-equal tops as the same visual row", () => {
    const layout: Layout = { a: r(10, 4, 5, 5), b: r(0, 5, 5, 5) };
    expect(readingOrder(layout, ["a", "b"])).toEqual(["b", "a"]);
  });
});

describe("migration from the flow layout", () => {
  const wide = (id: string) => id === "procs";

  it("preserves the saved order left to right", () => {
    const out = flowLayout(["a", "b", "c"], {}, () => false);
    expect(out.a.x).toBe(0);
    expect(out.b.x).toBe(DEFAULT_W);
    expect(out.c.x).toBe(DEFAULT_W * 2);
    expect(out.a.y).toBe(0);
  });

  it("honours a saved double-width span", () => {
    const out = flowLayout(["procs", "a"], { procs: { span: 2 } }, wide);
    expect(out.procs.w).toBeGreaterThan(out.a.w);
  });

  it("converts a saved pixel height into rows", () => {
    const out = flowLayout(["a"], { a: { height: 300 } }, () => false);
    expect(out.a.h).toBe(11); // (300 + 8) / 28
    expect(out.a.h).toBeGreaterThanOrEqual(MIN_H);
  });

  it("wraps onto a new shelf below the tallest card of the previous one", () => {
    const ids = Array.from({ length: 12 }, (_, i) => `c${i}`);
    const out = flowLayout(ids, { c0: { height: 600 } }, () => false);
    const rows = new Set(Object.values(out).map((rect) => rect.y));
    expect(rows.size).toBeGreaterThan(1);
    // Nothing may overlap after a migration — that would be an unusable board.
    assertNoOverlap(out);
  });

  it("never produces a card wider than the canvas", () => {
    const out = flowLayout(["a"], { a: { span: 2 } }, () => true, 8);
    expect(out.a.w).toBeLessThanOrEqual(8);
  });
});

describe("pixel conversion", () => {
  it("maps a rectangle onto the container width", () => {
    const m = metricsFor(1000);
    const px = rectToPx(r(0, 0, COLS, 1), m);
    expect(Math.round(px.left)).toBe(0);
    expect(Math.round(px.width)).toBe(1000);
  });

  it("stops shrinking columns past a readable minimum and lets the canvas scroll", () => {
    const narrow = metricsFor(200);
    const floor = metricsFor(COLS * 14);
    expect(narrow.unitW).toBeCloseTo(floor.unitW, 5);
  });

  it("rounds a pointer delta to whole cells", () => {
    const m = metricsFor(1000);
    expect(pxToUnits(m.unitW * 2 + 2, m.unitH * 3 - 2, m)).toEqual({ dx: 2, dy: 3 });
    expect(pxToUnits(1, 1, m)).toEqual({ dx: 0, dy: 0 });
  });
});

describe("visibleLayout", () => {
  it("keeps only what is on screen", () => {
    const layout: Layout = { a: r(0, 0, 5, 5), b: r(5, 0, 5, 5) };
    expect(Object.keys(visibleLayout(layout, ["a"]))).toEqual(["a"]);
  });
});
