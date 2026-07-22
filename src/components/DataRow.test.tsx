import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { DataRow, RowOverflow } from "./DataRow";

function row(props: Partial<Parameters<typeof DataRow>[0]> = {}) {
  return render(
    <DataRow
      primary="node.exe"
      secondary="gateway.js --port 3000"
      value="45 MB"
      valueHint="45 MB resident"
      {...props}
    />,
  );
}

describe("the two-column contract", () => {
  it("puts exactly two things in the layout, so they cannot collide", () => {
    const { container } = row();
    const laidOut = container.querySelectorAll(".drow-open > *");
    // identity + value. A third flow child is how rows started overlapping.
    expect(laidOut).toHaveLength(2);
  });

  it("marks exactly one element as the one that truncates", () => {
    const { container } = row();
    // .drow-primary is the only class carrying the ellipsis rule; if a second
    // flow child ever gained it, two things could shrink and collide.
    expect(container.querySelectorAll(".drow-primary")).toHaveLength(1);
    expect(container.querySelector(".drow-value")?.className).not.toContain("drow-primary");
  });

  it("keeps the qualifier inside the identity, so the two truncate together", () => {
    const { container } = row();
    expect(container.querySelector(".drow-primary .drow-dim")?.textContent).toContain("gateway.js");
  });

  it("omits the value entirely rather than printing a placeholder", () => {
    const { container } = row({ value: undefined });
    expect(container.querySelector(".drow-value")).toBeNull();
  });

  it("explains every value it shows", () => {
    const { container } = row();
    const value = container.querySelector(".drow-value")!;
    expect(value.getAttribute("title")).toBe("45 MB resident");
    expect(value.getAttribute("aria-label")).toBe("45 MB resident");
  });
});

describe("the action costs no layout width", () => {
  it("is not a flow child of the row, so it can never push the value", () => {
    const { container } = row({
      action: { icon: "↗", label: "Open http://localhost:3000", onSelect: () => {} },
    });
    // It is a sibling of the row body, positioned over it — the row still has
    // exactly two things competing for width.
    expect(container.querySelector(".drow-open .drow-action")).toBeNull();
    expect(container.querySelectorAll(".drow-open > *")).toHaveLength(2);
  });

  it("is an icon, never a word", () => {
    const { container } = row({
      action: { icon: "↗", label: "Open", onSelect: () => {} },
    });
    const action = container.querySelector(".drow-action")!;
    expect((action.textContent ?? "").trim().length).toBeLessThanOrEqual(2);
  });

  it("runs, and never nests inside the row button", () => {
    const onSelect = vi.fn();
    const { container } = row({
      onOpen: () => {},
      action: { icon: "↗", label: "Open it", onSelect },
    });
    expect(container.querySelector(".drow-open button")).toBeNull();
    fireEvent.click(screen.getByLabelText("Open it"));
    expect(onSelect).toHaveBeenCalled();
  });

  it("stays visible but explained when it cannot be used", () => {
    row({
      action: {
        icon: "↗",
        label: "Open project folder",
        hint: "this transcript recorded no working directory",
        disabled: true,
        onSelect: () => {},
      },
    });
    const button = screen.getByLabelText("Open project folder");
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.getAttribute("title")).toMatch(/no working directory/);
  });
});

describe("opening the detail", () => {
  it("makes the whole row the way in", () => {
    const onOpen = vi.fn();
    row({ onOpen });
    fireEvent.click(screen.getByText("node.exe"));
    expect(onOpen).toHaveBeenCalled();
  });

  it("is a plain row when there is nothing to open", () => {
    const { container } = row();
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector(".drow-static")).toBeTruthy();
  });

  it("marks a row needing attention with more than colour", () => {
    const { container } = row({ tone: "warn", title: "orphaned — its parent has exited" });
    expect(container.querySelector(".drow-warn")).toBeTruthy();
    expect(container.querySelector(".drow")?.getAttribute("title")).toMatch(/orphaned/);
  });
});

describe("truncation is honest", () => {
  it("says how many rows it is not showing", () => {
    const onOpen = vi.fn();
    render(<RowOverflow hidden={7} noun="processes" onOpen={onOpen} />);
    fireEvent.click(screen.getByText(/7 more processes/));
    expect(onOpen).toHaveBeenCalled();
  });

  it("renders nothing when the list is complete", () => {
    const { container } = render(<RowOverflow hidden={0} noun="ports" onOpen={() => {}} />);
    expect(container.firstChild).toBeNull();
  });
});
