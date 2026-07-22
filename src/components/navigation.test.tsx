import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { classifyDensity, rowBudget } from "./density";
import { parseQuery, rankCommands, searchEntities } from "./CommandPalette";
import type { PaletteCommand } from "./CommandPalette";
import { CommandPalette } from "./CommandPalette";
import { EntityIndex, entityRef } from "../model/entities";

describe("card density breakpoints", () => {
  it("classifies by the card's own box, not the viewport", () => {
    expect(classifyDensity(200, 400)).toBe("compact"); // too narrow
    expect(classifyDensity(600, 100)).toBe("compact"); // too short
    expect(classifyDensity(300, 200)).toBe("standard");
    expect(classifyDensity(420, 300)).toBe("expanded");
  });

  it("stays standard until it has been measured", () => {
    expect(classifyDensity(0, 0)).toBe("standard");
  });

  it("scales the row budget with density", () => {
    expect(rowBudget("compact")).toBeLessThan(rowBudget("standard"));
    expect(rowBudget("standard")).toBeLessThan(rowBudget("expanded"));
  });
});

describe("palette query parsing", () => {
  it("understands the documented field prefixes", () => {
    expect(parseQuery("pid:18789")).toMatchObject({ field: "pid", term: "18789" });
    expect(parseQuery("port: 5434")).toMatchObject({ field: "port", term: "5434" });
    expect(parseQuery("repo:openclaw")).toMatchObject({ field: "repo", term: "openclaw" });
    expect(parseQuery("mcp:playwright")).toMatchObject({ field: "mcp", term: "playwright" });
  });

  it("treats an unknown prefix as free text", () => {
    expect(parseQuery("wat:thing").field).toBeNull();
    expect(parseQuery("show orphan processes").field).toBeNull();
  });

  it("filters entities to the kind named by the prefix", () => {
    const index = new EntityIndex();
    index.add({ ref: entityRef("port", "tcp/5434", ":5434"), facts: [], relations: [] });
    index.add({ ref: entityRef("process", "5434", "node (pid 5434)"), facts: [], relations: [] });
    const ports = searchEntities(index, parseQuery("port:5434"));
    expect(ports).toHaveLength(1);
    expect(ports[0].ref.kind).toBe("port");
  });

  it("ranks an exact command name above a substring match", () => {
    const cmds: PaletteCommand[] = [
      { id: "a", label: "Open network diagnostics", group: "Find", run: () => {} },
      { id: "b", label: "Network", group: "Navigate", run: () => {} },
    ];
    expect(rankCommands(cmds, "network")[0].id).toBe("b");
  });
});

describe("command palette", () => {
  const index = new EntityIndex();
  index.add({ ref: entityRef("process", "18789", "gateway (pid 18789)"), facts: [], relations: [] });

  it("finds a process by pid without the user scanning cards", () => {
    const onOpenEntity = vi.fn();
    render(
      <CommandPalette commands={[]} index={index} onClose={() => {}} onOpenEntity={onOpenEntity} />,
    );
    fireEvent.change(screen.getByLabelText("Search entities and commands"), {
      target: { value: "pid:18789" },
    });
    fireEvent.click(screen.getByText("gateway (pid 18789)"));
    expect(onOpenEntity).toHaveBeenCalledWith(expect.objectContaining({ kind: "process", id: "18789" }));
  });

  it("requires a second Enter before running a destructive command", () => {
    const run = vi.fn();
    const commands: PaletteCommand[] = [
      { id: "kill", label: "Terminate all orphan processes", group: "Actions", destructive: true, run },
    ];
    render(
      <CommandPalette commands={commands} index={new EntityIndex()} onClose={() => {}} onOpenEntity={() => {}} />,
    );
    const input = screen.getByLabelText("Search entities and commands");
    fireEvent.change(input, { target: { value: "terminate" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(run).not.toHaveBeenCalled();
    expect(screen.getByText(/Press Enter again/)).toBeTruthy();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(
      <CommandPalette commands={[]} index={new EntityIndex()} onClose={onClose} onOpenEntity={() => {}} />,
    );
    fireEvent.keyDown(screen.getByLabelText("Search entities and commands"), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
