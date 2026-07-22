// Runtime processes (node / bun / deno and friends).
//
// The row used to carry thirteen elements including a "Confirm: Terminate tree
// (5)" button — a control wide enough that the card could not be narrow and
// still show a command line. Terminating is inspector work now: the row
// identifies the process and reports two numbers, and one click opens the
// place that already knows how to kill it safely, and that also holds the
// process tree, the full masked command line and the working directory.

import type { JSX } from "react";
import type { ProcInfo, ProcessesPayload } from "../types";
import type { Redactor } from "../model/privacy";
import { maskSecrets } from "../model/privacy";
import { fmtBytes, fmtDuration } from "../format";
import { EmptyState, Stat } from "./StatusBits";
import { DataRow, RowOverflow } from "./DataRow";
import { Dot } from "./viz";
import { rowBudget, useCardDensity } from "./density";

const NO_CWD = "this process did not report a working directory";
const NO_PPID = "parent pid not reported";
const NO_CMD = "no command line was readable for this process";

function Row({
  p,
  ports,
  redactor,
  onInspect,
  onOpenPort,
}: {
  p: ProcInfo;
  ports: number[];
  redactor: Redactor;
  onInspect: (pid: number, label: string) => void;
  onOpenPort: (port: number) => void;
}) {
  const label = p.label ?? p.name;
  // Secrets are stripped even with privacy mode off; aliasing is the second pass.
  const cmd = redactor.args(maskSecrets(p.cmdSummary));
  const cwd = p.cwd == null ? null : redactor.path(p.cwd);
  const ageSecs = Math.max(0, Date.now() / 1000 - p.startTimeUnix);

  return (
    <DataRow
      lead={
        <Dot
          state={p.orphaned ? "warn" : p.cpuPercent >= 1 ? "good" : "off"}
          title={
            p.orphaned
              ? "orphaned — its parent has exited"
              : p.cpuPercent >= 1
                ? "using CPU now"
                : "idle"
          }
        />
      }
      // The tool name identifies it; the command is the detail that truncates.
      primary={
        <>
          {label}
          {cmd ? <span className="drow-dim"> {cmd}</span> : null}
        </>
      }
      value={fmtBytes(p.memBytes)}
      valueHint={`${fmtBytes(p.memBytes)} resident · ${p.cpuPercent.toFixed(1)}% cpu`}
      tone={p.orphaned ? "warn" : undefined}
      title={[
        label,
        cmd || NO_CMD,
        cwd ?? NO_CWD,
        `pid ${p.pid} · parent ${p.ppid ?? NO_PPID} · up ${fmtDuration(ageSecs)}`,
        ports.length > 0
          ? `listening on ${ports.map((n) => `:${n}`).join(", ")}`
          : "no listening ports",
      ].join("\n")}
      onOpen={() => onInspect(p.pid, label)}
      action={
        ports.length > 0
          ? {
              icon: "↗",
              label: `Open http://localhost:${ports[0]}`,
              hint:
                ports.length > 1
                  ? `Opens :${ports[0]} — this process listens on ${ports.length} ports, all listed in the inspector`
                  : `Opens http://localhost:${ports[0]}`,
              onSelect: () => onOpenPort(ports[0]),
            }
          : undefined
      }
    />
  );
}

export function ProcessesCardBody({
  payload,
  portsByPid,
  redactor,
  onInspect,
  onOpenPort,
}: {
  payload: ProcessesPayload | null;
  portsByPid: Record<number, number[]>;
  redactor: Redactor;
  onInspect: (pid: number, label: string) => void;
  onOpenPort: (port: number) => void;
}): JSX.Element {
  const density = useCardDensity();
  const compact = density === "compact";

  if (!payload) {
    return (
      <EmptyState reason="no_data" detail="Waiting for the first process scan." compact={compact} />
    );
  }
  if (payload.processes.length === 0) {
    return (
      <EmptyState
        reason="valid_zero"
        detail="The scan completed and no node, bun or deno process is running."
        compact={compact}
      />
    );
  }

  const totalMem = payload.processes.reduce((a, p) => a + p.memBytes, 0);
  const orphans = payload.processes.filter((p) => p.orphaned).length;

  if (compact) {
    return (
      <div className="stat-grid stat-grid-2">
        <Stat
          value={payload.processes.length}
          label="processes"
          hint="Matching runtime processes found by the last scan"
        />
        <Stat
          value={orphans}
          label="orphaned"
          hint={
            orphans === 0
              ? "Every process still has a live parent."
              : `${orphans} process(es) whose parent has exited — enlarge the card to act on them.`
          }
          tone={orphans > 0 ? "var(--warn)" : undefined}
        />
      </div>
    );
  }

  const shown = payload.processes.slice(0, rowBudget(density));

  return (
    <>
      <div className="drow-list">
        {shown.map((p) => (
          <Row
            key={`${p.pid}-${p.startTimeUnix}`}
            p={p}
            ports={portsByPid[p.pid] ?? []}
            redactor={redactor}
            onInspect={onInspect}
            onOpenPort={onOpenPort}
          />
        ))}
      </div>
      <RowOverflow
        hidden={payload.processes.length - shown.length}
        noun="processes"
        onOpen={() => onInspect(shown[0]?.pid ?? 0, shown[0]?.label ?? "process")}
      />
      <div className="proc-footer muted small">
        {payload.processes.length} running · {fmtBytes(totalMem)}
        {orphans > 0 ? ` · ${orphans} orphaned` : ""}
      </div>
    </>
  );
}
