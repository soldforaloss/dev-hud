import { describe, expect, it } from "vitest";
import {
  attentionFromThresholds,
  freshnessFromAge,
  metric,
  staleThreshold,
  worstAttention,
  worstFreshness,
  worstHealth,
} from "./status";
import {
  collectorHealth,
  dataAgeMs,
  emptyProvenance,
  provenanceFreshness,
} from "./provenance";

describe("status aggregation", () => {
  it("ranks unavailable above degraded above unknown above healthy", () => {
    expect(worstHealth(["healthy", "unknown"])).toBe("unknown");
    expect(worstHealth(["healthy", "unknown", "degraded"])).toBe("degraded");
    expect(worstHealth(["degraded", "unavailable"])).toBe("unavailable");
    expect(worstHealth([])).toBe("healthy");
  });

  it("ranks critical above warning above normal", () => {
    expect(worstAttention(["normal", "warning"])).toBe("warning");
    expect(worstAttention(["warning", "critical"])).toBe("critical");
    expect(worstAttention([])).toBe("normal");
  });

  it("treats not_measured as the least trustworthy freshness", () => {
    expect(worstFreshness(["live", "cached"])).toBe("cached");
    expect(worstFreshness(["live", "stale", "estimated"])).toBe("stale");
    expect(worstFreshness(["stale", "not_measured"])).toBe("not_measured");
  });
});

describe("threshold evaluation", () => {
  it("escalates warning to critical as the value rises", () => {
    expect(attentionFromThresholds(70, 80, 90)).toBe("normal");
    expect(attentionFromThresholds(80, 80, 90)).toBe("warning");
    expect(attentionFromThresholds(95, 80, 90)).toBe("critical");
  });

  it("inverts for metrics where lower is worse", () => {
    expect(attentionFromThresholds(20, 10, 5, false)).toBe("normal");
    expect(attentionFromThresholds(10, 10, 5, false)).toBe("warning");
    expect(attentionFromThresholds(4, 10, 5, false)).toBe("critical");
  });

  it("never reports attention for a value that was not measured", () => {
    expect(attentionFromThresholds(null, 10, 5)).toBe("normal");
    expect(attentionFromThresholds(undefined, 10, 5)).toBe("normal");
  });
});

describe("freshness", () => {
  it("distinguishes never-measured from stale", () => {
    expect(freshnessFromAge(null, 1000)).toBe("not_measured");
    expect(freshnessFromAge(500, 1000)).toBe("live");
    expect(freshnessFromAge(1500, 1000)).toBe("stale");
  });

  it("gives a fast collector three missed cycles before calling it stale", () => {
    expect(staleThreshold(3_000)).toBe(15_000);
    expect(staleThreshold(60_000)).toBe(180_000);
  });
});

describe("metric envelopes", () => {
  it("defaults a present value to healthy and live", () => {
    const m = metric(42, { source: "test" });
    expect(m.value).toBe(42);
    expect(m.health).toBe("healthy");
    expect(m.freshness).toBe("live");
  });

  it("does not claim health for an absent value", () => {
    const m = metric(null, { source: "test" });
    expect(m.value).toBeNull();
    expect(m.health).toBe("unknown");
    expect(m.freshness).toBe("not_measured");
  });

  it("keeps a legitimate zero distinct from an absent value", () => {
    expect(metric(0, { source: "t" }).value).toBe(0);
    expect(metric(0, { source: "t" }).freshness).toBe("live");
  });
});

describe("collector provenance", () => {
  const base = emptyProvenance("get_x", 5_000, "X collector", "X installed");

  it("reports not_measured before the first success, not stale", () => {
    expect(provenanceFreshness(base, 1_000_000)).toBe("not_measured");
    expect(collectorHealth(base)).toBe("unknown");
  });

  it("distinguishes a disabled collector from a broken one", () => {
    const disabled = { ...base, state: "disabled" as const, lastSuccessAt: 1 };
    expect(provenanceFreshness(disabled, 10_000_000)).toBe("not_measured");
    expect(collectorHealth(disabled)).toBe("unknown");
  });

  it("degrades on one failure and goes unavailable after three", () => {
    expect(collectorHealth({ ...base, lastSuccessAt: 1, consecutiveFailures: 1 })).toBe("degraded");
    expect(collectorHealth({ ...base, lastSuccessAt: 1, consecutiveFailures: 3 })).toBe("unavailable");
  });

  it("goes stale once data outlives three poll cycles", () => {
    const p = { ...base, state: "ok" as const, lastSuccessAt: 100_000 };
    expect(provenanceFreshness(p, 100_000 + 10_000)).toBe("live");
    expect(provenanceFreshness(p, 100_000 + 20_000)).toBe("stale");
    expect(dataAgeMs(p, 100_000 + 20_000)).toBe(20_000);
  });
});
