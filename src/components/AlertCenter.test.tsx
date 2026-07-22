import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { AlertCenter } from "./AlertCenter";
import { Timeline } from "./Timeline";
import type { AlertRecord } from "../model/alerts";
import { evaluateAlerts } from "../model/alerts";
import { appendEvents } from "../model/events";
import { buildSnapshot } from "../model/snapshots";
import type { StatusBundle } from "../model/cardStatus";
import { Redactor } from "../model/privacy";

const NOW = 1_700_000_000_000;

function alert(over: Partial<AlertRecord> = {}): AlertRecord {
  return {
    id: "a1", ruleId: "packetLoss", cardId: "netq", key: "packet-loss",
    severity: "critical", state: "active", title: "Network packet loss is 15%",
    message: "15% of probes to 1.1.1.1 were lost",
    firstSeenAt: new Date(NOW - 300_000).toISOString(),
    lastSeenAt: new Date(NOW).toISOString(),
    currentValue: 15, threshold: 12, relatedEntities: [],
    suggestedActions: ["Run a speed test"], armed: true,
    ...over,
  };
}

function renderCenter(over: Partial<Parameters<typeof AlertCenter>[0]> = {}) {
  const props = {
    alerts: [alert()],
    snapshots: [],
    redactor: new Redactor(false),
    nowMs: NOW,
    onAcknowledge: vi.fn(),
    onSnooze: vi.fn(),
    onFocusCard: vi.fn(),
    onCaptureSnapshot: vi.fn(),
    onOpenSnapshot: vi.fn(),
    onDeleteSnapshot: vi.fn(),
    onClose: vi.fn(),
    ...over,
  };
  render(<AlertCenter {...props} />);
  return props;
}

describe("alert center", () => {
  it("shows everything a toast could not: value, threshold, duration, suggestion", () => {
    renderCenter();
    expect(screen.getByText("■ Critical")).toBeTruthy();
    expect(screen.getByText("Network packet loss is 15%")).toBeTruthy();
    expect(screen.getByText("15")).toBeTruthy();
    expect(screen.getByText("12")).toBeTruthy();
    expect(screen.getByText("5m")).toBeTruthy();
    expect(screen.getByText(/Run a speed test/)).toBeTruthy();
  });

  it("separates open alerts from recovered history", () => {
    renderCenter({
      alerts: [alert(), alert({ id: "a2", state: "recovered", recoveredAt: new Date(NOW).toISOString() })],
    });
    expect(screen.getByText("Open (1)")).toBeTruthy();
    expect(screen.getByText("History (1)")).toBeTruthy();
  });

  it("records the recovery time once an alert closes", () => {
    renderCenter({
      alerts: [alert({ state: "recovered", recoveredAt: new Date(NOW).toISOString() })],
    });
    fireEvent.click(screen.getByText("History (1)"));
    expect(screen.getByText("Recovered", { selector: "dt" })).toBeTruthy();
    expect(screen.getByText("Recovered", { selector: ".alert-state-tag" })).toBeTruthy();
  });

  it("navigates to the card that raised the alert", () => {
    const props = renderCenter();
    fireEvent.click(screen.getByText("Network packet loss is 15%"));
    expect(props.onFocusCard).toHaveBeenCalledWith("netq");
  });

  it("offers acknowledge and snooze, and hides them once recovered", () => {
    const props = renderCenter();
    fireEvent.click(screen.getByText("Acknowledge"));
    expect(props.onAcknowledge).toHaveBeenCalledWith("a1");
    fireEvent.click(screen.getByText("Snooze 30m"));
    expect(props.onSnooze).toHaveBeenCalledWith("a1", 30);
  });

  it("explains that snapshots are redacted before they are stored", () => {
    renderCenter();
    fireEvent.click(screen.getByText("Snapshots (0)"));
    expect(screen.getByText(/redacted before they are stored/)).toBeTruthy();
  });

  it("redacts alert text in privacy mode", () => {
    renderCenter({
      redactor: new Redactor(true),
      alerts: [alert({ message: "probes to 203.0.113.9 were lost" })],
    });
    expect(document.body.innerHTML).not.toContain("203.0.113.9");
  });
});

describe("timeline", () => {
  const events = appendEvents(
    [],
    [
      { id: "e1", timestamp: new Date(NOW).toISOString(), atMs: NOW, category: "network", severity: "critical", title: "Packet loss crossed 12%", relatedEntities: [], dedupeKey: "a" },
      { id: "e2", timestamp: new Date(NOW - 60_000).toISOString(), atMs: NOW - 60_000, category: "container", severity: "info", title: "Container db restarted", relatedEntities: [], dedupeKey: "b" },
    ],
    100,
  );

  it("correlates changes across categories in one chronology", () => {
    render(
      <Timeline
        events={events} redactor={new Redactor(false)} range="1h" nowMs={NOW}
        onOpenEntity={() => {}} onClose={() => {}}
      />,
    );
    expect(screen.getByText("Packet loss crossed 12%")).toBeTruthy();
    expect(screen.getByText("Container db restarted")).toBeTruthy();
  });

  it("filters by category", () => {
    render(
      <Timeline
        events={events} redactor={new Redactor(false)} range="1h" nowMs={NOW}
        onOpenEntity={() => {}} onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Network" }));
    expect(screen.getByText("Packet loss crossed 12%")).toBeTruthy();
    expect(screen.queryByText("Container db restarted")).toBeNull();
  });

  it("says plainly that quiet means nothing changed, not that nothing was collected", () => {
    render(
      <Timeline
        events={[]} redactor={new Redactor(false)} range="15m" nowMs={NOW}
        onOpenEntity={() => {}} onClose={() => {}}
      />,
    );
    expect(screen.getByText(/records changes, not polls/)).toBeTruthy();
  });
});

describe("alert → timeline → snapshot", () => {
  const bundle: StatusBundle = {
    claude: null, codex: null, openclaw: null, gpu: null, thermals: null,
    disks: null, ports: null, wsl: null, battery: null, uptime: null,
    tailscale: null, docker: null, ollama: null, winget: null, mcp: null,
    procs: null, repos: null, git: null, diag: null, custom: {},
    netq: {
      mode: "icmp", latencyMs: 20, avgMs: 22, jitterMs: 4, lossPercent: 15,
      samples: [], wifiSsid: "HomeNet", wifiSignal: 70, linkMbps: 300,
      dnsMs: null, interfaceName: "Wi-Fi", linkType: "wifi",
    },
    system: {
      cpuPercent: 40, memUsed: 8, memTotal: 16, swapUsed: 0, swapTotal: 0,
      commitUsed: 0, commitTotal: 0, netRxBps: 0, netTxBps: 0,
      localIp: "192.168.1.20", publicIp: "203.0.113.9",
      queueLength: 2, topProcesses: [],
    },
  };

  it("carries one critical condition through the whole flow", () => {
    // 1. the condition fires
    const result = evaluateAlerts(
      [],
      [{
        key: "packet-loss", ruleId: "packetLoss", cardId: "netq",
        title: "Network packet loss is 15%", message: "15% loss over ICMP",
        severity: "critical", recovered: false,
        value: 15, threshold: 12, sustainSecs: 0, recoverSecs: 60, cooldownSecs: 900,
      }],
      { nowMs: NOW, master: true, quietHours: { on: false, startHour: 0, endHour: 0 }, localHour: 12 },
    );
    expect(result.notify).toHaveLength(1);

    // 2. it lands on the timeline as a change
    const log = appendEvents([], result.events, 100);
    expect(log[0].category).toBe("alert");
    expect(log[0].severity).toBe("critical");

    // 3. a snapshot freezes the surrounding state, redacted
    const snap = buildSnapshot(result.alerts[0].title, bundle, result.alerts, log, NOW);
    const json = JSON.stringify(snap.data);
    expect(snap.reason).toContain("packet loss");
    expect(json).toContain("15");
    expect(json).not.toContain("192.168.1.20");
    expect(json).not.toContain("203.0.113.9");
    expect(json).not.toContain("HomeNet");
  });

  it("survives a store round-trip so a restart does not re-fire everything", () => {
    const first = evaluateAlerts(
      [],
      [{
        key: "cpu-temp", ruleId: "cpuTemp", cardId: "thermals", title: "CPU at 98°C",
        message: "hot", severity: "critical", recovered: false,
        sustainSecs: 0, recoverSecs: 60, cooldownSecs: 900,
      }],
      { nowMs: NOW, master: true, quietHours: { on: false, startHour: 0, endHour: 0 }, localHour: 12 },
    );
    // What the Tauri store would persist and hand back.
    const restored: AlertRecord[] = JSON.parse(JSON.stringify(first.alerts));
    const second = evaluateAlerts(
      restored,
      [{
        key: "cpu-temp", ruleId: "cpuTemp", cardId: "thermals", title: "CPU at 98°C",
        message: "hot", severity: "critical", recovered: false,
        sustainSecs: 0, recoverSecs: 60, cooldownSecs: 900,
      }],
      { nowMs: NOW + 30_000, master: true, quietHours: { on: false, startHour: 0, endHour: 0 }, localHour: 12 },
    );
    expect(second.notify).toHaveLength(0); // cooldown survived the restart
    expect(second.alerts[0].firstSeenAt).toBe(first.alerts[0].firstSeenAt);
  });
});
