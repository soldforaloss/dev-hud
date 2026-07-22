// Test environment shims: jsdom lacks the browser APIs the HUD relies on
// (ResizeObserver for card density, matchMedia for reduced motion) and the
// Tauri IPC bridge only exists inside the webview.

import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

// Testing Library only auto-cleans when vitest globals are enabled; they are
// not, so unmount explicitly or every render leaks into the next test's DOM.
afterEach(cleanup);

/**
 * Controllable ResizeObserver.
 *
 * jsdom has none, and a no-op stub would make every density test vacuous —
 * cards would sit at the unmeasured default forever. This one records its
 * observers so a test can state "the card is now 200×100" and assert what the
 * card decides to show.
 */
const observers = new Set<{ cb: ResizeObserverCallback; targets: Set<Element> }>();

class FakeResizeObserver implements ResizeObserver {
  private entry: { cb: ResizeObserverCallback; targets: Set<Element> };
  constructor(callback: ResizeObserverCallback) {
    this.entry = { cb: callback, targets: new Set() };
    observers.add(this.entry);
  }
  observe(target: Element) {
    this.entry.targets.add(target);
  }
  unobserve(target: Element) {
    this.entry.targets.delete(target);
  }
  disconnect() {
    observers.delete(this.entry);
  }
}
globalThis.ResizeObserver ??= FakeResizeObserver as unknown as typeof ResizeObserver;

/** Report a size to every observer watching `target`. */
export function resizeTo(target: Element, width: number, height: number): void {
  const rect = { width, height, top: 0, left: 0, bottom: height, right: width, x: 0, y: 0 };
  for (const o of observers) {
    if (!o.targets.has(target)) continue;
    o.cb(
      [{ target, contentRect: rect } as unknown as ResizeObserverEntry],
      {} as ResizeObserver,
    );
  }
}

afterEach(() => observers.clear());

if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

/** Commands the tests stub out; each test overrides what it needs. */
export const invokeMock = vi.fn(async () => undefined);

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) =>
    (invokeMock as unknown as (...a: unknown[]) => Promise<unknown>)(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: async () => () => {},
  emit: async () => {},
}));

vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({
    get: async () => undefined,
    set: async () => {},
    save: async () => {},
  }),
}));

vi.mock("@tauri-apps/plugin-autostart", () => ({
  enable: async () => {},
  disable: async () => {},
}));
