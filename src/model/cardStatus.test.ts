import { describe, expect, it } from "vitest";
import type { StatusBundle, StatusContext } from "./cardStatus";
import { deriveCardStatus, deriveCompositeItems, itemsToObservations } from "./cardStatus";
import { DEFAULT_ALERTS } from "./settings";
import { emptyProvenance } from "./provenance";

const NOW = 1_700_000_000_000;

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

function ctx(data: StatusBundle, provOver: Record<string, number> = {}): StatusContext {
  const provenance: Record<string, ReturnType<typeof emptyProvenance>> = {};
  for (const id of ["claude", "gpu", "netq", "docker", "openclaw", "thermals", "disks", "wsl", "diag"]) {
    provenance[id] = {
      ...emptyProvenance(`get_${id}`, 5_000),
      state: "ok",
      lastSuccessAt: provOver[id] ?? NOW - 1_000,
      successCount: 1,
    };
  }
  return { data, provenance, rules: DEFAULT_ALERTS, nowMs: NOW };
}

describe("availability reasons", () => {
  it("explains why an auto card is hidden", () => {
    const s = deriveCardStatus("gpu", ctx(bundle({
      gpu: { available: false, error: null, driver: null, gpus: [], processes: [] },
    })));
    expect(s.availability).toBe(false);
    expect(s.availabilityReason).toMatch(/no supported NVIDIA adapter/i);
    expect(s.health).toBe("unavailable");
  });

  it("explains why an auto card is shown", () => {
    const s = deriveCardStatus("gpu", ctx(bundle({
      gpu: { available: true, error: null, driver: "560.94", gpus: [], processes: [] },
    })));
    expect(s.availability).toBe(true);
    expect(s.availabilityReason).toContain("560.94");
  });

  it("names the detected telemetry tier for thermals", () => {
    const lhm = deriveCardStatus("thermals", ctx(bundle({
      thermals: { tier: "lhm", cpuPackageC: 50, cpuMaxCoreC: 55, zoneC: null, fansRpm: [], sensorCount: 42, throttling: false },
    })));
    expect(lhm.availabilityReason).toMatch(/LibreHardwareMonitor/);
    expect(lhm.health).toBe("healthy");

    const none = deriveCardStatus("thermals", ctx(bundle({
      thermals: { tier: "none", cpuPackageC: null, cpuMaxCoreC: null, zoneC: null, fansRpm: [], sensorCount: 0, throttling: null },
    })));
    expect(none.health).toBe("unavailable");
    expect(none.statusDetail).toMatch(/Needs LibreHardwareMonitor/i);
  });
});

describe("freshness semantics per source", () => {
  it("marks Claude rate windows estimated when the provider did not answer", () => {
    const s = deriveCardStatus("claude", ctx(bundle({
      claude: {
        available: true, plan: "max", windows: [], todayTokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
        todayCostUsd: 0, weekTokensTotal: 0, weekCostUsd: 0, blockTokensTotal: 0, blockCostUsd: 0,
        blockStartedUnix: 0, blockEndsUnix: 0, modelsToday: [], hourly: [], activeSessions: [],
        projectsToday: [], windowsLive: false, providerError: "429 rate limited",
      },
    })));
    expect(s.freshness).toBe("estimated");
    expect(s.health).toBe("degraded");
    expect(s.statusDetail).toContain("429");
  });

  it("marks a six-hourly winget check cached, not stale", () => {
    const provenance = { winget: { ...emptyProvenance("get_winget_status", 21_600_000), state: "ok" as const, lastSuccessAt: NOW - 60_000, successCount: 1 } };
    const s = deriveCardStatus("winget", {
      data: bundle({ winget: { installed: true, updates: [], error: null, checkedUnix: 0 } }),
      provenance, rules: DEFAULT_ALERTS, nowMs: NOW,
    });
    expect(s.freshness).toBe("cached");
  });

  it("says speedtest was never measured rather than implying zero", () => {
    const s = deriveCardStatus("speedtest", ctx(bundle()));
    expect(s.freshness).toBe("not_measured");
    expect(s.statusDetail).toMatch(/On-demand|Run manually/i);
  });
});

describe("conditions drive alerts, including while normal", () => {
  it("emits a normal condition so hysteresis has something to observe", () => {
    const s = deriveCardStatus("netq", ctx(bundle({
      netq: {
        mode: "icmp", latencyMs: 12, avgMs: 12, jitterMs: 1, lossPercent: 0,
        samples: [], wifiSsid: null, wifiSignal: null, linkMbps: null,
        dnsMs: null, interfaceName: "Wi-Fi", linkType: "wifi",
      },
    })));
    expect(s.attention).toBe("normal");
    expect(s.attentionItems).toHaveLength(0);
    const loss = s.conditions.find((c) => c.ruleId === "packetLoss");
    expect(loss).toBeTruthy();
    expect(loss?.severity).toBe("normal");
    expect(loss?.recovered).toBe(true);
  });

  it("escalates packet loss to warning then critical", () => {
    const at = (loss: number) =>
      deriveCardStatus("netq", ctx(bundle({
        netq: {
          mode: "icmp", latencyMs: 20, avgMs: 20, jitterMs: 2, lossPercent: loss,
          samples: [], wifiSsid: null, wifiSignal: null, linkMbps: null,
          dnsMs: null, interfaceName: null, linkType: null,
        },
      })));
    expect(at(1).attention).toBe("normal");
    expect(at(7).attention).toBe("warning");
    expect(at(20).attention).toBe("critical");
    // The dead-band: below the 5% warn threshold but above the 2% recover-at.
    const band = at(3).conditions.find((c) => c.ruleId === "packetLoss");
    expect(band?.severity).toBe("normal");
    expect(band?.recovered).toBe(false);
  });

  it("carries the rule's dwell, hysteresis and cooldown into the observation", () => {
    const s = deriveCardStatus("netq", ctx(bundle({
      netq: {
        mode: "icmp", latencyMs: 20, avgMs: 20, jitterMs: 2, lossPercent: 8,
        samples: [], wifiSsid: null, wifiSignal: null, linkMbps: null,
        dnsMs: null, interfaceName: null, linkType: null,
      },
    })));
    const [o] = itemsToObservations(s.attentionItems);
    expect(o.sustainSecs).toBe(DEFAULT_ALERTS.packetLoss.sustainSecs);
    expect(o.recoverSecs).toBe(DEFAULT_ALERTS.packetLoss.recoverSecs);
    expect(o.cooldownSecs).toBe(DEFAULT_ALERTS.packetLoss.cooldownSecs);
    expect(o.cardId).toBe("netq");
  });

  it("treats a container with no healthcheck as unevaluable, not unhealthy", () => {
    const s = deriveCardStatus("docker", ctx(bundle({
      docker: {
        installed: true, daemonUp: true, error: null,
        containers: [{
          id: "abc", name: "db", image: "postgres:17", state: "running", status: "Up 2h",
          ports: null, portList: [], health: null, restartCount: 0, createdUnix: 0,
          cpuPercent: null, memBytes: null, memLimitBytes: null, netRxBytes: null,
          netTxBytes: null, blockReadBytes: null, blockWriteBytes: null,
        }],
      },
    })));
    expect(s.health).toBe("healthy");
    expect(s.conditions).toHaveLength(0);
  });

  it("distinguishes docker not installed from the daemon being down", () => {
    const missing = deriveCardStatus("docker", ctx(bundle({
      docker: { installed: false, daemonUp: false, containers: [], error: null },
    })));
    expect(missing.availability).toBe(false);
    expect(missing.availabilityReason).toMatch(/not found on PATH/);

    const down = deriveCardStatus("docker", ctx(bundle({
      docker: { installed: true, daemonUp: false, containers: [], error: "daemon not running" },
    })));
    expect(down.availability).toBe(true);
    expect(down.health).toBe("unavailable");
    expect(down.activity).toBe("stopped");
  });
});

describe("self-diagnostics", () => {
  it("still reports failing collectors when its own probe is the one that failed", () => {
    const provenance = {
      procs: {
        ...emptyProvenance("get_processes", 3_000),
        state: "error" as const,
        consecutiveFailures: 5,
        failureCount: 5,
      },
      diag: {
        ...emptyProvenance("get_self_diagnostics", 10_000),
        state: "error" as const,
        consecutiveFailures: 4,
        failureCount: 4,
      },
    };
    const s = deriveCardStatus("diag", {
      data: bundle(), // no diag payload — the probe itself is down
      provenance,
      rules: DEFAULT_ALERTS,
      nowMs: NOW,
    });
    const condition = s.conditions.find((c) => c.ruleId === "collectorStale");
    expect(condition?.severity).toBe("warning");
    expect(condition?.title).toContain("2 collector");
    expect(condition?.recovered).toBe(false);
  });

  it("reports recovery once every collector is answering again", () => {
    const provenance = {
      procs: { ...emptyProvenance("get_processes", 3_000), state: "ok" as const, lastSuccessAt: NOW },
    };
    const s = deriveCardStatus("diag", {
      data: bundle(), provenance, rules: DEFAULT_ALERTS, nowMs: NOW,
    });
    const condition = s.conditions.find((c) => c.ruleId === "collectorStale");
    expect(condition?.severity).toBe("normal");
    expect(condition?.recovered).toBe(true);
  });
});

describe("composite rules", () => {
  it("fires only when both halves are true", () => {
    const netqBad = bundle({
      netq: {
        mode: "icmp", latencyMs: 20, avgMs: 20, jitterMs: 2, lossPercent: 9,
        samples: [], wifiSsid: null, wifiSignal: null, linkMbps: null,
        dnsMs: null, interfaceName: null, linkType: null,
      },
    });
    const context = ctx(netqBad);
    const onlyNet = { netq: deriveCardStatus("netq", context) };
    expect(deriveCompositeItems(onlyNet, context)).toHaveLength(0);

    const both = bundle({
      ...netqBad,
      openclaw: {
        installed: true, port: 18789, reachable: false, httpStatus: null, latencyMs: null,
        pid: null, uptimeSecs: null, memBytes: null, cpuPercent: null, processCount: 0,
        requestsPerMin: null, activeRequests: null, queuedRequests: null, errorRate: null,
        p50Ms: null, p95Ms: null, p99Ms: null, connectedClients: null, lastError: null, version: null,
      },
    });
    const c2 = ctx(both);
    const statuses = {
      netq: deriveCardStatus("netq", c2),
      openclaw: deriveCardStatus("openclaw", c2),
    };
    const composites = deriveCompositeItems(statuses, c2);
    expect(composites).toHaveLength(1);
    expect(composites[0].severity).toBe("critical");
  });
});
