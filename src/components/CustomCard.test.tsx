import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CustomCardBody, customAttention } from "./CustomCard";
import type { CustomCardResult } from "../types";

function result(over: Partial<CustomCardResult> = {}): CustomCardResult {
  return {
    id: "build-queue",
    ok: true,
    durationMs: 42,
    atUnix: 1_700_000_000,
    error: null,
    payload: {
      schemaVersion: 1,
      status: "warning",
      title: "Build Queue",
      metrics: [
        { label: "Queued", value: 8 },
        { label: "Running", value: 2 },
      ],
      message: "Oldest job has waited 14 minutes",
    },
    ...over,
  };
}

describe("custom cards", () => {
  it("maps the contract's status onto the shared attention scale", () => {
    expect(customAttention(null)).toBe("normal");
    expect(customAttention(result())).toBe("warning");
    expect(customAttention(result({ payload: { ...result().payload!, status: "critical" } }))).toBe("critical");
    expect(customAttention(result({ payload: { ...result().payload!, status: "ok" } }))).toBe("normal");
  });

  it("renders the reported metrics and message", () => {
    render(<CustomCardBody result={result()} title="Build Queue" onRefresh={() => {}} />);
    expect(screen.getByText("Queued")).toBeTruthy();
    expect(screen.getByText("8")).toBeTruthy();
    expect(screen.getByText("Oldest job has waited 14 minutes")).toBeTruthy();
  });

  it("shows a failed run as a collector error with a retry, not stale data", () => {
    const onRefresh = vi.fn();
    render(
      <CustomCardBody
        result={result({ ok: false, payload: null, error: "unsupported schemaVersion 2 (expected 1)" })}
        title="Build Queue"
        onRefresh={onRefresh}
      />,
    );
    expect(screen.getByText("Collector failed")).toBeTruthy();
    expect(screen.getByText(/schemaVersion 2/)).toBeTruthy();
    fireEvent.click(screen.getByText("Run now"));
    expect(onRefresh).toHaveBeenCalled();
  });

  it("distinguishes a card that reported nothing from one that has not run", () => {
    const { unmount } = render(
      <CustomCardBody result={null} title="Build Queue" onRefresh={() => {}} />,
    );
    expect(screen.getByText("No data yet")).toBeTruthy();
    unmount();

    render(
      <CustomCardBody
        result={result({ payload: { ...result().payload!, metrics: [] } })}
        title="Build Queue"
        onRefresh={() => {}}
      />,
    );
    expect(screen.getByText("Zero")).toBeTruthy();
  });

  it("renders payload text as text — a custom card can never inject markup", () => {
    const { container } = render(
      <CustomCardBody
        result={result({
          payload: {
            ...result().payload!,
            // The backend strips angle brackets; this asserts the renderer
            // would not execute them even if one slipped through.
            message: "<img src=x onerror=alert(1)>",
            metrics: [{ label: "<b>bold</b>", value: "<i>x</i>" }],
          },
        })}
        title="Build Queue"
        onRefresh={() => {}}
      />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(screen.getByText("<b>bold</b>")).toBeTruthy();
  });
});
