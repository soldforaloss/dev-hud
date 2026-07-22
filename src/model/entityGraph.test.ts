import { describe, expect, it } from "vitest";
import type { StatusBundle } from "./cardStatus";
import { buildEntityGraph } from "./entityGraph";
import { EntityIndex, entityKey, entityRef } from "./entities";
import { Redactor } from "./privacy";

function bundle(over: Partial<StatusBundle> = {}): StatusBundle {
  return {
    claude: null, codex: null, openclaw: null, system: null, gpu: null,
    thermals: null, disks: null, netq: null, ports: null, wsl: null,
    battery: null, uptime: null, tailscale: null, docker: null, ollama: null,
    winget: null, mcp: null, procs: null, repos: null, git: null, diag: null,
    custom: {},
    ...over,
  };
}

const proc = (over: Record<string, unknown> = {}) => ({
  pid: 18789, ppid: 4242, name: "node.exe", label: "OpenClaw Gateway",
  cmdSummary: "node gateway.js --token abcdefghijklmnop",
  cwd: "C:\\work\\openclaw", startTimeUnix: 1_700_000_000, memBytes: 1024,
  cpuPercent: 1.5, killable: true, childPids: [], parentApp: null,
  orphaned: false, idleSecs: 0, ...over,
});

const listener = (over: Record<string, unknown> = {}) => ({
  port: 5434, pid: 18789, process: "node.exe", proto: "tcp" as const,
  family: "v4" as const, bindAddr: "0.0.0.0", exposure: "public" as const,
  firstSeenUnix: 1_700_000_000, ...over,
});

describe("entity graph", () => {
  it("links a port to the process that owns it, in both directions", () => {
    const { index } = buildEntityGraph(
      bundle({
        procs: { scannedAt: "", processes: [proc()] },
        ports: { listeners: [listener()], error: null },
      }),
      new Redactor(false),
    );
    const port = index.get({ kind: "port", id: "tcp/5434" });
    expect(port?.relations.some((r) => r.to.kind === "process" && r.to.id === "18789")).toBe(true);
    const process = index.get({ kind: "process", id: "18789" });
    expect(process?.relations.some((r) => r.label === "listens on")).toBe(true);
  });

  it("exposes portsByPid for the process card's badges", () => {
    const { portsByPid } = buildEntityGraph(
      bundle({
        procs: { scannedAt: "", processes: [proc()] },
        ports: { listeners: [listener(), listener({ port: 5173 })], error: null },
      }),
      new Redactor(false),
    );
    expect(portsByPid[18789]).toEqual([5173, 5434]);
  });

  it("links a process to the repository whose folder it runs in", () => {
    const { index } = buildEntityGraph(
      bundle({
        procs: { scannedAt: "", processes: [proc({ cwd: "C:\\work\\openclaw\\packages\\api" })] },
        git: {
          gitAvailable: true, roots: ["C:\\work"],
          repos: [
            {
              path: "C:\\work\\openclaw", name: "openclaw", branch: "main",
              dirtyCount: 2, ahead: 1, behind: 0, upstream: "origin/main",
              lastCommitSubject: "fix", lastCommitUnix: 1, remoteSlug: "acme/openclaw",
              testCommand: "npm test", error: null,
            },
          ],
        },
      }),
      new Redactor(false),
    );
    const p = index.get({ kind: "process", id: "18789" });
    expect(p?.relations.some((r) => r.label === "works in" && r.to.kind === "repository")).toBe(true);
  });

  it("prefers the innermost repository when clones are nested", () => {
    const { index } = buildEntityGraph(
      bundle({
        procs: { scannedAt: "", processes: [proc({ cwd: "C:\\work\\outer\\inner\\src" })] },
        git: {
          gitAvailable: true, roots: [],
          repos: [
            { path: "C:\\work\\outer", name: "outer", branch: null, dirtyCount: 0, ahead: 0, behind: 0, upstream: null, lastCommitSubject: null, lastCommitUnix: null, remoteSlug: "a/outer", testCommand: null, error: null },
            { path: "C:\\work\\outer\\inner", name: "inner", branch: null, dirtyCount: 0, ahead: 0, behind: 0, upstream: null, lastCommitSubject: null, lastCommitUnix: null, remoteSlug: "a/inner", testCommand: null, error: null },
          ],
        },
      }),
      new Redactor(false),
    );
    const p = index.get({ kind: "process", id: "18789" });
    const repo = p?.relations.find((r) => r.to.kind === "repository");
    expect(repo?.to.id).toBe("a/inner");
  });

  it("masks secrets and redacts paths in entity facts under privacy mode", () => {
    const { index } = buildEntityGraph(
      bundle({ procs: { scannedAt: "", processes: [proc()] } }),
      new Redactor(true),
    );
    const facts = index.get({ kind: "process", id: "18789" })?.facts ?? [];
    const flat = facts.map(([, v]) => v).join(" ");
    expect(flat).not.toContain("abcdefghijklmnop");
    expect(flat).not.toContain("C:\\work\\openclaw");
  });

  it("rebuilds from scratch so a dead process leaves no phantom edge", () => {
    const first = buildEntityGraph(
      bundle({
        procs: { scannedAt: "", processes: [proc()] },
        ports: { listeners: [listener()], error: null },
      }),
      new Redactor(false),
    );
    expect(first.index.get({ kind: "process", id: "18789" })).toBeTruthy();
    const second = buildEntityGraph(
      bundle({ procs: { scannedAt: "", processes: [] }, ports: { listeners: [], error: null } }),
      new Redactor(false),
    );
    expect(second.index.get({ kind: "process", id: "18789" })).toBeUndefined();
  });
});

describe("entity index", () => {
  it("keys entities per host so a future remote pid cannot collide", () => {
    const a = entityRef("process", 4, "svc");
    const b = entityRef("process", 4, "svc", "laptop");
    expect(entityKey(a)).not.toBe(entityKey(b));
  });

  it("ranks exact id matches above substring matches", () => {
    const index = new EntityIndex();
    index.add({ ref: entityRef("port", "tcp/5434", ":5434"), facts: [], relations: [] });
    index.add({ ref: entityRef("port", "tcp/15434", ":15434"), facts: [], relations: [] });
    const hits = index.search("5434");
    expect(hits[0].ref.id).toBe("tcp/5434");
  });
});
