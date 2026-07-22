// Redacted diagnostic export.
//
// The whole value of an export is that it can be pasted into an issue, which
// is exactly why it must be safe by construction: it is built from a forced
// redactor, never from the live view, so it cannot accidentally inherit
// "privacy mode happened to be off".

import type { StatusBundle } from "./cardStatus";
import type { CardStatus } from "./cardStatus";
import type { Provenance } from "./provenance";
import { describePollState, formatInterval } from "./provenance";
import type { AlertRecord } from "./alerts";
import type { ActivityEvent } from "./events";
import type { IncidentSnapshot } from "./snapshots";
import type { Settings } from "./settings";
import { Redactor, maskSecrets } from "./privacy";
import { fmtBytes } from "../format";

export interface ExportInput {
  appVersion: string;
  schemaVersion: number;
  bundle: StatusBundle;
  statuses: Record<string, CardStatus>;
  provenance: Record<string, Provenance>;
  alerts: AlertRecord[];
  events: ActivityEvent[];
  settings: Settings;
  snapshot?: IncidentSnapshot;
  nowMs: number;
}

export function buildDiagnosticExport(input: ExportInput): string {
  const r = new Redactor(true);
  const L: string[] = [];
  const line = (s = "") => L.push(s);

  line(`# AI HUD diagnostic export`);
  line(`Generated: ${new Date(input.nowMs).toISOString()}`);
  line(`App version: ${input.appVersion}`);
  line(`Settings schema: v${input.schemaVersion}`);
  line(`Redaction: ON (addresses, hostnames, paths, repository names, arguments)`);
  line();

  line(`## Host summary`);
  const sys = input.bundle.system;
  if (sys) {
    line(`- CPU: ${sys.cpuPercent.toFixed(1)}%`);
    line(`- Memory: ${fmtBytes(sys.memUsed)} of ${fmtBytes(sys.memTotal)}`);
    line(`- Commit: ${fmtBytes(sys.commitUsed)} of ${fmtBytes(sys.commitTotal)}`);
    line(`- Network: ↓${fmtBytes(sys.netRxBps)}/s ↑${fmtBytes(sys.netTxBps)}/s`);
    line(`- LAN: ${r.ip(sys.localIp) ?? "—"} · WAN: ${r.ip(sys.publicIp) ?? "—"}`);
  } else {
    line(`- not collected`);
  }
  const up = input.bundle.uptime;
  if (up) {
    line(`- Uptime: ${Math.round(up.uptimeSecs / 3600)}h · reboot pending: ${up.rebootPending ? up.reasons.join("; ") || "yes" : "no"}`);
  }
  line();

  line(`## Card status`);
  for (const [id, s] of Object.entries(input.statuses)) {
    line(
      `- ${id}: health=${s.health} attention=${s.attention} freshness=${s.freshness}` +
        (s.statusDetail ? ` — ${r.text(maskSecrets(s.statusDetail))}` : ""),
    );
  }
  line();

  line(`## Collectors`);
  for (const [id, p] of Object.entries(input.provenance)) {
    line(
      `- ${id} (${p.command}): ${describePollState(p)}; every ${formatInterval(p.intervalMs)}; ` +
        `last ${p.lastDurationMs ?? "—"} ms; ${p.successCount} ok / ${p.failureCount} failed` +
        (p.lastError ? `; error: ${r.text(maskSecrets(p.lastError))}` : ""),
    );
  }
  line();

  const open = input.alerts.filter((a) => a.state !== "recovered" && a.armed);
  line(`## Alerts (${open.length} open, ${input.alerts.length} total)`);
  for (const a of input.alerts.slice(0, 40)) {
    line(
      `- [${a.severity}/${a.state}] ${r.text(a.title)} — first ${a.firstSeenAt}, last ${a.lastSeenAt}` +
        (a.recoveredAt ? `, recovered ${a.recoveredAt}` : "") +
        (a.currentValue != null ? `, value ${String(a.currentValue)}` : "") +
        (a.threshold != null ? `, threshold ${String(a.threshold)}` : ""),
    );
  }
  line();

  line(`## Recent events`);
  for (const e of input.events.slice(0, 60)) {
    line(`- ${e.timestamp} [${e.category}/${e.severity}] ${r.text(e.title)}`);
  }
  line();

  line(`## Configuration (no secrets)`);
  const s = input.settings;
  line(`- layering=${s.layering} background=${s.background} opacity=${s.bgOpacity ?? "default"}`);
  line(`- privacy=${s.privacy} actionsEnabled=${s.actionsEnabled} timeRange=${s.timeRange}`);
  line(`- hiddenSlowdown=${s.hiddenSlowdown}× pauseExpensiveOnBattery=${s.pauseExpensiveOnBattery}`);
  line(`- retention: ${JSON.stringify(s.retention)}`);
  line(`- alerts.master=${s.alerts.master} quietHours=${JSON.stringify(s.alerts.quietHours)}`);
  line(
    `- card modes: ${Object.entries(s.utilities)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ") || "all auto"}`,
  );
  line(`- poll overrides: ${JSON.stringify(s.pollIntervals)}`);
  line(`- repository folders: ${s.repoRoots.length} configured (paths redacted)`);
  line(`- custom cards: ${s.customCards.length}`);
  line();

  if (input.snapshot) {
    line(`## Incident snapshot — ${input.snapshot.reason}`);
    line("```json");
    line(JSON.stringify(input.snapshot.data, null, 2));
    line("```");
  }

  return L.join("\n");
}
