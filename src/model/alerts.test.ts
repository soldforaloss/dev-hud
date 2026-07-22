import { describe, expect, it } from "vitest";
import type { AlertRecord, Observation } from "./alerts";
import {
  acknowledgeAlert,
  rankAlerts,
  evaluateAlerts,
  inQuietHours,
  openAlerts,
  pruneAlerts,
  snoozeAlert,
} from "./alerts";

const T0 = 1_700_000_000_000;

function obs(over: Partial<Observation> = {}): Observation {
  return {
    key: "packet-loss",
    ruleId: "packetLoss",
    cardId: "netq",
    title: "Network packet loss",
    message: "loss is high",
    severity: "warning",
    recovered: false,
    sustainSecs: 90,
    recoverSecs: 60,
    cooldownSecs: 900,
    ...over,
  };
}

function opts(nowMs: number, over: Partial<Parameters<typeof evaluateAlerts>[2]> = {}) {
  return {
    nowMs,
    master: true,
    quietHours: { on: false, startHour: 23, endHour: 7 },
    localHour: 12,
    ...over,
  };
}

describe("sustained duration", () => {
  it("does not fire until the condition has held for sustainSecs", () => {
    let state: AlertRecord[] = [];
    let r = evaluateAlerts(state, [obs()], opts(T0));
    state = r.alerts;
    expect(r.notify).toHaveLength(0);
    expect(openAlerts(state)).toHaveLength(0); // pending, not yet armed

    r = evaluateAlerts(state, [obs()], opts(T0 + 60_000));
    state = r.alerts;
    expect(r.notify).toHaveLength(0);

    r = evaluateAlerts(state, [obs()], opts(T0 + 90_000));
    state = r.alerts;
    expect(r.notify).toHaveLength(1);
    expect(openAlerts(state)).toHaveLength(1);
    expect(state[0].severity).toBe("warning");
  });

  it("fires immediately when sustainSecs is zero", () => {
    const r = evaluateAlerts([], [obs({ sustainSecs: 0 })], opts(T0));
    expect(r.notify).toHaveLength(1);
    expect(openAlerts(r.alerts)).toHaveLength(1);
  });

  it("restarts the dwell clock when the condition clears before arming", () => {
    let state = evaluateAlerts([], [obs()], opts(T0)).alerts;
    // Back to normal AND inside the recovery band before it ever armed.
    state = evaluateAlerts(
      state,
      [obs({ severity: "normal", recovered: true })],
      opts(T0 + 30_000),
    ).alerts;
    state = evaluateAlerts(
      state,
      [obs({ severity: "normal", recovered: true })],
      opts(T0 + 120_000),
    ).alerts;
    expect(state[0].state).toBe("recovered");
    const r = evaluateAlerts(state, [obs()], opts(T0 + 130_000));
    expect(r.notify).toHaveLength(0); // new episode, dwell starts over
  });
});

describe("hysteresis and recovery", () => {
  it("stays open in the dead-band between the warning and recovery thresholds", () => {
    let state = evaluateAlerts([], [obs({ sustainSecs: 0 })], opts(T0)).alerts;
    // Below the warning threshold but not yet inside the recovery band.
    const r = evaluateAlerts(
      state,
      [obs({ sustainSecs: 0, severity: "normal", recovered: false })],
      opts(T0 + 600_000),
    );
    state = r.alerts;
    expect(state[0].state).toBe("active");
    expect(state[0].recoveringSinceMs).toBeUndefined();
  });

  it("recovers only after the value holds inside the band for recoverSecs", () => {
    let state = evaluateAlerts([], [obs({ sustainSecs: 0 })], opts(T0)).alerts;
    const clear = obs({ sustainSecs: 0, severity: "normal", recovered: true });

    state = evaluateAlerts(state, [clear], opts(T0 + 10_000)).alerts;
    expect(state[0].state).toBe("active");

    state = evaluateAlerts(state, [clear], opts(T0 + 40_000)).alerts;
    expect(state[0].state).toBe("active");

    const r = evaluateAlerts(state, [clear], opts(T0 + 80_000));
    expect(r.alerts[0].state).toBe("recovered");
    expect(r.alerts[0].recoveredAt).toBeTruthy();
    expect(r.notify).toHaveLength(1); // "it's fixed" is worth delivering
    expect(r.events.some((e) => e.title.includes("recovered"))).toBe(true);
  });

  it("resets the recovery clock if the value bounces back out of the band", () => {
    let state = evaluateAlerts([], [obs({ sustainSecs: 0 })], opts(T0)).alerts;
    const clear = obs({ sustainSecs: 0, severity: "normal", recovered: true });
    state = evaluateAlerts(state, [clear], opts(T0 + 10_000)).alerts;
    state = evaluateAlerts(state, [obs({ sustainSecs: 0 })], opts(T0 + 20_000)).alerts;
    expect(state[0].recoveringSinceMs).toBeUndefined();
    state = evaluateAlerts(state, [clear], opts(T0 + 30_000)).alerts;
    expect(state[0].state).toBe("active"); // clock started again at +30s
  });
});

describe("cooldown and escalation", () => {
  it("suppresses re-notification inside the cooldown", () => {
    let state = evaluateAlerts([], [obs({ sustainSecs: 0 })], opts(T0)).alerts;
    let r = evaluateAlerts(state, [obs({ sustainSecs: 0 })], opts(T0 + 60_000));
    state = r.alerts;
    expect(r.notify).toHaveLength(0);
    r = evaluateAlerts(state, [obs({ sustainSecs: 0 })], opts(T0 + 901_000));
    expect(r.notify).toHaveLength(1);
  });

  it("breaks the cooldown when severity increases", () => {
    let state = evaluateAlerts([], [obs({ sustainSecs: 0 })], opts(T0)).alerts;
    const r = evaluateAlerts(
      state,
      [obs({ sustainSecs: 0, severity: "critical" })],
      opts(T0 + 5_000),
    );
    expect(r.notify).toHaveLength(1);
    expect(r.alerts[0].severity).toBe("critical");
  });

  it("re-notifies an acknowledged alert only when it gets worse", () => {
    let state = evaluateAlerts([], [obs({ sustainSecs: 0 })], opts(T0)).alerts;
    state = acknowledgeAlert(state, state[0].id, T0 + 1_000);
    let r = evaluateAlerts(state, [obs({ sustainSecs: 0 })], opts(T0 + 2_000_000));
    state = r.alerts;
    expect(r.notify).toHaveLength(0);
    expect(state[0].state).toBe("acknowledged");

    r = evaluateAlerts(state, [obs({ sustainSecs: 0, severity: "critical" })], opts(T0 + 2_001_000));
    expect(r.notify).toHaveLength(1);
    expect(r.alerts[0].state).toBe("active");
  });
});

describe("snooze", () => {
  it("holds notifications until the snooze expires", () => {
    let state = evaluateAlerts([], [obs({ sustainSecs: 0 })], opts(T0)).alerts;
    state = snoozeAlert(state, state[0].id, 30, T0);
    let r = evaluateAlerts(state, [obs({ sustainSecs: 0 })], opts(T0 + 1_000_000));
    state = r.alerts;
    expect(state[0].state).toBe("snoozed");
    expect(r.notify).toHaveLength(0);

    r = evaluateAlerts(state, [obs({ sustainSecs: 0 })], opts(T0 + 1_900_000));
    expect(r.alerts[0].state).toBe("active");
  });
});

describe("deduplication", () => {
  it("keeps one record per instance key", () => {
    const two = [
      obs({ key: "disk-free:C:", sustainSecs: 0 }),
      obs({ key: "disk-free:D:", sustainSecs: 0 }),
    ];
    const r = evaluateAlerts([], two, opts(T0));
    expect(r.alerts).toHaveLength(2);
    const again = evaluateAlerts(r.alerts, two, opts(T0 + 1_000));
    expect(again.alerts).toHaveLength(2);
  });

  it("closes an alert whose source stopped reporting entirely", () => {
    const state = evaluateAlerts([], [obs({ sustainSecs: 0 })], opts(T0)).alerts;
    const stillThere = evaluateAlerts(state, [], opts(T0 + 60_000));
    expect(stillThere.alerts[0].state).toBe("active");
    const gone = evaluateAlerts(state, [], opts(T0 + 700_000));
    expect(gone.alerts[0].state).toBe("recovered");
  });
});

describe("quiet hours", () => {
  it("wraps across midnight", () => {
    const q = { on: true, startHour: 23, endHour: 7 };
    expect(inQuietHours(23, q)).toBe(true);
    expect(inQuietHours(3, q)).toBe(true);
    expect(inQuietHours(12, q)).toBe(false);
    expect(inQuietHours(3, { ...q, on: false })).toBe(false);
  });

  it("holds warnings but lets criticals through", () => {
    const quiet = { on: true, startHour: 23, endHour: 7 };
    const warn = evaluateAlerts([], [obs({ sustainSecs: 0 })], opts(T0, { quietHours: quiet, localHour: 2 }));
    expect(warn.notify).toHaveLength(0);
    expect(warn.events).toHaveLength(1); // still recorded, just not shouted

    const crit = evaluateAlerts(
      [],
      [obs({ sustainSecs: 0, severity: "critical", key: "other" })],
      opts(T0, { quietHours: quiet, localHour: 2 }),
    );
    expect(crit.notify).toHaveLength(1);
  });

  it("delivers nothing at all when the master switch is off", () => {
    const r = evaluateAlerts([], [obs({ sustainSecs: 0 })], opts(T0, { master: false }));
    expect(r.notify).toHaveLength(0);
    expect(r.alerts).toHaveLength(1); // still recorded in the alert center
  });
});

describe("retention", () => {
  it("drops recovered alerts before open ones", () => {
    const mk = (id: string, state: AlertRecord["state"]): AlertRecord => ({
      id, ruleId: "r", cardId: "c", key: id, severity: "warning", state,
      title: id, message: "", firstSeenAt: new Date(T0).toISOString(),
      lastSeenAt: new Date(T0).toISOString(), relatedEntities: [], armed: true,
    });
    const list = [mk("a", "recovered"), mk("b", "active"), mk("c", "recovered")];
    const pruned = pruneAlerts(list, 2);
    expect(pruned).toHaveLength(2);
    expect(pruned.some((a) => a.id === "b")).toBe(true);
  });
});

describe("ranking for the alert center", () => {
  const at = (id: string, over: Partial<AlertRecord>): AlertRecord => ({
    id, ruleId: "r", cardId: "c", key: id, severity: "warning", state: "active",
    title: id, message: "", firstSeenAt: new Date(T0).toISOString(),
    lastSeenAt: new Date(T0).toISOString(), relatedEntities: [], armed: true,
    ...over,
  });

  it("puts criticals first, then the longest-running", () => {
    const ranked = rankAlerts([
      at("warn-new", { firstSeenAt: new Date(T0).toISOString() }),
      at("warn-old", { firstSeenAt: new Date(T0 - 3_600_000).toISOString() }),
      at("crit", { severity: "critical" }),
    ]);
    expect(ranked.map((a) => a.id)).toEqual(["crit", "warn-old", "warn-new"]);
  });

  it("sinks acknowledged and snoozed below active of the same severity", () => {
    const ranked = rankAlerts([
      at("acked", { state: "acknowledged" }),
      at("active", {}),
      at("snoozed", { state: "snoozed" }),
    ]);
    expect(ranked.map((a) => a.id)).toEqual(["active", "acked", "snoozed"]);
  });
});
