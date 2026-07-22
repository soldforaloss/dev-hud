// Incident snapshots.
//
// When a critical alert opens, the interesting state is the state *right
// then* — five minutes later the container has restarted and the process is
// gone. A snapshot freezes it locally so the post-mortem is possible after
// recovery.
//
// Snapshots are always redacted, regardless of whether privacy mode is on:
// they are files, and files get shared.

import type { StatusBundle } from "./cardStatus";
import type { AlertRecord } from "./alerts";
import type { ActivityEvent } from "./events";
import { Redactor, maskSecrets } from "./privacy";

export interface IncidentSnapshot {
  id: string;
  atMs: number;
  /** Why it was captured: an alert title, or "Manual capture". */
  reason: string;
  sizeBytes: number;
  data: SnapshotData;
}

export interface SnapshotData {
  capturedAt: string;
  reason: string;
  system: unknown;
  thermals: unknown;
  disks: unknown;
  network: unknown;
  processes: unknown;
  ports: unknown;
  containers: unknown;
  wsl: unknown;
  gateway: unknown;
  mcp: unknown;
  sessions: unknown;
  repositories: unknown;
  alerts: unknown;
  events: unknown;
}

let snapSeq = 0;

/**
 * Build a redacted snapshot. The redactor is constructed here with
 * `enabled: true` unconditionally — a snapshot must never be the hole that
 * privacy mode doesn't cover.
 */
export function buildSnapshot(
  reason: string,
  bundle: StatusBundle,
  alerts: readonly AlertRecord[],
  events: readonly ActivityEvent[],
  atMs = Date.now(),
): IncidentSnapshot {
  const r = new Redactor(true);
  const data: SnapshotData = {
    capturedAt: new Date(atMs).toISOString(),
    reason,
    system: bundle.system
      ? {
          cpuPercent: bundle.system.cpuPercent,
          memUsed: bundle.system.memUsed,
          memTotal: bundle.system.memTotal,
          commitUsed: bundle.system.commitUsed,
          commitTotal: bundle.system.commitTotal,
          netRxBps: bundle.system.netRxBps,
          netTxBps: bundle.system.netTxBps,
          queueLength: bundle.system.queueLength,
          localIp: r.ip(bundle.system.localIp),
          publicIp: r.ip(bundle.system.publicIp),
          topProcesses: (bundle.system.topProcesses ?? []).map((p) => ({
            name: p.name,
            cpuPercent: p.cpuPercent,
            memBytes: p.memBytes,
          })),
        }
      : null,
    thermals: bundle.thermals,
    disks: bundle.disks
      ? {
          readBps: bundle.disks.readBps,
          writeBps: bundle.disks.writeBps,
          latencyMs: bundle.disks.latencyMs,
          volumes: bundle.disks.volumes.map((v) => ({
            mount: v.mount,
            total: v.total,
            available: v.available,
            fs: v.fs,
            kind: v.kind,
            smartOk: v.smartOk,
          })),
        }
      : null,
    network: bundle.netq
      ? {
          mode: bundle.netq.mode,
          latencyMs: bundle.netq.latencyMs,
          avgMs: bundle.netq.avgMs,
          jitterMs: bundle.netq.jitterMs,
          lossPercent: bundle.netq.lossPercent,
          dnsMs: bundle.netq.dnsMs,
          linkType: bundle.netq.linkType,
          // SSID names a physical location; the interface name can too.
          interfaceName: r.host(bundle.netq.interfaceName),
          wifiSsid: r.host(bundle.netq.wifiSsid),
          wifiSignal: bundle.netq.wifiSignal,
        }
      : null,
    processes: bundle.procs
      ? bundle.procs.processes.slice(0, 60).map((p) => ({
          pid: p.pid,
          ppid: p.ppid,
          name: p.name,
          label: p.label,
          // Command lines carry tokens and absolute paths — never verbatim.
          cmdSummary: r.args(maskSecrets(p.cmdSummary)),
          cwd: r.path(p.cwd),
          cpuPercent: p.cpuPercent,
          memBytes: p.memBytes,
          orphaned: p.orphaned,
          idleSecs: p.idleSecs,
        }))
      : null,
    ports: bundle.ports
      ? bundle.ports.listeners.slice(0, 100).map((l) => ({
          port: l.port,
          pid: l.pid,
          process: l.process,
          proto: l.proto,
          family: l.family,
          bindAddr: r.ip(l.bindAddr),
          exposure: l.exposure,
        }))
      : null,
    containers: bundle.docker
      ? bundle.docker.containers.map((c) => ({
          name: c.name,
          image: c.image,
          state: c.state,
          health: c.health,
          restartCount: c.restartCount,
          cpuPercent: c.cpuPercent,
          memBytes: c.memBytes,
        }))
      : null,
    wsl: bundle.wsl,
    gateway: bundle.openclaw
      ? {
          port: bundle.openclaw.port,
          reachable: bundle.openclaw.reachable,
          httpStatus: bundle.openclaw.httpStatus,
          latencyMs: bundle.openclaw.latencyMs,
          uptimeSecs: bundle.openclaw.uptimeSecs,
          errorRate: bundle.openclaw.errorRate,
          p95Ms: bundle.openclaw.p95Ms,
          activeRequests: bundle.openclaw.activeRequests,
          lastError: r.text(maskSecrets(bundle.openclaw.lastError ?? "")),
        }
      : null,
    mcp: bundle.mcp
      ? bundle.mcp.servers.map((s) => ({
          name: s.name,
          source: s.source,
          running: s.running,
          pid: s.pid,
          cwd: r.path(s.cwd),
        }))
      : null,
    sessions: [
      ...(bundle.claude?.activeSessions ?? []).map((s) => ({ provider: "claude", ...redactSession(r, s) })),
      ...(bundle.codex?.activeSessions ?? []).map((s) => ({ provider: "codex", ...redactSession(r, s) })),
    ],
    repositories: bundle.git
      ? bundle.git.repos.map((repo) => ({
          name: r.repo(repo.name),
          branch: repo.branch,
          dirtyCount: repo.dirtyCount,
          ahead: repo.ahead,
          behind: repo.behind,
        }))
      : null,
    alerts: alerts.slice(0, 50).map((a) => ({
      severity: a.severity,
      state: a.state,
      title: r.text(a.title),
      message: r.text(maskSecrets(a.message)),
      firstSeenAt: a.firstSeenAt,
      lastSeenAt: a.lastSeenAt,
      recoveredAt: a.recoveredAt,
      currentValue: a.currentValue,
      threshold: a.threshold,
    })),
    events: events.slice(0, 120).map((e) => ({
      timestamp: e.timestamp,
      category: e.category,
      severity: e.severity,
      title: r.text(e.title),
      detail: r.text(maskSecrets(e.detail ?? "")),
    })),
  };

  snapSeq += 1;
  const json = JSON.stringify(data);
  return {
    id: `${atMs.toString(36)}-${snapSeq.toString(36)}`,
    atMs,
    reason,
    sizeBytes: json.length,
    data,
  };
}

function redactSession(r: Redactor, s: { name: string; cwd: string | null; ageSecs: number; model: string | null }) {
  return {
    name: r.repo(s.name),
    cwd: r.path(s.cwd),
    ageSecs: s.ageSecs,
    model: s.model,
  };
}

/** Newest-first retention by both count and total bytes. */
export function pruneSnapshots(
  snapshots: readonly IncidentSnapshot[],
  maxCount: number,
  maxBytes: number,
): IncidentSnapshot[] {
  const sorted = [...snapshots].sort((a, b) => b.atMs - a.atMs).slice(0, maxCount);
  const kept: IncidentSnapshot[] = [];
  let total = 0;
  for (const s of sorted) {
    if (total + s.sizeBytes > maxBytes && kept.length > 0) break;
    kept.push(s);
    total += s.sizeBytes;
  }
  return kept;
}
