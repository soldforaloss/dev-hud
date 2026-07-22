// Docker containers.
//
// The three states this card must never blur together: a container with a
// failing healthcheck, a container whose healthcheck has not finished its first
// probe, and a container whose image defines no healthcheck at all. Only the
// first is a problem.

import type { JSX } from "react";
import type { ContainerInfo, DockerStatus, PortMapping } from "../types";
import { maskSecrets } from "../model/privacy";
import { fmtBytes, fmtDuration } from "../format";
import { EmptyState, Stat } from "./StatusBits";
import { DataRow, RowOverflow } from "./DataRow";
import { rowBudget, useCardDensity } from "./density";
import { Dot } from "./viz";

const NO_HEALTHCHECK = "no healthcheck defined in this image — health is unknown, not bad";
const NO_CPU = "docker stats did not return a CPU figure for this container";
const NO_MEM = "docker stats did not return a memory figure for this container";
const NO_RESTARTS = "restart count not reported by the daemon";
const NO_PORTS = "this container publishes no ports to the host";
const ACTIONS_OFF = "Operator actions are switched off for this card in Settings";

function healthWord(c: ContainerInfo): { text: string; state: "good" | "warn" | "bad" | "off"; hint: string } {
  if (c.state !== "running") {
    return { text: c.state, state: "off", hint: `container state: ${c.state}` };
  }
  switch (c.health) {
    case "healthy":
      return { text: "healthy", state: "good", hint: "healthcheck passing" };
    case "unhealthy":
      return { text: "unhealthy", state: "bad", hint: "healthcheck is failing" };
    case "starting":
      return { text: "health starting", state: "warn", hint: "healthcheck has not completed its first probe" };
    default:
      return { text: "running · no healthcheck", state: "good", hint: NO_HEALTHCHECK };
  }
}

function portText(p: PortMapping): string {
  // The host bind address is deliberately not rendered: this card has no
  // redactor, and a LAN bind address would survive privacy mode.
  return p.hostPort == null
    ? `${p.containerPort}/${p.proto} (not published)`
    : `:${p.hostPort}→${p.containerPort}/${p.proto}`;
}

function Row({
  c,
  actionsEnabled,
  onLogs,
  onInspect,
}: {
  c: ContainerInfo;
  actionsEnabled: boolean;
  onLogs: (name: string) => void;
  onInspect: (name: string) => void;
}) {
  const health = healthWord(c);
  const age = c.createdUnix == null ? null : Math.max(0, Date.now() / 1000 - c.createdUnix);
  const published = c.portList.filter((p) => p.hostPort != null);
  return (
    <DataRow
      lead={<Dot state={health.state} title={health.hint} />}
      primary={c.name}
      secondary={c.image}
      value={c.memBytes != null ? fmtBytes(c.memBytes) : undefined}
      valueHint={
        c.memBytes != null
          ? `${fmtBytes(c.memBytes)}${c.memLimitBytes ? ` of ${fmtBytes(c.memLimitBytes)}` : " (no limit set)"}`
          : undefined
      }
      tone={c.health === "unhealthy" ? "warn" : undefined}
      title={[
        c.name,
        c.image,
        c.status,
        health.hint,
        published.length === 0 ? NO_PORTS : published.map(portText).join(", "),
        c.cpuPercent == null ? NO_CPU : `cpu ${c.cpuPercent.toFixed(0)}%`,
        c.memBytes == null ? NO_MEM : `memory ${fmtBytes(c.memBytes)}`,
        c.restartCount == null ? NO_RESTARTS : `restarted ${c.restartCount} time(s) since creation`,
        age == null ? "creation time not reported" : `created ${fmtDuration(age)} ago`,
      ]
        .filter(Boolean)
        .join("\n")}
      onOpen={() => onInspect(c.name)}
      action={{
        icon: "↗",
        label: `View logs for container ${c.name}`,
        hint: actionsEnabled ? `Shows the last 200 log lines from ${c.name}` : ACTIONS_OFF,
        disabled: !actionsEnabled,
        onSelect: () => onLogs(c.name),
      }}
    />
  );
}

export function DockerCardBody({
  status,
  actionsEnabled,
  onLogs,
  onInspect,
}: {
  status: DockerStatus | null;
  actionsEnabled: boolean;
  onLogs: (name: string) => void;
  onInspect: (name: string) => void;
}): JSX.Element {
  const density = useCardDensity();
  const compact = density === "compact";

  if (!status) {
    return <EmptyState reason="no_data" detail="Waiting for the first daemon query." compact={compact} />;
  }
  if (!status.installed) {
    return (
      <EmptyState reason="not_installed" detail="The docker CLI was not found on PATH." compact={compact} />
    );
  }
  if (!status.daemonUp) {
    return (
      <EmptyState
        reason="unavailable"
        detail={
          status.error
            ? maskSecrets(status.error)
            : "Docker is installed but its daemon is not answering — start Docker Desktop."
        }
        compact={compact}
      />
    );
  }
  if (status.containers.length === 0) {
    return (
      <EmptyState
        reason="valid_zero"
        detail="The daemon is up and has no containers."
        compact={compact}
      />
    );
  }

  const running = status.containers.filter((c) => c.state === "running");
  const unhealthy = status.containers.filter((c) => c.health === "unhealthy");

  if (compact) {
    return (
      <div className="stat-grid stat-grid-2">
        <Stat
          value={`${running.length}/${status.containers.length}`}
          label="running"
          hint="Containers in the running state, out of every container the daemon knows"
        />
        <Stat
          value={unhealthy.length}
          label="unhealthy"
          hint={
            unhealthy.length === 0
              ? "No container has a failing healthcheck. Containers without a healthcheck are not counted here."
              : `Failing healthchecks: ${unhealthy.map((c) => c.name).join(", ")}`
          }
          tone={unhealthy.length > 0 ? "var(--bad)" : undefined}
        />
      </div>
    );
  }

  const shown = status.containers.slice(0, rowBudget(density));
  const firstHidden = status.containers[shown.length];
  return (
    <>
      <div className="drow-list">
        {shown.map((c) => (
          <Row
            key={c.id}
            c={c}
            actionsEnabled={actionsEnabled}
            onLogs={onLogs}
            onInspect={onInspect}
          />
        ))}
      </div>
      {firstHidden && (
        <RowOverflow
          hidden={status.containers.length - shown.length}
          noun="containers"
          onOpen={() => onInspect(firstHidden.name)}
        />
      )}
      <div className="proc-footer muted small">
        {running.length} running · {status.containers.length - running.length} stopped
        {!actionsEnabled ? " · actions off" : ""}
      </div>
    </>
  );
}
