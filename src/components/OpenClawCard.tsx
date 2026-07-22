import { invoke } from "@tauri-apps/api/core";
import type { OpenClawStatus } from "../types";
import type { HistoryStore } from "../model/history";
import { windowed } from "../model/history";
import { fmtBytes, fmtDuration } from "../format";
import { Dot, HistoryChart } from "./viz";
import { EmptyState, Stat } from "./StatusBits";
import { useCardDensity } from "./density";

/** Everything below the process stats is optional in the gateway's contract. */
const NOT_REPORTED = "/health does not report this metric";

function reported(value: number | null, render: (v: number) => string) {
  return value == null
    ? { text: "—", hint: NOT_REPORTED }
    : { text: render(value), hint: undefined };
}

export function OpenClawCardBody({
  status,
  history,
  sinceMs,
}: {
  status: OpenClawStatus | null;
  history: HistoryStore;
  /** Start of the globally selected time range. */
  sinceMs: number;
}) {
  const density = useCardDensity();

  if (!status) {
    return <EmptyState reason="no_data" detail="Waiting for the first /health probe." />;
  }
  if (!status.installed && !status.reachable) {
    return (
      <EmptyState
        reason="not_installed"
        detail="~/.openclaw was not found and nothing is listening on the gateway port."
      />
    );
  }

  const healthy = status.reachable && (status.httpStatus ?? 500) < 500;
  const state = healthy ? "good" : status.reachable ? "warn" : "bad";
  const stateText = healthy
    ? "Gateway healthy"
    : status.reachable
      ? `Responding with HTTP ${status.httpStatus}`
      : "Gateway down";

  const p50 = reported(status.p50Ms, (v) => `${v.toFixed(0)}ms`);
  const p95 = reported(status.p95Ms, (v) => `${v.toFixed(0)}ms`);
  const p99 = reported(status.p99Ms, (v) => `${v.toFixed(0)}ms`);
  const errorRate = reported(status.errorRate, (v) => `${(v * 100).toFixed(1)}%`);
  const rpm = reported(status.requestsPerMin, (v) => v.toFixed(0));
  const active = reported(status.activeRequests, (v) => String(v));
  const queued = reported(status.queuedRequests, (v) => String(v));
  const clients = reported(status.connectedClients, (v) => String(v));

  return (
    <>
      {/* The port and the version never change while you watch; they were three
          chips competing with the one word that does change. The tooltip keeps
          them, and the latency is already a stat below. */}
      <div
        className="gateway-row"
        title={
          `${stateText} — port ${status.port}` +
          (status.version ? ` · v${status.version}` : "") +
          (status.latencyMs != null ? ` · ${status.latencyMs} ms to respond` : "")
        }
      >
        <Dot state={state} title={stateText} />
        <span className="gateway-state">{stateText}</span>
      </div>

      {density === "compact" ? (
        <div className="stat-grid stat-grid-2">
          <Stat value={p95.text} label="p95 latency" hint={p95.hint} />
          <Stat value={errorRate.text} label="error rate" hint={errorRate.hint} />
        </div>
      ) : (
        <>
          <div className="stat-grid">
            <Stat
              value={status.uptimeSecs != null ? fmtDuration(status.uptimeSecs) : "—"}
              label="uptime"
              hint={
                status.uptimeSecs == null
                  ? "No gateway process matched in the process table"
                  : undefined
              }
            />
            <Stat value={rpm.text} label="requests/min" hint={rpm.hint} />
            <Stat value={active.text} label="active" hint={active.hint} />
            <Stat
              value={p95.text}
              label="p95"
              hint={p95.hint}
              tone={status.errorRate != null && status.errorRate > 0.05 ? "var(--warn)" : undefined}
            />
          </div>
          {density === "expanded" && (
            <div className="stat-grid">
              <Stat value={p50.text} label="p50" hint={p50.hint} />
              <Stat value={p99.text} label="p99" hint={p99.hint} />
              <Stat value={queued.text} label="queued" hint={queued.hint} />
              <Stat
                value={errorRate.text}
                label="error rate"
                hint={errorRate.hint}
                tone={
                  status.errorRate != null && status.errorRate > 0.05 ? "var(--warn)" : undefined
                }
              />
            </div>
          )}
        </>
      )}

      {density === "expanded" && (
        <>
          <div className="stat-grid stat-grid-2">
            <Stat
              value={status.memBytes != null ? fmtBytes(status.memBytes) : "—"}
              label="process memory"
              hint={status.memBytes == null ? "No gateway process matched" : undefined}
            />
            <Stat
              value={status.cpuPercent != null ? `${status.cpuPercent.toFixed(0)}%` : "—"}
              label="process cpu"
            />
            <Stat value={clients.text} label="connected clients" hint={clients.hint} />
            <Stat value={String(status.processCount)} label="openclaw processes" />
          </div>
          {history["Gateway p95 ms"] ? (
            <HistoryChart points={windowed(history["Gateway p95 ms"], sinceMs)} />
          ) : null}
          {status.lastError ? (
            <div className="muted small ip-line" title="Last error reported by /health">
              last error: {status.lastError}
            </div>
          ) : null}
        </>
      )}

      <div className="btn-row">
        <button
          className="btn"
          onClick={() => void invoke("open_local_port", { port: status.port })}
          disabled={!status.reachable}
          title={status.reachable ? undefined : "The gateway is not answering"}
        >
          Open Control UI
        </button>
      </div>
    </>
  );
}
