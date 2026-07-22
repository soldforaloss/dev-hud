// Ctrl/Cmd-K palette: find any entity, run any safe command.
//
// The point is to remove visual scanning. `pid:18789` should land on the
// process without the user knowing which card owns it, and every command the
// header or an overflow menu offers should be reachable by typing its name.

import { useEffect, useMemo, useRef, useState } from "react";
import type { EntityIndex, EntityNode, EntityRef } from "../model/entities";
import { ENTITY_GLYPH, ENTITY_LABEL, entityKey } from "../model/entities";

export interface PaletteCommand {
  id: string;
  label: string;
  hint?: string;
  group: string;
  /** Destructive commands are labelled and require a second confirming Enter. */
  destructive?: boolean;
  run: () => void;
  keywords?: string[];
}

export interface ParsedQuery {
  /** Prefix filter such as `pid`, `port`, `repo`, `mcp`, `container`. */
  field: string | null;
  term: string;
  raw: string;
}

const FIELD_TO_KIND: Record<string, string> = {
  pid: "process",
  proc: "process",
  process: "process",
  port: "port",
  repo: "repository",
  mcp: "mcp_server",
  container: "container",
  docker: "container",
  wsl: "wsl_distro",
  peer: "tailscale_peer",
  session: "agent_session",
};

/** `pid:18789` → {field:"pid", term:"18789"}; anything else is free text. */
export function parseQuery(raw: string): ParsedQuery {
  const trimmed = raw.trim();
  const match = /^([a-z_]+):\s*(.*)$/i.exec(trimmed);
  if (match && FIELD_TO_KIND[match[1].toLowerCase()]) {
    return { field: match[1].toLowerCase(), term: match[2].trim(), raw: trimmed };
  }
  return { field: null, term: trimmed, raw: trimmed };
}

/** Substring match over label, hint and keywords; exact-prefix ranks higher. */
export function rankCommands(
  commands: readonly PaletteCommand[],
  term: string,
  limit = 12,
): PaletteCommand[] {
  const q = term.trim().toLowerCase();
  if (!q) return commands.slice(0, limit);
  const scored: [number, PaletteCommand][] = [];
  for (const c of commands) {
    const haystacks = [c.label, c.hint ?? "", ...(c.keywords ?? [])].map((s) => s.toLowerCase());
    let best = -1;
    for (const h of haystacks) {
      if (h === q) best = Math.max(best, 3);
      else if (h.startsWith(q)) best = Math.max(best, 2);
      else if (h.includes(q)) best = Math.max(best, 1);
    }
    if (best > 0) scored.push([best, c]);
  }
  scored.sort((a, b) => b[0] - a[0] || a[1].label.localeCompare(b[1].label));
  return scored.slice(0, limit).map(([, c]) => c);
}

export function searchEntities(
  index: EntityIndex,
  parsed: ParsedQuery,
  limit = 12,
): EntityNode[] {
  if (parsed.field) {
    const kind = FIELD_TO_KIND[parsed.field];
    const all = index.all().filter((n) => n.ref.kind === kind);
    if (!parsed.term) return all.slice(0, limit);
    const q = parsed.term.toLowerCase();
    return all
      .filter((n) => n.ref.id.toLowerCase().includes(q) || n.ref.label.toLowerCase().includes(q))
      .slice(0, limit);
  }
  return parsed.term.length >= 2 ? index.search(parsed.term, limit) : [];
}

export interface CommandPaletteProps {
  commands: PaletteCommand[];
  index: EntityIndex;
  onClose: () => void;
  onOpenEntity: (ref: EntityRef) => void;
}

export function CommandPalette({ commands, index, onClose, onOpenEntity }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [armed, setArmed] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const parsed = useMemo(() => parseQuery(query), [query]);
  const entities = useMemo(() => searchEntities(index, parsed), [index, parsed]);
  const matchedCommands = useMemo(
    () => (parsed.field ? [] : rankCommands(commands, parsed.term)),
    [commands, parsed],
  );

  type Row =
    | { kind: "command"; cmd: PaletteCommand }
    | { kind: "entity"; node: EntityNode };
  const rows: Row[] = useMemo(
    () => [
      ...entities.map((node) => ({ kind: "entity" as const, node })),
      ...matchedCommands.map((cmd) => ({ kind: "command" as const, cmd })),
    ],
    [entities, matchedCommands],
  );

  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => {
    setCursor(0);
    setArmed(null);
  }, [query]);

  const activate = (row: Row) => {
    if (row.kind === "entity") {
      onOpenEntity(row.node.ref);
      onClose();
      return;
    }
    // A destructive command needs a second, deliberate Enter.
    if (row.cmd.destructive && armed !== row.cmd.id) {
      setArmed(row.cmd.id);
      return;
    }
    onClose();
    row.cmd.run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(rows.length - 1, c + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(0, c - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const row = rows[cursor];
      if (row) activate(row);
    }
  };

  return (
    <div className="palette-scrim" onMouseDown={onClose}>
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="palette-input"
          value={query}
          placeholder="Search pid:18789 · port:5434 · repo:name · or type a command"
          aria-label="Search entities and commands"
          aria-describedby="palette-help"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="palette-rows" role="listbox" aria-label="Results">
          {rows.length === 0 ? (
            <div className="palette-empty muted small">
              {parsed.raw
                ? "Nothing matches. Try pid:, port:, repo:, mcp: or a command name."
                : "Type to search."}
            </div>
          ) : (
            rows.map((row, i) => {
              const selected = i === cursor;
              const key =
                row.kind === "entity" ? `e:${entityKey(row.node.ref)}` : `c:${row.cmd.id}`;
              return (
                <div
                  key={key}
                  role="option"
                  aria-selected={selected}
                  className={`palette-row${selected ? " palette-row-sel" : ""}${
                    row.kind === "command" && row.cmd.destructive ? " palette-row-danger" : ""
                  }`}
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => activate(row)}
                >
                  {row.kind === "entity" ? (
                    <>
                      <span className="palette-glyph" aria-hidden="true">
                        {ENTITY_GLYPH[row.node.ref.kind]}
                      </span>
                      <span className="palette-label">{row.node.ref.label}</span>
                      <span className="palette-group">{ENTITY_LABEL[row.node.ref.kind]}</span>
                    </>
                  ) : (
                    <>
                      <span className="palette-glyph" aria-hidden="true">
                        {row.cmd.destructive ? "⚠" : "›"}
                      </span>
                      <span className="palette-label">
                        {armed === row.cmd.id ? `Press Enter again: ${row.cmd.label}` : row.cmd.label}
                      </span>
                      <span className="palette-group">{row.cmd.group}</span>
                    </>
                  )}
                </div>
              );
            })
          )}
        </div>
        <div className="palette-help muted small" id="palette-help">
          ↑↓ move · Enter run · Esc close · destructive commands need Enter twice
        </div>
      </div>
    </div>
  );
}
