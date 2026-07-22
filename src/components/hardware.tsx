// Card bodies for the hardware utilities suite. Each renders one payload
// from src-tauri/src/hardware/* and reuses the shared primitives.
//
// The recurring rule in this file: a sensor that does not exist and a sensor
// reading zero are different facts. `null` is always rendered as "—" with the
// reason in the tooltip, never as 0, "ok" or "off".

import { useState } from "react";
import type { JSX } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  BatteryInfo,
  DiskVolume,
  DisksStatus,
  GpuStatus,
  KillResult,
  McpServer,
  McpStatus,
  NetQuality,
  OllamaStatus,
  PortListener,
  PortsStatus,
  SpeedtestResult,
  ThermalsStatus,
  UptimeStatus,
  WingetStatus,
  WslDistro,
  WslStatus,
} from "../types";
import type { AttentionState } from "../model/status";
import type { HistoryStore } from "../model/history";
import { seriesStats } from "../model/history";
import type { Redactor } from "../model/privacy";
import { maskSecrets, safeText } from "../model/privacy";
import { fmtAgo, fmtBytes, fmtDuration, fmtRate } from "../format";
import { EmptyState, Stat } from "./StatusBits";
import { DataRow } from "./DataRow";
import { rowBudget, useCardDensity } from "./density";
import { Dot, HistoryChart, Meter } from "./viz";

function tempTone(c: number, warnAt = 75, badAt = 88): string {
  return c >= badAt ? "var(--bad)" : c >= warnAt ? "var(--warn)" : "var(--good)";
}

const ACTIONS_OFF = "Operator actions are switched off for this card in Settings";

/** One named series out of the card's history, with its own summary line. */
function SeriesChart({
  history,
  name,
  format = (v: number) => v.toFixed(0),
}: {
  history: HistoryStore;
  name: string;
  format?: (v: number) => string;
}): JSX.Element {
  const series = history[name];
  const stats = series ? seriesStats(series.points) : null;
  return (
    <div>
      <div className="muted small ip-line">
        {name}
        {stats
          ? ` · min ${format(stats.min)} · avg ${format(stats.avg)} · max ${format(stats.max)}`
          : " · no samples recorded yet"}
      </div>
      <HistoryChart points={series?.points ?? []} />
    </div>
  );
}

// ---------- GPU ----------

export function GpuCardBody({
  status,
  onKilled,
}: {
  status: GpuStatus | null;
  onKilled: () => void;
}): JSX.Element {
  const density = useCardDensity();
  const compact = density === "compact";
  const expanded = density === "expanded";
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState<number | null>(null);

  if (!status) {
    return <EmptyState reason="no_data" detail="Waiting for the first nvidia-smi run." compact={compact} />;
  }
  if (!status.available) {
    return (
      <EmptyState
        reason="not_installed"
        detail="No NVIDIA driver was detected — nvidia-smi is not on PATH."
        compact={compact}
      />
    );
  }
  if (status.error) {
    return (
      <EmptyState
        reason="collector_error"
        detail={`${maskSecrets(status.error)}${status.error.toLowerCase().includes("mismatch") ? " — a driver/library version mismatch is usually cleared by a reboot." : ""}`}
        compact={compact}
      />
    );
  }
  if (status.gpus.length === 0) {
    return (
      <EmptyState reason="valid_zero" detail="The driver reported no GPUs." compact={compact} />
    );
  }

  const first = status.gpus[0];
  if (compact) {
    return (
      <div className="stat-grid stat-grid-2">
        <Stat
          value={first.utilPercent != null ? `${first.utilPercent.toFixed(0)}%` : "—"}
          label="gpu util"
          hint={first.utilPercent != null ? first.name : "utilisation not reported by the driver"}
        />
        <Stat
          value={first.tempC != null ? `${first.tempC.toFixed(0)}°C` : "—"}
          label="temp"
          hint={first.tempC != null ? "GPU core temperature" : "this GPU exposes no temperature sensor"}
          tone={first.tempC != null ? tempTone(first.tempC) : undefined}
        />
      </div>
    );
  }

  return (
    <>
      {status.gpus.map((g) => {
        const memPct =
          g.memUsedMb != null && g.memTotalMb ? (g.memUsedMb / g.memTotalMb) * 100 : null;
        return (
          <div key={g.index}>
            <div
              className="gateway-row"
              title={
                `${g.name}${status.driver ? ` · driver ${status.driver}` : " · driver version not reported"}` +
                (g.pstate ? ` · performance state ${g.pstate}` : "")
              }
            >
              <span className="gateway-state">{g.name.replace("NVIDIA GeForce ", "")}</span>
            </div>
            <div className="stat-grid stat-grid-2">
              <Stat
                value={g.utilPercent != null ? `${g.utilPercent.toFixed(0)}%` : "—"}
                label="gpu util"
                hint={g.utilPercent != null ? "GPU core utilisation" : "utilisation not reported by the driver"}
                sub={g.utilPercent != null ? <Meter percent={g.utilPercent} /> : undefined}
              />
              <Stat
                value={memPct != null ? `${memPct.toFixed(0)}%` : "—"}
                label={
                  memPct != null
                    ? `vram · ${((g.memUsedMb ?? 0) / 1024).toFixed(1)} / ${((g.memTotalMb ?? 0) / 1024).toFixed(0)} GB`
                    : "vram"
                }
                hint={memPct != null ? `VRAM ${g.memUsedMb} of ${g.memTotalMb} MB` : "VRAM figures not reported by the driver"}
                sub={memPct != null ? <Meter percent={memPct} /> : undefined}
              />
              <Stat
                value={g.tempC != null ? `${g.tempC.toFixed(0)}°C` : "—"}
                label={g.fanPercent != null ? `temp · fan ${g.fanPercent.toFixed(0)}%` : "temp"}
                hint={g.tempC != null ? "GPU core temperature" : "this GPU exposes no temperature sensor"}
                tone={g.tempC != null ? tempTone(g.tempC) : undefined}
              />
              <Stat
                value={g.powerW != null ? `${g.powerW.toFixed(0)}W` : "—"}
                label={`${g.powerLimitW != null ? `of ${g.powerLimitW.toFixed(0)}W` : "power"}${g.clockMhz != null ? ` · ${g.clockMhz}MHz` : ""}`}
                hint={g.powerW != null ? "board power draw" : "power draw not reported by the driver"}
              />
            </div>
          </div>
        );
      })}
      {expanded &&
        (status.processes.length === 0 ? (
          <div className="muted small">no process currently holds GPU memory</div>
        ) : (
          <div className="drow-list">
            {status.processes.slice(0, rowBudget(density)).map((p) => (
              <div className="drow" key={p.pid} title={`${p.name} · pid ${p.pid}`}>
                <span className="drow-open drow-static">
                  <span className="drow-primary">
                    {p.name}
                    <span className="drow-dim"> pid {p.pid}</span>
                  </span>
                  {p.memMb != null ? (
                    <span className="drow-value" title={`${p.memMb} MB of VRAM held`}>
                      {p.memMb} MB
                    </span>
                  ) : null}
                </span>
                {/* Arm-then-confirm survives, but as an icon: the confirmation
                    already lives in the tooltip and the second click. */}
                <button
                  className={`drow-action${armed === p.pid ? " drow-action-armed" : ""}`}
                  disabled={!p.killable || p.startTimeUnix == null || busy}
                  aria-label={`Terminate ${p.name}, pid ${p.pid}`}
                  title={
                    p.killable && p.startTimeUnix != null
                      ? armed === p.pid
                        ? `Click again to terminate ${p.name} (pid ${p.pid})`
                        : `Terminate ${p.name} (pid ${p.pid})`
                      : "Access denied — this process runs at a higher integrity level than the HUD"
                  }
                  onClick={() => {
                    if (armed !== p.pid) {
                      setArmed(p.pid);
                      return;
                    }
                    if (p.startTimeUnix == null) return;
                    setArmed(null);
                    setBusy(true);
                    void invoke<KillResult>("kill_process", {
                      pid: p.pid,
                      startTimeUnix: p.startTimeUnix,
                      killTree: false,
                    })
                      .then(onKilled)
                      .finally(() => setBusy(false));
                  }}
                  onBlur={() => setArmed(null)}
                >
                  <span aria-hidden="true">{armed === p.pid ? "!" : "✕"}</span>
                </button>
              </div>
            ))}
          </div>
        ))}
    </>
  );
}

// ---------- Thermals ----------

export function ThermalsCardBody({
  status,
  gpuC,
  history,
  onSetup,
}: {
  status: ThermalsStatus | null;
  gpuC: number | null;
  history: HistoryStore;
  onSetup: () => void;
}): JSX.Element {
  const density = useCardDensity();
  const compact = density === "compact";
  const expanded = density === "expanded";

  if (!status) {
    return <EmptyState reason="no_data" detail="Waiting for the first sensor read." compact={compact} />;
  }
  if (status.tier === "none") {
    return (
      <EmptyState
        reason="not_configured"
        detail="No CPU sensor is readable without elevation. LibreHardwareMonitor unlocks full temperatures and fan speeds in about two minutes."
        actions={[{ label: "Set up full telemetry", onSelect: onSetup }]}
        compact={compact}
      />
    );
  }

  const main = status.cpuPackageC ?? status.zoneC;
  const mainLabel = status.tier === "wmi" ? "thermal zone" : "cpu package";
  const mainHint =
    status.tier === "wmi"
      ? "ACPI thermal zone (motherboard-level), the only sensor readable without elevation"
      : "CPU package temperature reported by LibreHardwareMonitor";

  if (compact) {
    return (
      <div className="stat-grid stat-grid-2">
        <Stat
          value={main != null ? `${main.toFixed(0)}°C` : "—"}
          label={mainLabel}
          hint={main != null ? mainHint : "no CPU temperature was returned this cycle"}
          tone={main != null ? tempTone(main, 80, 95) : undefined}
        />
        <Stat
          value={gpuC != null ? `${gpuC.toFixed(0)}°C` : "—"}
          label="gpu"
          hint={gpuC != null ? "GPU core temperature, from the GPU card" : "no GPU temperature is available"}
          tone={gpuC != null ? tempTone(gpuC) : undefined}
        />
      </div>
    );
  }

  return (
    <>
      <div className="stat-grid stat-grid-2">
        <Stat
          value={main != null ? `${main.toFixed(0)}°C` : "—"}
          label={mainLabel}
          hint={main != null ? mainHint : "no CPU temperature was returned this cycle"}
          tone={main != null ? tempTone(main, 80, 95) : undefined}
        />
        <Stat
          value={status.cpuMaxCoreC != null ? `${status.cpuMaxCoreC.toFixed(0)}°C` : "—"}
          label="max core"
          hint={
            status.cpuMaxCoreC != null
              ? "Hottest individual core"
              : "per-core sensors are not exposed at this tier"
          }
          tone={status.cpuMaxCoreC != null ? tempTone(status.cpuMaxCoreC, 80, 95) : undefined}
        />
        {gpuC != null ? (
          <Stat
            value={`${gpuC.toFixed(0)}°C`}
            label="gpu"
            hint="GPU core temperature, from the GPU card"
            tone={tempTone(gpuC)}
          />
        ) : null}
        {/* A tile whose value is the word "not throttling" is a tile wasted;
            only an actual thermal limit is worth the space. */}
        {status.throttling ? (
          <Stat
            value="throttling"
            label="thermal limit"
            hint="LibreHardwareMonitor reports the thermal limit is being hit"
            tone="var(--bad)"
          />
        ) : null}
        {status.fansRpm.slice(0, expanded ? 4 : 1).map((rpm, i) => (
          <Stat key={i} value={rpm} label="fan rpm" hint={`Fan ${i + 1} speed`} />
        ))}
      </div>
      <div className="muted small ip-line">
        {status.tier === "lhm"
          ? `full telemetry · ${status.sensorCount} sensors`
          : "basic (WMI zone only) — set up LibreHardwareMonitor for per-core temperatures and fans"}
        {status.fansRpm.length === 0 ? " · no fan sensor" : ""}
      </div>
      {expanded && (
        <>
          <SeriesChart history={history} name="CPU °C" />
          <SeriesChart history={history} name="GPU °C" />
        </>
      )}
    </>
  );
}

// ---------- Disks ----------

const NO_SMART = "SMART predict-failure is not reported by this driver — the drive's health is unknown.";
const NO_LATENCY = "The average-disk-seconds-per-transfer counter was not readable this cycle.";

function VolumeRow({ v }: { v: DiskVolume }): JSX.Element {
  const used = v.total - v.available;
  const pct = v.total > 0 ? (used / v.total) * 100 : 0;
  const kind = v.kind === "unknown" ? "media type unknown" : v.kind;
  return (
    <div
      className="stat disk-row"
      title={
        `${v.label || v.mount} — ${fmtBytes(v.available)} free of ${fmtBytes(v.total)}\n` +
        `${v.fs ?? "filesystem not reported"} · ${kind}${v.removable ? " · removable" : ""}\n` +
        (v.smartOk == null
          ? NO_SMART
          : v.smartOk
            ? "SMART reports no predicted failure"
            : "SMART predicts imminent failure — back it up now")
      }
    >
      <div className="disk-head">
        <span className="disk-mount">{v.mount}</span>
        {v.smartOk === false ? (
          <span className="badge badge-warn" title="SMART predicts imminent failure on this drive — back it up now.">
            SMART failing
          </span>
        ) : null}
        <span className="muted small disk-size">
          {fmtBytes(used)} / {fmtBytes(v.total)}
        </span>
      </div>
      <Meter percent={pct} />
    </div>
  );
}

export function DisksCardBody({
  status,
  history,
}: {
  status: DisksStatus | null;
  history: HistoryStore;
}): JSX.Element {
  const density = useCardDensity();
  const compact = density === "compact";
  const expanded = density === "expanded";

  if (!status) {
    return <EmptyState reason="no_data" detail="Waiting for the first volume scan." compact={compact} />;
  }
  if (status.volumes.length === 0) {
    return (
      <EmptyState
        reason="collector_error"
        detail="No volume was returned — the volume enumeration failed or every volume was filtered out."
        compact={compact}
      />
    );
  }

  const fullest = status.volumes.reduce((worst, v) => {
    const p = (x: DiskVolume) => (x.total > 0 ? (x.total - x.available) / x.total : 0);
    return p(v) > p(worst) ? v : worst;
  }, status.volumes[0]);
  const failing = status.volumes.filter((v) => v.smartOk === false);

  if (compact) {
    const pct = fullest.total > 0 ? ((fullest.total - fullest.available) / fullest.total) * 100 : 0;
    return (
      <div className="stat-grid stat-grid-2">
        <Stat
          value={`${pct.toFixed(0)}%`}
          label={`${fullest.mount} used`}
          hint={`${fmtBytes(fullest.available)} free of ${fmtBytes(fullest.total)} — the fullest volume`}
        />
        <Stat
          value={failing.length > 0 ? "SMART" : status.volumes.length}
          label={failing.length > 0 ? "failing" : "volumes"}
          hint={
            failing.length > 0
              ? `SMART predicts failure on ${failing.map((v) => v.mount).join(", ")}`
              : `${status.volumes.length} volume(s) mounted`
          }
          tone={failing.length > 0 ? "var(--bad)" : undefined}
        />
      </div>
    );
  }

  return (
    <>
      {failing.length > 0 && (
        <div className="gateway-row">
          <Dot state="bad" title="SMART predicted failure" />
          <span className="gateway-state">
            SMART predicts failure on {failing.map((v) => v.mount).join(", ")} — back up now
          </span>
        </div>
      )}
      {status.volumes.slice(0, rowBudget(density)).map((v) => (
        <VolumeRow key={v.mount} v={v} />
      ))}
      <div className="muted small ip-line">
        read {fmtRate(status.readBps)} · write {fmtRate(status.writeBps)} ·{" "}
        <span title={status.latencyMs == null ? NO_LATENCY : "average disk service time per transfer"}>
          latency {status.latencyMs == null ? "—" : `${status.latencyMs.toFixed(1)}ms`}
        </span>
      </div>
      {expanded && (
        <>
          <SeriesChart history={history} name="Disk read B/s" format={(v) => fmtRate(v)} />
          <SeriesChart history={history} name="Disk write B/s" format={(v) => fmtRate(v)} />
        </>
      )}
    </>
  );
}

// ---------- Network quality ----------

const NO_DNS = "DNS was not measured this cycle.";
const NO_JITTER = "Only one latency sample was taken, so jitter could not be derived.";

export function NetQualityCardBody({
  status,
  redactor,
  attention,
  history,
}: {
  status: NetQuality | null;
  redactor: Redactor;
  attention: AttentionState;
  history: HistoryStore;
}): JSX.Element {
  const density = useCardDensity();
  const compact = density === "compact";
  const expanded = density === "expanded";

  if (!status) {
    return <EmptyState reason="no_data" detail="Waiting for the first probe." compact={compact} />;
  }
  if (status.mode === "none") {
    return (
      <EmptyState
        reason="unavailable"
        detail="Neither ICMP nor the TCP fallback could reach a probe target — this host has no usable path out."
        compact={compact}
      />
    );
  }

  const ssid = redactor.value("host", status.wifiSsid);
  // The banner names the condition; the badge colour is only reinforcement.
  const incident =
    attention === "normal"
      ? null
      : status.lossPercent > 0
        ? `packet loss ${status.lossPercent.toFixed(0)}%`
        : status.latencyMs != null
          ? `latency ${status.latencyMs.toFixed(0)}ms`
          : "no reply from the probe target";

  if (compact) {
    return (
      <>
        {incident && (
          <div className="gateway-row">
            <Dot state={attention === "critical" ? "bad" : "warn"} title={incident} />
            <span className="gateway-state">{incident}</span>
          </div>
        )}
        <div className="stat-grid stat-grid-2">
          <Stat
            value={status.latencyMs != null ? `${status.latencyMs.toFixed(0)}ms` : "—"}
            label={status.mode === "tcp" ? "ping (tcp)" : "ping"}
            hint={status.latencyMs != null ? "last round-trip time" : "the last probe got no reply"}
          />
          <Stat
            value={`${status.lossPercent.toFixed(0)}%`}
            label="loss"
            hint={`${status.samples.filter((s) => s < 0).length} of ${status.samples.length} probes got no reply`}
            tone={status.lossPercent > 0 ? "var(--warn)" : undefined}
          />
        </div>
      </>
    );
  }

  const max = Math.max(20, ...status.samples.filter((s) => s >= 0));
  return (
    <>
      {incident && (
        <div className="gateway-row">
          <Dot state={attention === "critical" ? "bad" : "warn"} title={incident} />
          <span className="gateway-state">
            {attention === "critical" ? "Critical" : "Warning"}: {incident}
          </span>
        </div>
      )}
      <div className="stat-grid">
        <Stat
          value={status.latencyMs != null ? `${status.latencyMs.toFixed(0)}ms` : "—"}
          label={status.mode === "tcp" ? "ping (tcp)" : "ping"}
          hint={
            status.latencyMs != null
              ? `last round-trip time${status.avgMs != null ? `, ${status.avgMs.toFixed(0)}ms average over the window` : ""}`
              : "the last probe got no reply"
          }
        />
        <Stat
          value={status.jitterMs != null ? `${status.jitterMs.toFixed(0)}ms` : "—"}
          label="jitter"
          hint={status.jitterMs != null ? "variation between consecutive probes" : NO_JITTER}
          freshness={status.jitterMs == null ? "not_measured" : "live"}
        />
        <Stat
          value={`${status.lossPercent.toFixed(0)}%`}
          label="loss"
          hint={`${status.samples.filter((s) => s < 0).length} of ${status.samples.length} probes got no reply`}
          tone={status.lossPercent > 0 ? "var(--warn)" : undefined}
        />
        {expanded ? (
          <Stat
            value={status.dnsMs != null ? `${status.dnsMs.toFixed(0)}ms` : "—"}
            label="dns"
            hint={status.dnsMs != null ? "time to resolve a well-known name" : NO_DNS}
            freshness={status.dnsMs == null ? "not_measured" : "live"}
          />
        ) : null}
      </div>
      <svg
        className="spark"
        width="100%"
        height="26"
        viewBox="0 0 200 26"
        preserveAspectRatio="none"
        role="img"
        aria-label={`${status.samples.length} probes, ${status.samples.filter((s) => s < 0).length} with no reply`}
      >
        {status.samples.map((s, i) => {
          const w = 200 / Math.max(1, status.samples.length);
          const h = s < 0 ? 22 : Math.max(2, (s / max) * 22);
          return (
            <rect
              key={i}
              x={i * w + 1}
              y={26 - h}
              width={Math.max(1, w - 2)}
              height={h}
              fill={s < 0 ? "var(--bad)" : "var(--accent)"}
              opacity={s < 0 ? 0.8 : 0.85}
            />
          );
        })}
      </svg>
      <div className="muted small ip-line">
        <span title={status.interfaceName ? "active interface" : "the active interface could not be identified"}>
          {status.interfaceName ?? "interface —"}
        </span>
        {" · "}
        <span title={status.linkType ? "link media type" : "media type not reported"}>
          {status.linkType ?? "link —"}
        </span>
        {ssid ? ` · ${ssid} ${status.wifiSignal != null ? `${status.wifiSignal}%` : "signal —"}` : ""}
        {status.linkMbps != null ? ` · link ${status.linkMbps.toFixed(0)} Mbps` : ""}
      </div>
      {expanded && (
        <>
          <SeriesChart history={history} name="Latency ms" />
          <SeriesChart history={history} name="Packet loss %" />
        </>
      )}
    </>
  );
}

// ---------- Ports ----------

const EXPOSURE_LABEL: Record<PortListener["exposure"], string> = {
  loopback: "loopback only",
  lan: "local network",
  public: "all interfaces",
};

const EXPOSURE_DOT: Record<PortListener["exposure"], "good" | "warn" | "bad"> = {
  loopback: "good",
  lan: "warn",
  public: "bad",
};

function PortRow({
  l,
  redactor,
  onOpen,
  onInspect,
}: {
  l: PortListener;
  redactor: Redactor;
  onOpen: (port: number) => void;
  onInspect: (port: number, proto: string) => void;
}): JSX.Element {
  const bind = redactor.ip(l.bindAddr) ?? l.bindAddr;
  const exposure = EXPOSURE_LABEL[l.exposure];
  const ageSecs = Math.max(0, Date.now() / 1000 - l.firstSeenUnix);
  return (
    <DataRow
      lead={<Dot state={EXPOSURE_DOT[l.exposure]} title={exposure} />}
      // Port first because that is what you are looking one up by; the owner
      // takes the slack and is the first thing to truncate.
      primary={
        <>
          <span className="drow-key">:{l.port}</span> {l.process}
        </>
      }
      value={fmtDuration(ageSecs)}
      valueHint={`listening for ${fmtDuration(ageSecs)} · ${exposure} · pid ${l.pid}`}
      tone={l.exposure === "public" ? "warn" : undefined}
      title={`${l.proto}/${l.family} ${bind}:${l.port} · ${exposure} · ${l.process} (pid ${l.pid})`}
      onOpen={() => onInspect(l.port, l.proto)}
      action={{
        icon: "↗",
        label: `Open http://localhost:${l.port}`,
        hint: `Opens http://localhost:${l.port}`,
        onSelect: () => onOpen(l.port),
      }}
    />
  );
}

export function PortsCardBody({
  status,
  redactor,
  onOpen,
  onInspect,
}: {
  status: PortsStatus | null;
  redactor: Redactor;
  onOpen: (port: number) => void;
  onInspect: (port: number, proto: string) => void;
}): JSX.Element {
  const density = useCardDensity();
  const compact = density === "compact";

  if (!status) {
    return <EmptyState reason="no_data" detail="Waiting for the first socket scan." compact={compact} />;
  }
  if (status.error) {
    return (
      <EmptyState
        reason="permission_denied"
        detail={safeText(redactor, status.error) ?? "sockets could not be enumerated"}
        compact={compact}
      />
    );
  }
  if (status.listeners.length === 0) {
    return (
      <EmptyState reason="valid_zero" detail="Nothing is listening on this host." compact={compact} />
    );
  }

  const exposed = status.listeners.filter((l) => l.exposure !== "loopback");

  if (compact) {
    return (
      <div className="stat-grid stat-grid-2">
        <Stat value={status.listeners.length} label="listening" hint="Sockets in the listening state" />
        <Stat
          value={exposed.length}
          label="reachable off-host"
          hint={
            exposed.length === 0
              ? "Every listener is bound to loopback only."
              : `${exposed.map((l) => `:${l.port}`).join(", ")} are bound beyond loopback`
          }
          tone={exposed.length > 0 ? "var(--warn)" : undefined}
        />
      </div>
    );
  }

  const shown = status.listeners.slice(0, rowBudget(density));
  return (
    <>
      <div className="drow-list">
        {shown.map((l) => (
          <PortRow
            key={`${l.proto}-${l.family}-${l.port}-${l.pid}`}
            l={l}
            redactor={redactor}
            onOpen={onOpen}
            onInspect={onInspect}
          />
        ))}
      </div>
      <div className="proc-footer muted small">
        {status.listeners.length} listening · {exposed.length} reachable beyond loopback
        {status.listeners.length > shown.length
          ? ` · ${status.listeners.length - shown.length} not shown`
          : ""}
      </div>
    </>
  );
}

// ---------- WSL ----------

const NO_DISK_SIZE = "the virtual disk could not be measured (no BasePath in the registry)";

function DistroRow({
  d,
  actionsEnabled,
  onOpenTerminal,
  onInspect,
}: {
  d: WslDistro;
  actionsEnabled: boolean;
  onOpenTerminal: (name: string) => void;
  onInspect: (name: string) => void;
}): JSX.Element {
  const running = d.state === "Running";
  // Start and Terminate are in the distribution's inspector: terminating loses
  // unsaved work inside the VM, which deserves the deliberate path rather than
  // a button sitting under the pointer on a crowded row.
  return (
    <DataRow
      lead={<Dot state={running ? "good" : "off"} title={d.state} />}
      primary={d.name}
      secondary={d.state}
      value={d.diskBytes == null ? undefined : fmtBytes(d.diskBytes)}
      valueHint={d.diskBytes == null ? NO_DISK_SIZE : "virtual disk size on the host"}
      title={`WSL ${d.version} · ${d.state}${d.isDefault ? " · default" : ""}`}
      onOpen={() => onInspect(d.name)}
      action={{
        icon: "⌨",
        label: `Open a terminal in ${d.name}`,
        hint: actionsEnabled ? `Opens a shell inside ${d.name}` : ACTIONS_OFF,
        disabled: !actionsEnabled,
        onSelect: () => onOpenTerminal(d.name),
      }}
    />
  );
}

export function WslCardBody({
  status,
  actionsEnabled,
  onInspect,
  onOpenTerminal,
  onChanged,
}: {
  status: WslStatus | null;
  actionsEnabled: boolean;
  onInspect: (name: string) => void;
  onOpenTerminal: (name: string) => void;
  onChanged: () => void;
}): JSX.Element {
  const density = useCardDensity();
  const compact = density === "compact";
  const [busy, setBusy] = useState(false);
  const [armedAll, setArmedAll] = useState(false);

  if (!status) {
    return <EmptyState reason="no_data" detail="Waiting for the first `wsl --list`." compact={compact} />;
  }
  if (!status.installed) {
    return (
      <EmptyState reason="not_installed" detail="WSL is not installed on this host." compact={compact} />
    );
  }
  if (status.distros.length === 0) {
    return (
      <EmptyState
        reason="valid_zero"
        detail="WSL is installed but no distribution has been created."
        compact={compact}
      />
    );
  }

  const running = status.distros.filter((d) => d.state === "Running");

  if (compact) {
    return (
      <div className="stat-grid stat-grid-2">
        <Stat
          value={`${running.length}/${status.distros.length}`}
          label="running"
          hint="Distributions in the Running state"
        />
        <Stat
          value={status.vmmemBytes == null ? "—" : fmtBytes(status.vmmemBytes)}
          label="vmmem"
          hint={
            status.vmmemBytes == null
              ? "the WSL utility VM process was not found"
              : "memory held by the shared WSL2 utility VM"
          }
        />
      </div>
    );
  }

  return (
    <>
      <div className="drow-list">
        {status.distros.slice(0, rowBudget(density)).map((d) => (
          <DistroRow
            key={d.name}
            d={d}
            actionsEnabled={actionsEnabled}
            onOpenTerminal={onOpenTerminal}
            onInspect={onInspect}
          />
        ))}
      </div>
      <div className="gateway-row">
        <span
          className="muted small"
          title={
            status.vmmemBytes == null
              ? "the WSL utility VM process was not found"
              : "memory held by the shared WSL2 utility VM — one VM backs every running distribution"
          }
        >
          vmmem {status.vmmemBytes == null ? "—" : fmtBytes(status.vmmemBytes)}
        </span>
        <span className="head-spacer" />
        {running.length > 0 && (
          <button
            className={`btn btn-slim btn-danger${armedAll ? " overflow-armed" : ""}`}
            disabled={busy || !actionsEnabled}
            aria-label="Shut down every running WSL distribution"
            title={
              actionsEnabled
                ? `Stops all ${running.length} running distribution(s) and the shared VM`
                : ACTIONS_OFF
            }
            onClick={() => {
              if (!armedAll) {
                setArmedAll(true);
                return;
              }
              setArmedAll(false);
              setBusy(true);
              void invoke("wsl_shutdown_all", {})
                .then(onChanged)
                .finally(() => setBusy(false));
            }}
            onBlur={() => setArmedAll(false)}
          >
            {armedAll ? "Confirm: Shut down all" : "Shut down all"}
          </button>
        )}
      </div>
    </>
  );
}

// ---------- Battery ----------

export function BatteryCardBody({ status }: { status: BatteryInfo | null }): JSX.Element {
  const density = useCardDensity();
  const compact = density === "compact";

  if (!status) {
    return <EmptyState reason="no_data" detail="Waiting for the first power query." compact={compact} />;
  }
  if (!status.present) {
    return (
      <EmptyState
        reason="unsupported"
        detail="This host has no battery — it is a desktop or the firmware exposes none."
        compact={compact}
      />
    );
  }

  const onBattery = status.onAc === false;
  return (
    <>
      <div className="stat-grid stat-grid-2">
        <Stat
          value={status.percent != null ? `${status.percent}%` : "—"}
          label={status.onAc == null ? "power source unknown" : onBattery ? "on battery" : "plugged in"}
          hint={
            status.percent != null
              ? "Charge remaining as reported by the firmware"
              : "the firmware did not report a charge level"
          }
          sub={status.percent != null ? <Meter percent={status.percent} /> : undefined}
        />
        <Stat
          value={status.runtimeMin != null ? fmtDuration(status.runtimeMin * 60) : "—"}
          label="est. remaining"
          hint={
            status.runtimeMin != null
              ? "Firmware estimate at the current draw"
              : onBattery
                ? "the firmware has not produced a runtime estimate yet"
                : "no runtime estimate is produced while on AC power"
          }
          freshness={status.runtimeMin == null ? "not_measured" : "estimated"}
        />
      </div>
      {!compact && (
        <div className="muted small ip-line" title={status.powerPlan ? "active Windows power plan" : "the active power plan could not be read"}>
          plan: {status.powerPlan ?? "—"}
        </div>
      )}
    </>
  );
}

// ---------- Uptime ----------

export function UptimeCardBody({ status }: { status: UptimeStatus | null }): JSX.Element {
  const density = useCardDensity();
  const compact = density === "compact";

  if (!status) {
    return <EmptyState reason="no_data" detail="Waiting for the first uptime read." compact={compact} />;
  }
  return (
    <>
      <div className="stat-grid stat-grid-2">
        <Stat
          value={fmtDuration(status.uptimeSecs)}
          label="uptime"
          hint={`Booted ${new Date(status.bootUnix * 1000).toLocaleString()}`}
        />
        <Stat
          value={status.rebootPending ? "yes" : "no"}
          label="reboot pending"
          hint={
            status.rebootPending
              ? `Pending because: ${status.reasons.join(", ")}`
              : "No servicing operation has flagged a pending reboot"
          }
          tone={status.rebootPending ? "var(--warn)" : undefined}
        />
      </div>
      {!compact && (
        <div className="muted small ip-line">
          booted {new Date(status.bootUnix * 1000).toLocaleString()}
        </div>
      )}
    </>
  );
}

// ---------- Ollama ----------

export function OllamaCardBody({ status }: { status: OllamaStatus | null }): JSX.Element {
  const density = useCardDensity();
  const compact = density === "compact";

  if (!status) {
    return <EmptyState reason="no_data" detail="Waiting for the first probe of the Ollama API." compact={compact} />;
  }
  if (!status.reachable) {
    return (
      <EmptyState
        reason="unavailable"
        detail="Nothing answered on the Ollama port — the server is not running."
        compact={compact}
      />
    );
  }

  if (compact) {
    return (
      <div className="stat-grid stat-grid-2">
        <Stat value={status.loaded.length} label="loaded" hint="Models resident in memory right now" />
        <Stat value={status.installedCount} label="installed" hint="Models pulled onto this host" />
      </div>
    );
  }

  return (
    <>
      {status.loaded.length === 0 ? (
        <EmptyState
          reason="valid_zero"
          detail="The server is up and no model is resident in memory."
          compact={compact}
        />
      ) : (
        <div className="proc-list">
          {status.loaded.slice(0, rowBudget(density)).map((m) => {
            const expiresIn =
              m.expiresAt == null ? null : (new Date(m.expiresAt).getTime() - Date.now()) / 1000;
            return (
              <DataRow
                key={m.name}
                lead={<Dot state="good" title="resident in memory" />}
                primary={m.name}
                secondary={
                  expiresIn == null
                    ? undefined
                    : expiresIn > 0
                      ? `unloads in ${fmtDuration(expiresIn)}`
                      : "unloading"
                }
                value={m.vramBytes != null ? fmtBytes(m.vramBytes) : undefined}
                valueHint={
                  m.vramBytes == null
                    ? "the server did not report a size"
                    : `${fmtBytes(m.vramBytes)} held in memory`
                }
                title={
                  `${m.name} — resident in memory\n` +
                  (m.expiresAt == null ? "no unload deadline reported" : `unloads at ${m.expiresAt}`)
                }
              />
            );
          })}
        </div>
      )}
      <div className="muted small ip-line">{status.installedCount} models installed</div>
    </>
  );
}

// ---------- Winget ----------

const UPGRADE_ALL = "winget upgrade --all";

export function WingetCardBody({
  status,
  onRefresh,
  onCopy,
}: {
  status: WingetStatus | null;
  onRefresh: () => void;
  onCopy: (text: string) => void;
}): JSX.Element {
  const density = useCardDensity();
  const compact = density === "compact";

  if (!status) {
    return (
      <EmptyState
        reason="no_data"
        detail="Checking for updates — winget can take a minute to answer."
        compact={compact}
      />
    );
  }
  if (!status.installed) {
    return (
      <EmptyState reason="not_installed" detail="winget was not found on PATH." compact={compact} />
    );
  }
  if (status.error) {
    return (
      <EmptyState
        reason="collector_error"
        detail={maskSecrets(status.error)}
        actions={[{ label: "Re-check", onSelect: onRefresh }]}
        compact={compact}
      />
    );
  }

  if (compact) {
    return (
      <div className="stat-grid stat-grid-2">
        <Stat
          value={status.updates.length}
          label="updates"
          hint={
            status.updates.length === 0
              ? "Every package winget knows about is at its latest version."
              : status.updates.map((u) => u.name).join(", ")
          }
        />
      </div>
    );
  }

  return (
    <>
      {status.updates.length === 0 ? (
        <EmptyState
          reason="valid_zero"
          detail={`Checked ${fmtAgo(new Date(status.checkedUnix * 1000).toISOString())} — every package is at its latest version.`}
          compact={compact}
        />
      ) : (
        <div className="proc-list">
          {status.updates.slice(0, rowBudget(density)).map((u) => (
            <DataRow
              key={u.id}
              primary={u.name}
              secondary={u.current}
              value={`→ ${u.available}`}
              valueHint={`${u.current} is installed; ${u.available} is available`}
              title={`${u.id}: ${u.current} → ${u.available}`}
            />
          ))}
        </div>
      )}
      <div className="gateway-row">
        <span className="muted small">
          {status.updates.length > 0
            ? `${status.updates.length} update(s) available`
            : `checked ${fmtAgo(new Date(status.checkedUnix * 1000).toISOString())}`}
        </span>
        <span className="head-spacer" />
        {status.updates.length > 0 && (
          <button
            className="btn btn-slim"
            aria-label="Copy the winget upgrade command to the clipboard"
            title={`Copies "${UPGRADE_ALL}" — this card never runs it for you`}
            onClick={() => onCopy(UPGRADE_ALL)}
          >
            Copy upgrade command
          </button>
        )}
        <button className="btn btn-slim" aria-label="Re-check for updates" onClick={onRefresh}>
          Re-check
        </button>
      </div>
    </>
  );
}

// ---------- Speedtest ----------

export function SpeedtestCardBody({
  history,
  onCompleted,
}: {
  /** Past runs, newest first — persisted, so the card is not blank on restart. */
  history: SpeedtestResult[];
  onCompleted: (r: SpeedtestResult) => void;
}): JSX.Element {
  const density = useCardDensity();
  const compact = density === "compact";
  const [running, setRunning] = useState(false);
  const [fresh, setFresh] = useState<SpeedtestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A run from this session wins; otherwise show the newest persisted one.
  const result = fresh ?? history[0] ?? null;

  // Strictly on demand: a speedtest saturates the link, so it is never polled.
  const run = () => {
    setRunning(true);
    setError(null);
    void invoke<SpeedtestResult>("run_speedtest")
      .then((r) => {
        setFresh(r);
        onCompleted(r);
      })
      .catch((e) => setError(maskSecrets(String(e))))
      .finally(() => setRunning(false));
  };

  const runButton = (
    <div className="btn-row">
      <button
        className="btn"
        onClick={run}
        disabled={running}
        aria-label={result ? "Run the speedtest again" : "Run a speedtest, about 33 megabytes of traffic"}
        title="Downloads roughly 33 MB — this is the only thing on this card that touches the network"
      >
        {running ? "Testing…" : result ? "Run again" : "Run speedtest (~33 MB)"}
      </button>
    </div>
  );

  if (!result) {
    return (
      <>
        <EmptyState
          reason={error ? "collector_error" : "no_data"}
          detail={
            error ??
            "Not run yet — a speedtest saturates the link, so it only happens when you ask for it."
          }
          compact={compact}
        />
        {runButton}
      </>
    );
  }

  return (
    <>
      <div className={compact ? "stat-grid stat-grid-2" : "stat-grid"}>
        <Stat value={result.downMbps.toFixed(0)} label="↓ Mbps" hint="Measured download throughput" />
        <Stat value={result.upMbps.toFixed(0)} label="↑ Mbps" hint="Measured upload throughput" />
        {!compact && (
          <>
            <Stat
              value={`${result.latencyMs.toFixed(0)}ms`}
              label="latency"
              hint="Round-trip time to the test server"
            />
            <Stat
              value={result.jitterMs != null ? `${result.jitterMs.toFixed(0)}ms` : "—"}
              label="jitter"
              hint={
                result.jitterMs != null
                  ? "Variation across the latency samples"
                  : "Single latency sample, jitter not measured"
              }
              freshness={result.jitterMs == null ? "not_measured" : "live"}
            />
          </>
        )}
      </div>
      {error && <div className="muted small">{error}</div>}
      {runButton}
      {!compact && (
        <div className="muted small ip-line">
          {result.provider} · last run {new Date(result.atUnix * 1000).toLocaleTimeString()}
        </div>
      )}
      {density === "expanded" && history.length > 1 && (
        <div className="drow-list">
          {history.slice(0, 8).map((h) => (
            <DataRow
              key={h.atUnix}
              primary={new Date(h.atUnix * 1000).toLocaleString()}
              value={`↓${h.downMbps.toFixed(0)} ↑${h.upMbps.toFixed(0)}`}
              valueHint={`${h.downMbps.toFixed(0)} Mbps down, ${h.upMbps.toFixed(0)} up, ${h.latencyMs.toFixed(0)} ms latency`}
              title={`${h.provider} — ${h.latencyMs.toFixed(0)} ms latency`}
            />
          ))}
        </div>
      )}
    </>
  );
}

// ---------- MCP ----------

const HEALTH_CHECK_NOTE =
  "A health check launches the server process and completes a handshake — it is not a passive read.";

function McpRow({
  s,
  redactor,
  actionsEnabled,
  onHealthCheck,
  onInspect,
}: {
  s: McpServer;
  redactor: Redactor;
  actionsEnabled: boolean;
  onHealthCheck: (name: string) => void;
  onInspect: (source: string, name: string) => void;
}): JSX.Element {
  const cwd = s.cwd == null ? null : redactor.path(s.cwd);
  const command = redactor.args(maskSecrets(s.command));
  // Configured-but-not-running is the normal resting state for a stdio server:
  // it is idle, and idle is not a health verdict.
  const activityHint = s.running
    ? "a live process is currently backing this server"
    : "no live process — stdio servers only run while a client is attached. This is not a failure.";
  return (
    <DataRow
      lead={<Dot state={s.running ? "good" : "off"} title={activityHint} />}
      primary={s.name}
      secondary={s.source}
      value={s.pid == null ? "idle" : `pid ${s.pid}`}
      valueHint={s.pid == null ? activityHint : `backed by process ${s.pid}`}
      title={`${s.name} (${s.source})\n${command || "no command recorded"}\n${cwd ?? "no working directory recorded"}`}
      onOpen={() => onInspect(s.source, s.name)}
      // A health check spawns the server, so it stays an explicit act — but it
      // is one of several things you might do here, which makes it inspector
      // work rather than a permanent button on every row.
      action={{
        icon: "⚕",
        label: `Run a health check on ${s.name}`,
        hint: actionsEnabled ? HEALTH_CHECK_NOTE : ACTIONS_OFF,
        disabled: !actionsEnabled,
        onSelect: () => onHealthCheck(s.name),
      }}
    />
  );
}

export function McpCardBody({
  status,
  redactor,
  actionsEnabled,
  onHealthCheck,
  onInspect,
}: {
  status: McpStatus | null;
  redactor: Redactor;
  actionsEnabled: boolean;
  onHealthCheck: (name: string) => void;
  onInspect: (source: string, name: string) => void;
}): JSX.Element {
  const density = useCardDensity();
  const compact = density === "compact";

  if (!status) {
    return <EmptyState reason="no_data" detail="Reading the MCP configuration files." compact={compact} />;
  }
  if (status.servers.length === 0) {
    return (
      <EmptyState
        reason="not_configured"
        detail="No MCP server is configured in any of the config files the HUD reads."
        compact={compact}
      />
    );
  }

  const live = status.servers.filter((s) => s.running);

  if (compact) {
    return (
      <div className="stat-grid stat-grid-2">
        <Stat value={status.servers.length} label="configured" hint="Servers declared across every config file" />
        <Stat
          value={live.length}
          label="with a live process"
          hint="Servers currently backed by a running process. The rest are idle, which is normal for stdio servers."
        />
      </div>
    );
  }

  const shown = status.servers.slice(0, rowBudget(density));
  return (
    <>
      <div className="drow-list">
        {shown.map((s) => (
          <McpRow
            key={`${s.source}-${s.name}`}
            s={s}
            redactor={redactor}
            actionsEnabled={actionsEnabled}
            onHealthCheck={onHealthCheck}
            onInspect={onInspect}
          />
        ))}
      </div>
      <div className="proc-footer muted small">
        {status.servers.length} configured · {live.length} with a live process · idle is the resting
        state, not a fault
        {status.servers.length > shown.length ? ` · ${status.servers.length - shown.length} not shown` : ""}
      </div>
    </>
  );
}

export function fmtGpuSummary(status: GpuStatus | null): string | undefined {
  const g = status?.gpus[0];
  if (!g) return undefined;
  const parts = [
    g.utilPercent != null ? `${g.utilPercent.toFixed(0)}%` : null,
    g.tempC != null ? `${g.tempC.toFixed(0)}°C` : null,
    g.memUsedMb != null ? `${(g.memUsedMb / 1024).toFixed(1)}G vram` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}
