// Dev-only layout harness. Not part of the app bundle — index.html never
// imports it; it has its own entry (harness.html) served by the dev server.
//
// Why it exists: every round of "the cards break at certain sizes" was
// reported from a screenshot, and I could only ever check the one width that
// happened to be on screen. Card content is now funnelled through one row
// primitive and one shell, so the failure modes — text intersecting other
// text, and content clipped without an ellipsis — can be checked exhaustively
// against real layout instead of one lucky width.
//
// Open http://localhost:1430/harness.html and call window.__measure().

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Card } from "./components/Card";
import { DataRow, RowOverflow } from "./components/DataRow";
import { Dot } from "./components/viz";
import "./styles.css";

/** Widths from "narrower than anyone would drag" to "comfortably wide". */
const WIDTHS = [140, 160, 180, 200, 235, 260, 300, 340, 400, 480, 600];

/** Content chosen to break things, not to look good. */
const ROWS = [
  { primary: "node.exe", secondary: "pid 18789", value: "45 MB" },
  {
    primary: "com.docker.backend.service.host.networking.internal",
    secondary: "--config /very/long/path/that/keeps/going/config.yaml",
    value: "1.2 GB",
  },
  { primary: "a", value: "0" },
  {
    primary: "Löwenbräu—Ürümqi·Ναυσικά·日本語のとても長いプロセス名です",
    secondary: "ελληνικά",
    value: "99.9%",
  },
  { primary: "svchost.exe", secondary: "netsvcs", value: "—" },
  { primary: "no-value-row-at-all-with-a-long-name-here" },
  {
    primary: "postgres",
    secondary: "listening on tcp/5434",
    value: "↑2 ↓1",
    action: true,
  },
];

function Board() {
  return (
    <div id="board">
      {WIDTHS.map((w) => (
        <div key={w} className="probe" data-width={w} style={{ width: w }}>
          <Card
            id={`w${w}`}
            title="Containers and processes"
            icon="▣"
            collapsed={false}
            onToggle={() => {}}
            health="degraded"
            attention="warning"
            freshness="stale"
            statusDetail="the collector timed out"
            summary="7 running · 2 unhealthy"
            onInspect={() => {}}
            actions={[{ label: "Refresh now", onSelect: () => {} }]}
          >
            <div className="drow-list">
              {ROWS.map((r, i) => (
                <DataRow
                  key={i}
                  lead={i % 3 === 0 ? <Dot state="good" title="running" /> : undefined}
                  primary={r.primary}
                  secondary={r.secondary}
                  value={r.value}
                  valueHint={r.value ? `${r.value} — measured this poll` : undefined}
                  tone={i === 1 ? "warn" : undefined}
                  onOpen={() => {}}
                  action={
                    r.action
                      ? { icon: "↗", label: "Open the project folder", onSelect: () => {} }
                      : undefined
                  }
                />
              ))}
              <RowOverflow hidden={12} noun="processes" onOpen={() => {}} />
            </div>
          </Card>
        </div>
      ))}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Board />
  </StrictMode>,
);

declare global {
  interface Window {
    __measure: () => unknown;
  }
}

/** Text nodes only — a container clipping its scrollable body is not a fault. */
function textLeaves(root: Element): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>("*")].filter(
    (e) =>
      e.children.length === 0 &&
      (e.textContent ?? "").trim().length > 0 &&
      getComputedStyle(e).display !== "none",
  );
}

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

const EMPTY: Box = { left: 0, right: 0, top: 0, bottom: 0 };
const area = (b: Box) => Math.max(0, b.right - b.left) * Math.max(0, b.bottom - b.top);

function clip(a: Box, b: Box): Box {
  const r = {
    left: Math.max(a.left, b.left),
    right: Math.min(a.right, b.right),
    top: Math.max(a.top, b.top),
    bottom: Math.min(a.bottom, b.bottom),
  };
  return r.right <= r.left || r.bottom <= r.top ? EMPTY : r;
}

/**
 * What is actually painted, not what is laid out.
 *
 * An inline span inside an `overflow: hidden` parent has a layout rect that
 * runs past the parent, but none of those pixels reach the screen. Comparing
 * raw getBoundingClientRect() reports overlaps and escapes that a person
 * looking at the card cannot see — measuring the wrong thing produces
 * confident, wrong bug reports.
 */
function paintedBox(e: HTMLElement): Box {
  let box: Box = e.getBoundingClientRect();
  for (let p = e.parentElement; p; p = p.parentElement) {
    const s = getComputedStyle(p);
    if (s.overflow === "visible" && s.overflowX === "visible" && s.overflowY === "visible") continue;
    box = clip(box, p.getBoundingClientRect());
    if (area(box) === 0) return EMPTY;
  }
  return box;
}

/** Does this element, or the ancestor that clips it, admit to truncating? */
function saysItTruncated(e: HTMLElement): boolean {
  for (let p: HTMLElement | null = e; p; p = p.parentElement) {
    if (getComputedStyle(p).textOverflow === "ellipsis") return true;
    if (p.classList.contains("drow") || p.classList.contains("card-head-row")) break;
  }
  return false;
}

function clips(e: HTMLElement): boolean {
  // Clipped means "characters are cut off with no ellipsis to say so".
  if (e.scrollWidth <= e.clientWidth + 1) return false;
  return !saysItTruncated(e);
}

function intersects(a: Box, b: Box): boolean {
  const EPS = 0.5;
  return (
    a.left < b.right - EPS &&
    b.left < a.right - EPS &&
    a.top < b.bottom - EPS &&
    b.top < a.bottom - EPS
  );
}

window.__measure = () => {
  const findings: Record<string, string[]> = {};
  for (const probe of document.querySelectorAll<HTMLElement>(".probe")) {
    const w = probe.dataset.width!;
    const bad: string[] = [];

    // 1. Nothing may be clipped without an ellipsis.
    for (const e of textLeaves(probe)) {
      if (clips(e)) bad.push(`clipped ${e.className || e.tagName}: "${e.textContent?.slice(0, 30)}"`);
    }

    // 2. No two pieces of text may occupy the same pixels. The row action is
    //    deliberately overlaid, so it is excluded — it is the one element
    //    designed to sit on top, and only on hover.
    const boxes = textLeaves(probe)
      .filter((e) => !e.closest(".drow-action"))
      .map((e) => ({ e, r: paintedBox(e) }))
      .filter((b) => area(b.r) > 0);
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        if (boxes[i].e.contains(boxes[j].e) || boxes[j].e.contains(boxes[i].e)) continue;
        if (intersects(boxes[i].r, boxes[j].r)) {
          bad.push(
            `overlap "${boxes[i].e.textContent?.slice(0, 18)}" × "${boxes[j].e.textContent?.slice(0, 18)}"`,
          );
        }
      }
    }

    // 3. Nothing may be painted outside the card, and no card may scroll
    //    sideways. Only auto/scroll counts — `hidden` is the clipping that
    //    makes an ellipsis possible, not a scrollbar.
    const frame = probe.querySelector<HTMLElement>("[data-card-id]")!;
    const fr = frame.getBoundingClientRect();
    for (const { e, r } of boxes) {
      if (r.right > fr.right + 1 || r.left < fr.left - 1) {
        bad.push(`escapes the card: "${e.textContent?.slice(0, 24)}"`);
      }
    }
    for (const e of [frame, ...frame.querySelectorAll<HTMLElement>("*")]) {
      const ox = getComputedStyle(e).overflowX;
      if (e.scrollWidth > e.clientWidth + 1 && (ox === "auto" || ox === "scroll")) {
        bad.push(`scrolls sideways: ${e.className || e.tagName}`);
      }
    }

    if (bad.length) findings[w] = [...new Set(bad)];
  }
  return { widths: WIDTHS, clean: Object.keys(findings).length === 0, findings };
};
