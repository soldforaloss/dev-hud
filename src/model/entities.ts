// Normalized cross-card entity references.
//
// Cards each know a slice of the same world: the Processes card knows pid
// 18789, the Ports card knows :5434 is owned by pid 18789, the MCP card knows
// a server was launched from that command line. `EntityRef` is the common
// currency that lets the inspector, the attention strip and the command
// palette walk between them without every card knowing about every other.

export type EntityKind =
  | "process"
  | "port"
  | "container"
  | "wsl_distro"
  | "repository"
  | "agent_session"
  | "mcp_server"
  | "gateway"
  | "network_interface"
  | "tailscale_peer"
  | "host";

export interface EntityRef {
  kind: EntityKind;
  /** Stable within `kind` on a given host (pid, port number, repo slug…). */
  id: string;
  label: string;
  /** Absent means "this host". Present so multi-host stays a later addition,
   *  not a rewrite. */
  hostId?: string;
}

export const ENTITY_LABEL: Record<EntityKind, string> = {
  process: "Process",
  port: "Port",
  container: "Container",
  wsl_distro: "WSL distribution",
  repository: "Repository",
  agent_session: "AI session",
  mcp_server: "MCP server",
  gateway: "Gateway",
  network_interface: "Network interface",
  tailscale_peer: "Tailscale peer",
  host: "Host",
};

export const ENTITY_GLYPH: Record<EntityKind, string> = {
  process: "⚙",
  port: "⇌",
  container: "◫",
  wsl_distro: "⌘",
  repository: "⌥",
  agent_session: "✳",
  mcp_server: "⋈",
  gateway: "🦞",
  network_interface: "↯",
  tailscale_peer: "⧉",
  host: "▣",
};

export const LOCAL_HOST_ID = "local";

export function entityRef(
  kind: EntityKind,
  id: string | number,
  label: string,
  hostId?: string,
): EntityRef {
  return { kind, id: String(id), label, ...(hostId ? { hostId } : {}) };
}

/** Map/Set key. Host-qualified so a future remote pid 4 never collides. */
export function entityKey(ref: Pick<EntityRef, "kind" | "id" | "hostId">): string {
  return `${ref.hostId ?? LOCAL_HOST_ID}:${ref.kind}:${ref.id}`;
}

export function sameEntity(a: EntityRef, b: EntityRef): boolean {
  return entityKey(a) === entityKey(b);
}

export function dedupeEntities(refs: readonly EntityRef[]): EntityRef[] {
  const seen = new Map<string, EntityRef>();
  for (const ref of refs) {
    if (!seen.has(entityKey(ref))) seen.set(entityKey(ref), ref);
  }
  return [...seen.values()];
}

/** Which card owns the detail view for an entity kind. */
export const ENTITY_HOME_CARD: Record<EntityKind, string> = {
  process: "procs",
  port: "ports",
  container: "docker",
  wsl_distro: "wsl",
  repository: "repos",
  agent_session: "sessions",
  mcp_server: "mcp",
  gateway: "openclaw",
  network_interface: "netq",
  tailscale_peer: "tailscale",
  host: "system",
};

// ---------- relationship graph ----------

export interface EntityRelation {
  /** How `to` relates to `from`: "listens on", "owned by", "runs in"… */
  label: string;
  to: EntityRef;
}

export interface EntityNode {
  ref: EntityRef;
  /** Card-supplied key/value detail rows, already display-formatted. */
  facts: [string, string][];
  relations: EntityRelation[];
}

/**
 * A resolver, not a database: cards publish nodes each poll, the index is
 * rebuilt from whatever is currently known. Nothing persists, so a dead pid
 * can never linger as a phantom relation.
 */
export class EntityIndex {
  private nodes = new Map<string, EntityNode>();

  add(node: EntityNode): void {
    const key = entityKey(node.ref);
    const existing = this.nodes.get(key);
    if (!existing) {
      this.nodes.set(key, node);
      return;
    }
    // Merge: two cards may each know part of the same entity.
    existing.facts.push(...node.facts);
    existing.relations.push(...node.relations);
  }

  /** Record a relation in both directions so either card can navigate it. */
  link(from: EntityRef, label: string, to: EntityRef, inverseLabel: string): void {
    this.ensure(from).relations.push({ label, to });
    this.ensure(to).relations.push({ label: inverseLabel, to: from });
  }

  private ensure(ref: EntityRef): EntityNode {
    const key = entityKey(ref);
    let node = this.nodes.get(key);
    if (!node) {
      node = { ref, facts: [], relations: [] };
      this.nodes.set(key, node);
    }
    return node;
  }

  get(ref: Pick<EntityRef, "kind" | "id" | "hostId">): EntityNode | undefined {
    const node = this.nodes.get(entityKey(ref));
    if (!node) return undefined;
    return { ...node, relations: dedupeRelations(node.relations) };
  }

  all(): EntityNode[] {
    return [...this.nodes.values()];
  }

  /** Free-text search across labels and ids — powers the command palette. */
  search(query: string, limit = 20): EntityNode[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const scored: [number, EntityNode][] = [];
    for (const node of this.nodes.values()) {
      let score = -1;
      // Ids and labels carry structural punctuation the user doesn't type:
      // searching "5434" must match the port entity `tcp/5434` labelled
      // ":5434" exactly, not merely as a substring of `tcp/15434`.
      for (const candidate of searchKeys(node.ref)) {
        const hit = candidate === q ? 0 : candidate.startsWith(q) ? 1 : candidate.includes(q) ? 2 : -1;
        if (hit >= 0 && (score < 0 || hit < score)) score = hit;
      }
      if (score >= 0) scored.push([score, node]);
    }
    scored.sort((a, b) => a[0] - b[0] || a[1].ref.label.localeCompare(b[1].ref.label));
    return scored.slice(0, limit).map(([, n]) => n);
  }
}

/** Every form of an entity's id/label a user might reasonably type. */
function searchKeys(ref: EntityRef): string[] {
  const id = ref.id.toLowerCase();
  const label = ref.label.toLowerCase();
  const keys = new Set([id, label]);
  const lastSegment = id.split("/").pop();
  if (lastSegment) keys.add(lastSegment);
  keys.add(label.replace(/^[^a-z0-9]+/, ""));
  return [...keys].filter(Boolean);
}

function dedupeRelations(relations: readonly EntityRelation[]): EntityRelation[] {
  const seen = new Set<string>();
  const out: EntityRelation[] = [];
  for (const r of relations) {
    const key = `${r.label}|${entityKey(r.to)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}
