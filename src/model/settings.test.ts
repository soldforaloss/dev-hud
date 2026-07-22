import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  SETTINGS_VERSION,
  applyProfile,
  captureProfile,
  migrateSettings,
} from "./settings";

describe("settings migration", () => {
  it("falls back to defaults for junk rather than throwing", () => {
    expect(migrateSettings(null).schemaVersion).toBe(SETTINGS_VERSION);
    expect(migrateSettings("nonsense").layering).toBe("desktop");
    expect(migrateSettings(42).alerts.master).toBe(true);
  });

  it("preserves a v1 layout verbatim", () => {
    const v1 = {
      layering: "top",
      locked: true,
      background: "solid",
      bgOpacity: 80,
      order: ["procs", "claude"],
      sizes: { procs: { span: 2, height: 340 } },
      collapsed: { codex: true },
      seenReleases: { "acme/tool": "v1.2.3" },
      utilities: { gpu: "off" },
      lhmPort: 9000,
      pingHost: "8.8.8.8",
    };
    const out = migrateSettings(v1);
    expect(out.layering).toBe("top");
    expect(out.locked).toBe(true);
    expect(out.background).toBe("solid");
    expect(out.bgOpacity).toBe(80);
    expect(out.order).toEqual(["procs", "claude"]);
    expect(out.sizes.procs).toEqual({ span: 2, height: 340 });
    expect(out.collapsed.codex).toBe(true);
    expect(out.seenReleases["acme/tool"]).toBe("v1.2.3");
    expect(out.utilities.gpu).toBe("off");
    expect(out.lhmPort).toBe(9000);
    expect(out.pingHost).toBe("8.8.8.8");
  });

  it("absorbs the pre-tri-state `enabled` map into `utilities`", () => {
    const out = migrateSettings({ enabled: { gpu: false, docker: true } });
    expect(out.utilities.gpu).toBe("off");
    expect(out.utilities.docker).toBeUndefined(); // true meant "auto", not "on"
    expect("enabled" in out).toBe(false);
  });

  it("does not override an explicit tri-state with the legacy boolean", () => {
    const out = migrateSettings({ enabled: { gpu: false }, utilities: { gpu: "on" } });
    expect(out.utilities.gpu).toBe("on");
  });

  it("expands a v1 single-threshold alert into warning + critical tiers", () => {
    const out = migrateSettings({
      alerts: { master: true, gpuTemp: { on: true, threshold: 85 }, ram: { on: false, threshold: 90 } },
    });
    expect(out.alerts.gpuTemp.on).toBe(true);
    expect(out.alerts.gpuTemp.critical).toBe(85);
    expect(out.alerts.gpuTemp.warn).toBeLessThan(85);
    expect(out.alerts.gpuTemp.recoverAt).toBeLessThan(out.alerts.gpuTemp.warn);
    expect(out.alerts.ram.on).toBe(false);
  });

  it("keeps the inverted comparison for free-disk-space rules", () => {
    const out = migrateSettings({ alerts: { diskFree: { on: true, threshold: 8 } } });
    expect(out.alerts.diskFree.higherIsWorse).toBe(false);
    expect(out.alerts.diskFree.critical).toBe(8);
    // Lower is worse, so the warning tier sits *above* the critical one.
    expect(out.alerts.diskFree.warn).toBeGreaterThan(8);
    expect(out.alerts.diskFree.recoverAt).toBeGreaterThan(out.alerts.diskFree.warn);
  });

  it("keeps an already-migrated v2+ rule untouched", () => {
    const rule = {
      on: true, warn: 70, critical: 75, sustainSecs: 5,
      recoverAt: 60, recoverSecs: 10, cooldownSecs: 60, higherIsWorse: true,
    };
    const out = migrateSettings({ schemaVersion: 2, alerts: { gpuTemp: rule } });
    expect(out.alerts.gpuTemp).toEqual(rule);
  });

  it("fills every field added after the stored version", () => {
    const out = migrateSettings({ layering: "normal" });
    expect(out.privacy).toBe(false);
    expect(out.retention.events).toBe(DEFAULT_SETTINGS.retention.events);
    expect(out.pollIntervals).toEqual({});
    expect(out.customCards).toEqual([]);
    expect(out.repoRoots).toEqual([]);
    expect(out.timeRange).toBe("live");
  });

  it("is idempotent", () => {
    const once = migrateSettings({ enabled: { gpu: false }, alerts: { gpuTemp: { on: true, threshold: 85 } } });
    expect(migrateSettings(once)).toEqual(once);
  });
});

describe("profiles", () => {
  it("round-trips the layout fields it owns", () => {
    const source = {
      ...DEFAULT_SETTINGS,
      utilities: { gpu: "off" as const },
      order: ["claude", "procs"],
      sizes: { claude: { height: 200 } },
      privacy: true,
    };
    const profile = captureProfile("Work", source);
    const applied = applyProfile(DEFAULT_SETTINGS, profile);
    expect(applied.utilities.gpu).toBe("off");
    expect(applied.order).toEqual(["claude", "procs"]);
    expect(applied.sizes.claude).toEqual({ height: 200 });
    expect(applied.privacy).toBe(true);
    expect(applied.activeProfile).toBe("Work");
  });

  it("leaves settings a profile does not describe alone", () => {
    const profile = captureProfile("Minimal", DEFAULT_SETTINGS);
    const applied = applyProfile({ ...DEFAULT_SETTINGS, lhmPort: 9999 }, profile);
    expect(applied.lhmPort).toBe(9999);
  });
});
