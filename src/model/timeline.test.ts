import { describe, expect, it } from "vitest";
import { appendEvents, filterEvents, makeEvent } from "./events";
import type { Series } from "./history";
import { EMPTY_SERIES, pushSample, recordAll, seriesStats, windowed } from "./history";
import { buildSnapshot, pruneSnapshots } from "./snapshots";
import type { StatusBundle } from "./cardStatus";

const T0 = 1_700_000_000_000;

describe("event log", () => {
  it("drops a repeat of the same state for the same subject", () => {
    const first = makeEvent({ category: "network", title: "Tailscale relayed", dedupeKey: "ts=relay" }, T0);
    const same = makeEvent({ category: "network", title: "Tailscale relayed", dedupeKey: "ts=relay" }, T0 + 1000);
    let log = appendEvents([], [first], 100);
    expect(log).toHaveLength(1);
    const after = appendEvents(log, [same], 100);
    expect(after).toBe(log); // same reference — React can skip the render
  });

  it("records the change when the state actually flips", () => {
    let log = appendEvents([], [makeEvent({ category: "network", title: "relayed", dedupeKey: "ts=relay" }, T0)], 100);
    log = appendEvents(log, [makeEvent({ category: "network", title: "direct", dedupeKey: "ts=direct" }, T0 + 1000)], 100);
    expect(log).toHaveLength(2);
    expect(log[0].title).toBe("direct"); // newest first
  });

  it("caps the log at the retention limit", () => {
    let log: ReturnType<typeof makeEvent>[] = [];
    for (let i = 0; i < 20; i += 1) {
      log = appendEvents(log, [makeEvent({ category: "system", title: `e${i}`, dedupeKey: `k${i}` }, T0 + i)], 5);
    }
    expect(log).toHaveLength(5);
    expect(log[0].title).toBe("e19");
  });

  it("filters by category, severity and window", () => {
    const log = appendEvents(
      [],
      [
        makeEvent({ category: "network", severity: "critical", title: "loss", dedupeKey: "a" }, T0),
        makeEvent({ category: "process", severity: "info", title: "orphan", dedupeKey: "b" }, T0 - 100_000),
      ],
      50,
    );
    expect(filterEvents(log, { categories: ["network"] })).toHaveLength(1);
    expect(filterEvents(log, { minSeverity: "critical" })).toHaveLength(1);
    expect(filterEvents(log, { sinceMs: T0 - 1000 })).toHaveLength(1);
  });
});

describe("bounded history", () => {
  it("never grows past its cap", () => {
    let s: Series = EMPTY_SERIES;
    for (let i = 0; i < 500; i += 1) s = pushSample(s, i, T0 + i * 1000, 100);
    expect(s.points).toHaveLength(100);
    expect(s.points[0].value).toBe(400);
  });

  it("collapses a flat line instead of storing every identical sample", () => {
    let s = pushSample(EMPTY_SERIES, 50, T0, 100);
    s = pushSample(s, 50, T0 + 1000, 100);
    s = pushSample(s, 50, T0 + 2000, 100);
    s = pushSample(s, 50, T0 + 3000, 100);
    expect(s.points.length).toBeLessThanOrEqual(3);
    expect(s.points[s.points.length - 1].atMs).toBe(T0 + 3000);
  });

  it("ignores absent and non-finite values rather than charting zero", () => {
    const base: Series = { points: [{ atMs: T0, value: 5 }], oldestMs: T0 };
    expect(pushSample(base, null, T0 + 1, 10)).toBe(base);
    expect(pushSample(base, undefined, T0 + 1, 10)).toBe(base);
    expect(pushSample(base, NaN, T0 + 1, 10)).toBe(base);
  });

  it("returns the same store reference when nothing changed", () => {
    const store = { "CPU %": EMPTY_SERIES };
    expect(recordAll(store, { "CPU %": null }, T0, 10)).toBe(store);
  });

  it("windows and summarises", () => {
    const s: Series = { points: [{ atMs: T0, value: 1 }, { atMs: T0 + 5000, value: 9 }], oldestMs: T0 };
    expect(windowed(s, T0 + 1000)).toHaveLength(1);
    expect(seriesStats(s.points)).toEqual({ min: 1, max: 9, avg: 5, last: 9 });
    expect(seriesStats([])).toBeNull();
  });
});

function bundle(over: Partial<StatusBundle> = {}): StatusBundle {
  return {
    claude: null, codex: null, openclaw: null, system: null, gpu: null,
    thermals: null, disks: null, netq: null, ports: null, wsl: null,
    battery: null, uptime: null, tailscale: null, docker: null, ollama: null,
    winget: null, mcp: null, procs: null, repos: null, git: null, diag: null,
    custom: {}, ...over,
  };
}

describe("incident snapshots", () => {
  const withSecrets = bundle({
    system: {
      cpuPercent: 12, memUsed: 1, memTotal: 2, swapUsed: 0, swapTotal: 0,
      commitUsed: 0, commitTotal: 0, netRxBps: 0, netTxBps: 0,
      localIp: "192.168.1.44", publicIp: "203.0.113.7", queueLength: null, topProcesses: [],
    },
    procs: {
      scannedAt: "",
      processes: [{
        pid: 1, ppid: null, name: "node.exe", label: null,
        cmdSummary: "node app.js --token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
        cwd: "C:\\Users\\tommy\\secret-project", startTimeUnix: 0, memBytes: 0,
        cpuPercent: 0, killable: true, childPids: [], parentApp: null,
        orphaned: false, idleSecs: 0,
      }],
    },
  });

  it("redacts unconditionally, because a snapshot is a file", () => {
    const snap = buildSnapshot("Critical: packet loss", withSecrets, [], [], T0);
    const json = JSON.stringify(snap.data);
    expect(json).not.toContain("192.168.1.44");
    expect(json).not.toContain("203.0.113.7");
    expect(json).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345");
    expect(json).not.toContain("secret-project");
    expect(json).not.toContain("tommy");
  });

  it("records the reason and its own size", () => {
    const snap = buildSnapshot("Manual capture", withSecrets, [], [], T0);
    expect(snap.reason).toBe("Manual capture");
    expect(snap.sizeBytes).toBeGreaterThan(0);
    expect(snap.data.capturedAt).toBe(new Date(T0).toISOString());
  });

  it("caps retention by count and by total bytes", () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      buildSnapshot(`snap ${i}`, bundle(), [], [], T0 + i * 1000),
    );
    expect(pruneSnapshots(many, 5, 10_000_000)).toHaveLength(5);
    const byBytes = pruneSnapshots(many, 20, many[0].sizeBytes * 2 + 1);
    expect(byBytes.length).toBeLessThanOrEqual(3);
    expect(byBytes.length).toBeGreaterThan(0); // one snapshot is always kept
  });
});
