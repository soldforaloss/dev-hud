import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { Card } from "./Card";
import { EmptyState } from "./StatusBits";
import { useCardDensity } from "./density";
import { Inspector } from "./Inspector";
import { resizeTo } from "../test/setup";
import { EntityIndex, entityRef } from "../model/entities";
import { emptyProvenance } from "../model/provenance";
import { Redactor } from "../model/privacy";
import type { CardStatus } from "../model/cardStatus";

const NOW = 1_700_000_000_000;

/** Body that reports what density the shell handed it. */
function Probe() {
  const density = useCardDensity();
  return (
    <div>
      <span data-testid="density">{density}</span>
      {density !== "compact" && <span>secondary metrics</span>}
      {density === "expanded" && <span>history chart</span>}
    </div>
  );
}

function renderCard(props: Partial<Parameters<typeof Card>[0]> = {}) {
  const utils = render(
    <Card id="netq" title="Network" icon="↯" collapsed={false} onToggle={() => {}} {...props}>
      <Probe />
    </Card>,
  );
  return { ...utils, frame: document.querySelector('[data-card-id="netq"]') as HTMLElement };
}

function size(frame: HTMLElement, w: number, h: number) {
  act(() => resizeTo(frame, w, h));
}

describe("semantic card resizing", () => {
  it("starts at standard until the card has been measured", () => {
    renderCard();
    expect(screen.getByTestId("density").textContent).toBe("standard");
  });

  it("drops to a headline-only view when the card is small", () => {
    const { frame } = renderCard();
    size(frame, 200, 400);
    expect(screen.getByTestId("density").textContent).toBe("compact");
    expect(screen.queryByText("secondary metrics")).toBeNull();
    expect(screen.queryByText("history chart")).toBeNull();
  });

  it("uses height as well as width — a wide, short card is still compact", () => {
    const { frame } = renderCard();
    size(frame, 800, 100);
    expect(screen.getByTestId("density").textContent).toBe("compact");
  });

  it("adds supporting content at standard and charts at expanded", () => {
    const { frame } = renderCard();
    size(frame, 320, 200);
    expect(screen.getByTestId("density").textContent).toBe("standard");
    expect(screen.getByText("secondary metrics")).toBeTruthy();
    expect(screen.queryByText("history chart")).toBeNull();

    size(frame, 460, 320);
    expect(screen.getByTestId("density").textContent).toBe("expanded");
    expect(screen.getByText("history chart")).toBeTruthy();
  });

  it("publishes the density on the card element for styling", () => {
    const { frame } = renderCard();
    size(frame, 460, 320);
    expect(frame.dataset.density).toBe("expanded");
  });
});

describe("card header", () => {
  it("reports the worst thing as one glyph, explained in its label", () => {
    const { frame } = renderCard({
      health: "degraded",
      attention: "critical",
      freshness: "stale",
      statusDetail: "ICMP blocked",
    });
    const flags = frame.querySelectorAll(".card-flag");
    // Four dimensions, one glyph — the header is a name, not a status board.
    expect(flags).toHaveLength(1);
    expect(flags[0].getAttribute("aria-label")).toBe("Critical — ICMP blocked");
    expect(flags[0].textContent).toBe("■");
  });

  it("falls back through the dimensions when nothing is critical", () => {
    const { frame } = renderCard({ health: "healthy", attention: "normal", freshness: "stale" });
    expect(frame.querySelector(".card-flag")?.getAttribute("aria-label")).toMatch(/^Stale/);
  });

  it("says nothing about a state that is simply how this machine is", () => {
    // Degraded and estimated are permanent for several cards — thermals on the
    // WMI fallback, rate limits read from local logs, an unauthenticated
    // GitHub. A glyph on most cards forever is decoration, not a signal.
    for (const s of [
      { health: "degraded" as const, freshness: "live" as const },
      { health: "healthy" as const, freshness: "estimated" as const },
    ]) {
      const { frame, unmount } = renderCard({ attention: "normal", ...s });
      expect(frame.querySelector(".card-flag")).toBeNull();
      // Still readable by anything that asks — just not printed in the name.
      expect(frame.dataset.health).toBe(s.health);
      unmount();
    }
  });

  it("still marks a card that cannot report at all", () => {
    const { frame } = renderCard({ health: "unavailable", attention: "normal", freshness: "live" });
    expect(frame.querySelector(".card-flag")?.getAttribute("aria-label")).toMatch(/^Unavailable/);
  });

  it("shows the name and nothing else when all is well", () => {
    const { frame } = renderCard({ health: "healthy", attention: "normal", freshness: "live" });
    expect(frame.querySelector(".card-flag")).toBeNull();
    // Title and the collapse chevron; no status words competing for the line.
    expect(frame.querySelector(".card-title")?.textContent).toBe("Network");
    expect(screen.queryByText("Healthy")).toBeNull();
    expect(screen.queryByText("Live")).toBeNull();
  });

  it("keeps the summary out of the header until the card is collapsed", () => {
    const { frame, rerender } = renderCard({ summary: "12ms · 0% loss" });
    expect(frame.querySelector(".card-summary")).toBeNull();
    rerender(
      <Card id="netq" title="Network" icon="↯" collapsed onToggle={() => {}} summary="12ms · 0% loss">
        <Probe />
      </Card>,
    );
    expect(screen.getByText("12ms · 0% loss")).toBeTruthy();
  });

  it("still exposes the state it is not printing, for a reader and a tooltip", () => {
    const { frame } = renderCard({ health: "healthy", attention: "normal", freshness: "live" });
    expect(frame.dataset.health).toBe("healthy");
    expect(frame.dataset.attention).toBe("normal");
  });

  it("marks the whole card when it needs attention", () => {
    const { frame } = renderCard({ attention: "warning" });
    expect(frame.className).toContain("card-attn-warning");
    expect(frame.dataset.attention).toBe("warning");
  });

  it("offers an explicit inspect affordance", () => {
    const onInspect = vi.fn();
    renderCard({ onInspect });
    fireEvent.click(screen.getByLabelText("Inspect Network"));
    expect(onInspect).toHaveBeenCalledWith("netq");
  });
});

describe("card actions", () => {
  it("puts actions behind a named menu rather than a bare × control", () => {
    const run = vi.fn();
    renderCard({ actions: [{ label: "Refresh now", onSelect: run }] });
    expect(screen.queryByText("×")).toBeNull();
    fireEvent.click(screen.getByLabelText("Network actions"));
    fireEvent.click(screen.getByText("Refresh now"));
    expect(run).toHaveBeenCalled();
  });

  it("requires a confirmation before a destructive action runs", () => {
    const run = vi.fn();
    renderCard({ actions: [{ label: "Terminate process", onSelect: run, destructive: true }] });
    fireEvent.click(screen.getByLabelText("Network actions"));
    fireEvent.click(screen.getByText(/Terminate process/));
    expect(run).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Confirm: Terminate process"));
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("disables an action that is not currently possible", () => {
    renderCard({
      actions: [{ label: "Open folder", onSelect: () => {}, disabled: true, hint: "no working directory" }],
    });
    fireEvent.click(screen.getByLabelText("Network actions"));
    expect(screen.getByText("Open folder").closest("button")?.disabled).toBe(true);
  });
});

describe("empty states", () => {
  it("keeps every kind of nothing distinguishable", () => {
    const { container } = render(
      <>
        <EmptyState reason="valid_zero" detail="No containers are running." />
        <EmptyState reason="not_configured" detail="Add a folder." />
        <EmptyState reason="permission_denied" detail="Access denied." />
        <EmptyState reason="collector_error" detail="nvidia-smi timed out." />
      </>,
    );
    const reasons = [...container.querySelectorAll("[data-empty-reason]")].map(
      (e) => (e as HTMLElement).dataset.emptyReason,
    );
    expect(new Set(reasons).size).toBe(4);
    expect(screen.getByText("Zero")).toBeTruthy();
    expect(screen.getByText("Not configured")).toBeTruthy();
    expect(screen.getByText("Permission denied")).toBeTruthy();
    expect(screen.getByText("Collector failed")).toBeTruthy();
  });

  it("offers the action that resolves the state", () => {
    const onSelect = vi.fn();
    render(<EmptyState reason="not_configured" actions={[{ label: "Configure", onSelect }]} />);
    fireEvent.click(screen.getByText("Configure"));
    expect(onSelect).toHaveBeenCalled();
  });
});

describe("inspector", () => {
  const status: CardStatus = {
    id: "netq", health: "degraded", attention: "warning", freshness: "stale",
    availability: true, availabilityReason: "ICMP blocked — using a TCP probe",
    statusDetail: "20 ms, 9% loss", conditions: [], attentionItems: [],
  };

  const provenance = {
    ...emptyProvenance("get_net_quality", 15_000, "ping.exe", "ICMP or TCP:443 reachability"),
    state: "ok" as const,
    lastSuccessAt: NOW - 5_000,
    lastAttemptAt: NOW - 5_000,
    lastDurationMs: 812,
    successCount: 40,
    failureCount: 2,
  };

  function renderInspector(over: Partial<Parameters<typeof Inspector>[0]> = {}) {
    const onClose = vi.fn();
    const onNavigate = vi.fn();
    render(
      <Inspector
        target={{ kind: "card", id: "netq" }}
        title="Network"
        status={status}
        provenance={provenance}
        events={[]}
        alerts={[]}
        actions={[]}
        redactor={new Redactor(false)}
        nowMs={NOW}
        onClose={onClose}
        onNavigate={onNavigate}
        onCopyDiagnostics={() => {}}
        {...over}
      />,
    );
    return { onClose, onNavigate };
  }

  it("shows where the number came from and how the poll went", () => {
    renderInspector();
    expect(screen.getByText("ping.exe")).toBeTruthy();
    expect(screen.getByText("get_net_quality")).toBeTruthy();
    expect(screen.getByText("812 ms")).toBeTruthy();
    expect(screen.getByText("40 ok · 2 failed")).toBeTruthy();
    expect(screen.getByText("ICMP or TCP:443 reachability")).toBeTruthy();
  });

  it("explains why an auto card is visible", () => {
    renderInspector();
    expect(screen.getByText("ICMP blocked — using a TCP probe")).toBeTruthy();
  });

  it("closes on Escape", () => {
    const { onClose } = renderInspector();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("navigates to a related entity", () => {
    const index = new EntityIndex();
    const port = entityRef("port", "tcp/5434", ":5434");
    index.add({ ref: entityRef("process", "18789", "gateway"), facts: [], relations: [] });
    index.link(entityRef("process", "18789", "gateway"), "listens on", port, "owned by");
    const { onNavigate } = renderInspector({
      target: { kind: "entity", ref: entityRef("process", "18789", "gateway") },
      node: index.get({ kind: "process", id: "18789" }),
    });
    fireEvent.click(screen.getByText(":5434"));
    expect(onNavigate).toHaveBeenCalledWith(expect.objectContaining({ kind: "port" }));
  });

  it("is a labelled modal surface", () => {
    renderInspector();
    const dialog = screen.getByRole("dialog", { name: "Network inspector" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
  });
});
