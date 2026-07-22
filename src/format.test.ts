import { describe, expect, it } from "vitest";
import { burnRate, fmtAgoMs, fmtSpan, projectedSpend } from "./format";

const T0 = 1_700_000_000_000;
const start = T0 / 1000 - 3600; // one hour ago

describe("burn rate", () => {
  it("is spend divided by elapsed time", () => {
    expect(burnRate(10, start, T0)).toBeCloseTo(10, 5);
    expect(burnRate(10, T0 / 1000 - 7200, T0)).toBeCloseTo(5, 5);
  });

  it("refuses to extrapolate from a few minutes", () => {
    // One request two minutes into a block is not "$60/hour".
    expect(burnRate(2, T0 / 1000 - 120, T0)).toBeNull();
    expect(burnRate(2, 0, T0)).toBeNull();
  });
});

describe("projected spend", () => {
  it("carries the observed rate to the end of the window", () => {
    // $10 in the first hour of a 5h block → $50 by reset.
    expect(projectedSpend(10, start, T0 / 1000 + 4 * 3600, T0)).toBeCloseTo(50, 5);
  });

  it("returns the actual spend once the window has closed", () => {
    expect(projectedSpend(10, start, T0 / 1000 - 60, T0)).toBe(10);
  });

  it("declines to project when the rate is not yet meaningful", () => {
    expect(projectedSpend(2, T0 / 1000 - 120, T0 / 1000 + 3600, T0)).toBeNull();
    expect(projectedSpend(10, start, 0, T0)).toBeNull();
  });
});

describe("elapsed formatting", () => {
  it("distinguishes never-measured from just-now", () => {
    expect(fmtAgoMs(null)).toBe("never");
    expect(fmtAgoMs(500)).toBe("just now");
    expect(fmtAgoMs(65_000)).toBe("1m ago");
  });

  it("treats a null end as still running", () => {
    expect(fmtSpan(T0 - 300_000, T0)).toBe("5m");
    expect(fmtSpan(T0, T0)).toBe("0s");
  });
});
