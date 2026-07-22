import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import { CardCanvas } from "./CardCanvas";
import type { Layout } from "../model/layout";
import { COLS, MIN_COL_PX, ROW_H, GAP, metricsFor } from "../model/layout";

// jsdom reports clientWidth 0, so the canvas falls back to its minimum column
// width — deterministic, which is exactly what a geometry test wants.
const M = metricsFor(0);

function board(layout: Layout, opts: { locked?: boolean } = {}) {
  const onLayoutChange = vi.fn();
  const view = render(
    <CardCanvas
      ids={Object.keys(layout)}
      layout={layout}
      locked={opts.locked ?? false}
      onLayoutChange={onLayoutChange}
    >
      {(id, h) => (
        <div data-testid={id}>
          <span
            data-testid={`${id}-grip`}
            onPointerDown={(e) => h.onDragStart(id, e)}
          />
          <span
            data-testid={`${id}-se`}
            onPointerDown={(e) => h.onResizeStart(id, "se", e)}
          />
          <span data-testid={`${id}-blocked`}>{String(h.blocked)}</span>
        </div>
      )}
    </CardCanvas>,
  );
  return { ...view, onLayoutChange };
}

function slotOf(container: HTMLElement, id: string): HTMLElement {
  return container.querySelector(`[data-testid="${id}"]`)!.parentElement as HTMLElement;
}

/** Press the handle, move the pointer by a pixel delta, release. */
function drag(handle: HTMLElement, dx: number, dy: number, release = true) {
  fireEvent.pointerDown(handle, { clientX: 100, clientY: 100 });
  act(() => {
    window.dispatchEvent(
      new MouseEvent("pointermove", { clientX: 100 + dx, clientY: 100 + dy }),
    );
  });
  if (release) act(() => void window.dispatchEvent(new MouseEvent("pointerup", {})));
}

describe("canvas geometry", () => {
  it("positions each card from its own rectangle", () => {
    const { container } = board({ a: { x: 0, y: 0, w: 6, h: 8 } });
    const slot = slotOf(container, "a");
    expect(slot.style.left).toBe("0px");
    expect(slot.style.top).toBe("0px");
    expect(parseFloat(slot.style.width)).toBeCloseTo(6 * M.unitW - GAP, 1);
    expect(parseFloat(slot.style.height)).toBeCloseTo(8 * M.unitH - GAP, 1);
  });

  it("keeps columns readable instead of crushing them in a narrow window", () => {
    expect(M.unitW).toBeCloseTo((COLS * MIN_COL_PX + GAP) / COLS, 5);
    expect(M.unitH).toBe(ROW_H + GAP);
  });
});

describe("moving a card", () => {
  it("commits the new rectangle without touching any other card", () => {
    const layout: Layout = { a: { x: 0, y: 0, w: 5, h: 5 }, b: { x: 20, y: 0, w: 5, h: 5 } };
    const { container, onLayoutChange } = board(layout);
    drag(container.querySelector('[data-testid="a-grip"]')!, M.unitW * 3, M.unitH * 2);
    expect(onLayoutChange).toHaveBeenCalledTimes(1);
    const next = onLayoutChange.mock.calls[0][0] as Layout;
    expect(next.a).toEqual({ x: 3, y: 2, w: 5, h: 5 });
    expect(next.b).toEqual(layout.b); // untouched — no swap, no reflow
  });

  it("parks against a neighbour's edge when released on top of it", () => {
    // b occupies columns 8–12. Releasing a at x=5 would overlap, so it lands
    // flush at x=3 — as far as it fits, not back where it started.
    const layout: Layout = { a: { x: 0, y: 0, w: 5, h: 5 }, b: { x: 8, y: 0, w: 5, h: 5 } };
    const { container, onLayoutChange } = board(layout);
    drag(container.querySelector('[data-testid="a-grip"]')!, M.unitW * 5, 0);
    const next = onLayoutChange.mock.calls[0][0] as Layout;
    expect(next.a).toEqual({ x: 3, y: 0, w: 5, h: 5 });
    expect(next.b).toEqual(layout.b);
  });

  it("parks correctly even when the pointer jumps in a single event", () => {
    // A fast flick delivers one move whose position is already inside the
    // neighbour; the card must still travel as far as it fits.
    const layout: Layout = { a: { x: 0, y: 0, w: 5, h: 5 }, b: { x: 8, y: 0, w: 5, h: 5 } };
    const { container, onLayoutChange } = board(layout);
    drag(container.querySelector('[data-testid="a-grip"]')!, M.unitW * 7, 0);
    expect((onLayoutChange.mock.calls[0][0] as Layout).a.x).toBe(3);
  });

  it("still allows moving a card past a neighbour into free space", () => {
    const layout: Layout = { a: { x: 0, y: 0, w: 5, h: 5 }, b: { x: 8, y: 0, w: 5, h: 5 } };
    const { container, onLayoutChange } = board(layout);
    drag(container.querySelector('[data-testid="a-grip"]')!, M.unitW * 20, 0);
    expect((onLayoutChange.mock.calls[0][0] as Layout).a.x).toBe(20);
  });

  it("reports the blocked state while the pointer is over a neighbour", () => {
    const layout: Layout = { a: { x: 0, y: 0, w: 5, h: 5 }, b: { x: 8, y: 0, w: 5, h: 5 } };
    const { container, getByTestId } = board(layout);
    drag(container.querySelector('[data-testid="a-grip"]')!, M.unitW * 8, 0, false);
    expect(getByTestId("a-blocked").textContent).toBe("true");
    act(() => void window.dispatchEvent(new MouseEvent("pointerup", {})));
  });

  it("lets a card sit directly beneath another in the same column", () => {
    const layout: Layout = { a: { x: 0, y: 0, w: 5, h: 5 }, b: { x: 20, y: 0, w: 5, h: 5 } };
    const { container, onLayoutChange } = board(layout);
    drag(container.querySelector('[data-testid="b-grip"]')!, -M.unitW * 20, M.unitH * 5);
    expect((onLayoutChange.mock.calls[0][0] as Layout).b).toEqual({ x: 0, y: 5, w: 5, h: 5 });
  });

  it("never lets a card leave the canvas", () => {
    const { container, onLayoutChange } = board({ a: { x: 0, y: 0, w: 5, h: 5 } });
    drag(container.querySelector('[data-testid="a-grip"]')!, -M.unitW * 10, -M.unitH * 10);
    expect(onLayoutChange).not.toHaveBeenCalled(); // already flush at the origin
  });
});

describe("resizing", () => {
  it("changes width and height together from the corner", () => {
    const { container, onLayoutChange } = board({ a: { x: 0, y: 0, w: 5, h: 5 } });
    drag(container.querySelector('[data-testid="a-se"]')!, M.unitW * 4, M.unitH * 3);
    expect((onLayoutChange.mock.calls[0][0] as Layout).a).toEqual({ x: 0, y: 0, w: 9, h: 8 });
  });

  it("will not grow through a neighbour", () => {
    const layout: Layout = { a: { x: 0, y: 0, w: 5, h: 5 }, b: { x: 7, y: 0, w: 5, h: 5 } };
    const { container, onLayoutChange } = board(layout);
    drag(container.querySelector('[data-testid="a-se"]')!, M.unitW * 10, 0);
    expect((onLayoutChange.mock.calls[0][0] as Layout).a.w).toBe(7);
  });

  it("enforces the minimum size rather than collapsing to nothing", () => {
    const { container, onLayoutChange } = board({ a: { x: 0, y: 0, w: 8, h: 8 } });
    drag(container.querySelector('[data-testid="a-se"]')!, -M.unitW * 20, -M.unitH * 20);
    const next = (onLayoutChange.mock.calls[0][0] as Layout).a;
    expect(next.w).toBeGreaterThanOrEqual(3);
    expect(next.h).toBeGreaterThanOrEqual(4);
  });
});

describe("locked board", () => {
  it("ignores drags entirely", () => {
    const { container, onLayoutChange } = board({ a: { x: 0, y: 0, w: 5, h: 5 } }, { locked: true });
    drag(container.querySelector('[data-testid="a-grip"]')!, M.unitW * 4, M.unitH * 4);
    expect(onLayoutChange).not.toHaveBeenCalled();
  });
});
