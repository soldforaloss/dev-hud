// Build the cross-card entity graph from one poll's worth of payloads.
//
// Cards keep publishing only what they know; the joins live here. Everything
// is rebuilt from the current snapshot each cycle, so a dead pid can never
// survive as a phantom edge — the correctness property that makes "click the
// port, get the process" trustworthy.

import type { StatusBundle } from "./cardStatus";
import { EntityIndex, entityRef } from "./entities";
import type { EntityRef } from "./entities";
import type { Redactor } from "./privacy";
import { maskSecrets } from "./privacy";
import { fmtBytes, fmtDuration } from "../format";

export interface GraphResult {
  index: EntityIndex;
  /** pid → ports it listens on, reused by the Processes card's badges. */
  portsByPid: Record<number, number[]>;
}

export function buildEntityGraph(bundle: StatusBundle, r: Redactor): GraphResult {
  const index = new EntityIndex();
  const portsByPid: Record<number, number[]> = {};

  // ---- processes ----
  const procByPid = new Map<number, EntityRef>();
  for (const p of bundle.procs?.processes ?? []) {
    const ref = entityRef("process", p.pid, `${p.label ?? p.name} (pid ${p.pid})`);
    procByPid.set(p.pid, ref);
    index.add({
      ref,
      facts: [
        ["PID", String(p.pid)],
        ["Parent PID", p.ppid != null ? String(p.ppid) : "—"],
        ["Executable", p.name],
        ["Command", r.args(maskSecrets(p.cmdSummary)) ?? "—"],
        ["Working directory", r.path(p.cwd) ?? "—"],
        ["Started", `${fmtDuration(Math.max(0, Date.now() / 1000 - p.startTimeUnix))} ago`],
        ["CPU", `${p.cpuPercent.toFixed(1)}%`],
        ["Memory", fmtBytes(p.memBytes)],
        ["Idle for", p.idleSecs > 0 ? fmtDuration(p.idleSecs) : "active now"],
        ["Orphaned", p.orphaned ? "yes — its parent chain is gone" : "no"],
        ["Terminable", p.killable ? "yes" : "no — access denied"],
      ],
      relations: [],
    });
  }
  // Parent/child edges, second pass so both ends exist.
  for (const p of bundle.procs?.processes ?? []) {
    const self = procByPid.get(p.pid);
    if (!self) continue;
    const parent = p.ppid != null ? procByPid.get(p.ppid) : undefined;
    if (parent) index.link(self, "child of", parent, "parent of");
    for (const child of p.childPids.slice(0, 12)) {
      const childRef = procByPid.get(child);
      if (childRef) index.link(self, "parent of", childRef, "child of");
    }
  }

  // ---- ports → owning process ----
  for (const l of bundle.ports?.listeners ?? []) {
    (portsByPid[l.pid] ??= []).push(l.port);
    const ref = entityRef("port", `${l.proto}/${l.port}`, `:${l.port}`);
    index.add({
      ref,
      facts: [
        ["Port", String(l.port)],
        ["Protocol", l.proto.toUpperCase()],
        ["Family", l.family === "v4" ? "IPv4" : "IPv6"],
        ["Bind address", r.ip(l.bindAddr) ?? "—"],
        ["Exposure", exposureLabel(l.exposure)],
        ["Owning PID", String(l.pid)],
        ["Process", l.process],
        [
          "First seen",
          l.firstSeenUnix > 0
            ? `${fmtDuration(Math.max(0, Date.now() / 1000 - l.firstSeenUnix))} ago`
            : "—",
        ],
      ],
      relations: [],
    });
    const owner = procByPid.get(l.pid);
    if (owner) index.link(ref, "owned by", owner, "listens on");
  }

  // ---- containers ----
  for (const c of bundle.docker?.containers ?? []) {
    const ref = entityRef("container", c.name, c.name);
    index.add({
      ref,
      facts: [
        ["Image", c.image],
        ["State", c.state],
        ["Status", c.status],
        ["Health", c.health ?? "no healthcheck defined"],
        ["Restarts", c.restartCount != null ? String(c.restartCount) : "—"],
        ["CPU", c.cpuPercent != null ? `${c.cpuPercent.toFixed(1)}%` : "— not measured"],
        ["Memory", c.memBytes != null ? fmtBytes(c.memBytes) : "— not measured"],
        ["Ports", c.ports ?? "none published"],
      ],
      relations: [],
    });
    // A published host port is the same socket the Ports card enumerated.
    for (const m of c.portList ?? []) {
      if (m.hostPort == null) continue;
      const portRef = entityRef("port", `${m.proto}/${m.hostPort}`, `:${m.hostPort}`);
      index.link(ref, "publishes", portRef, "published by");
    }
  }

  // ---- WSL distributions ----
  for (const d of bundle.wsl?.distros ?? []) {
    index.add({
      ref: entityRef("wsl_distro", d.name, d.name),
      facts: [
        ["State", d.state],
        ["WSL version", d.version],
        ["Default", d.isDefault ? "yes" : "no"],
        ["Disk image", d.diskBytes != null ? fmtBytes(d.diskBytes) : "— not measured"],
        ["Docker integration", d.dockerIntegration ? "available" : "not detected"],
      ],
      relations: [],
    });
  }

  // ---- MCP servers → owning process ----
  for (const s of bundle.mcp?.servers ?? []) {
    const ref = entityRef("mcp_server", `${s.source}/${s.name}`, s.name);
    index.add({
      ref,
      facts: [
        ["Configured in", s.source],
        ["Command", r.args(maskSecrets(s.command)) ?? "—"],
        ["Live process", s.running ? "yes" : "no — starts on demand"],
        ["PID", s.pid != null ? String(s.pid) : "—"],
        ["Working directory", r.path(s.cwd) ?? "—"],
      ],
      relations: [],
    });
    const owner = s.pid != null ? procByPid.get(s.pid) : undefined;
    if (owner) index.link(ref, "runs as", owner, "hosts MCP server");
  }

  // ---- gateway ----
  if (bundle.openclaw?.installed || bundle.openclaw?.reachable) {
    const g = bundle.openclaw;
    const ref = entityRef("gateway", String(g.port), `OpenClaw :${g.port}`);
    index.add({
      ref,
      facts: [
        ["Port", String(g.port)],
        ["Reachable", g.reachable ? "yes" : "no"],
        ["HTTP status", g.httpStatus != null ? String(g.httpStatus) : "—"],
        ["Latency", g.latencyMs != null ? `${g.latencyMs} ms` : "—"],
        ["Uptime", g.uptimeSecs != null ? fmtDuration(g.uptimeSecs) : "—"],
        ["p95 latency", g.p95Ms != null ? `${g.p95Ms.toFixed(0)} ms` : "— not reported"],
        ["Error rate", g.errorRate != null ? `${(g.errorRate * 100).toFixed(1)}%` : "— not reported"],
      ],
      relations: [],
    });
    const owner = g.pid != null ? procByPid.get(g.pid) : undefined;
    if (owner) index.link(ref, "served by", owner, "serves");
    const portRef = entityRef("port", `tcp/${g.port}`, `:${g.port}`);
    index.link(ref, "listens on", portRef, "used by");
  }

  // ---- local repositories → processes working in them ----
  const repoByPath = new Map<string, EntityRef>();
  for (const repo of bundle.git?.repos ?? []) {
    const ref = entityRef("repository", repo.remoteSlug ?? repo.path, r.repo(repo.name) ?? repo.name);
    repoByPath.set(normalizePath(repo.path), ref);
    index.add({
      ref,
      facts: [
        ["Path", r.path(repo.path) ?? "—"],
        ["Branch", repo.branch ?? "detached HEAD"],
        ["Upstream", repo.upstream ?? "none"],
        ["Uncommitted files", String(repo.dirtyCount)],
        ["Ahead / behind", `${repo.ahead} / ${repo.behind}`],
        ["Last commit", repo.lastCommitSubject ?? "—"],
        ["Test command", repo.testCommand ?? "none detected"],
      ],
      relations: [],
    });
  }
  // A GitHub repo and a local clone of it are the same entity.
  for (const gh of bundle.repos?.repos ?? []) {
    const ref = entityRef("repository", gh.repo, r.repo(gh.repo) ?? gh.repo);
    index.add({
      ref,
      facts: [
        ["Default branch", gh.defaultBranch ?? "—"],
        ["CI", gh.ciStatus ?? "no runs"],
        ["Open PRs", gh.openPrs != null ? String(gh.openPrs) : "—"],
        ["Open issues", gh.openIssues != null ? String(gh.openIssues) : "—"],
        ["Latest release", gh.release?.tag ?? "none"],
      ],
      relations: [],
    });
  }
  for (const p of bundle.procs?.processes ?? []) {
    if (!p.cwd) continue;
    const self = procByPid.get(p.pid);
    const repo = findEnclosingRepo(repoByPath, p.cwd);
    if (self && repo) index.link(self, "works in", repo, "has running process");
  }

  // ---- agent sessions → repository ----
  const sessions = [
    ...(bundle.claude?.activeSessions ?? []).map((s) => ({ provider: "claude", ...s })),
    ...(bundle.codex?.activeSessions ?? []).map((s) => ({ provider: "codex", ...s })),
  ];
  for (const s of sessions) {
    const ref = entityRef(
      "agent_session",
      `${s.provider}:${s.cwd ?? s.name}`,
      `${s.provider} · ${r.repo(s.name) ?? s.name}`,
    );
    index.add({
      ref,
      facts: [
        ["Provider", s.provider],
        ["Model", s.model ?? "— not recorded in this transcript"],
        ["Working directory", r.path(s.cwd) ?? "—"],
        ["Last output", `${fmtDuration(s.ageSecs)} ago`],
        ["Tokens", s.tokens != null ? s.tokens.toLocaleString() : "— not attributable"],
      ],
      relations: [],
    });
    const repo = s.cwd ? findEnclosingRepo(repoByPath, s.cwd) : undefined;
    if (repo) index.link(ref, "works in", repo, "has active session");
  }

  // ---- tailscale peers ----
  for (const peer of bundle.tailscale?.peers ?? []) {
    index.add({
      ref: entityRef("tailscale_peer", peer.name, r.peer(peer.name) ?? peer.name),
      facts: [
        ["Online", peer.online ? "yes" : "no"],
        ["Path", peer.direct ? "direct" : `relayed via DERP ${peer.relay ?? "?"}`],
        ["OS", peer.os ?? "—"],
        ["Address", r.ip(peer.ip) ?? "—"],
        ["Last seen", peer.lastSeen ?? "—"],
        ["Exit node", peer.exitNode ? "yes" : "no"],
      ],
      relations: [],
    });
  }

  // ---- this host ----
  index.add({
    ref: entityRef("host", "local", "This machine"),
    facts: bundle.system
      ? [
          ["CPU", `${bundle.system.cpuPercent.toFixed(0)}%`],
          ["Memory", `${fmtBytes(bundle.system.memUsed)} of ${fmtBytes(bundle.system.memTotal)}`],
          ["LAN address", r.ip(bundle.system.localIp) ?? "—"],
          ["Public address", r.ip(bundle.system.publicIp) ?? "—"],
        ]
      : [],
    relations: [],
  });

  for (const list of Object.values(portsByPid)) list.sort((a, b) => a - b);
  return { index, portsByPid };
}

function exposureLabel(exposure: string): string {
  return exposure === "loopback"
    ? "loopback only — not reachable from the network"
    : exposure === "lan"
      ? "reachable from the local network"
      : "bound to all interfaces — reachable from anywhere routable";
}

function normalizePath(p: string): string {
  return p.replace(/[\\/]+$/, "").toLowerCase().replace(/\//g, "\\");
}

/** Longest matching repo prefix, so a nested clone wins over its parent. */
function findEnclosingRepo(
  repos: Map<string, EntityRef>,
  cwd: string,
): EntityRef | undefined {
  const needle = normalizePath(cwd);
  let best: EntityRef | undefined;
  let bestLen = -1;
  for (const [path, ref] of repos) {
    if ((needle === path || needle.startsWith(`${path}\\`)) && path.length > bestLen) {
      best = ref;
      bestLen = path.length;
    }
  }
  return best;
}
