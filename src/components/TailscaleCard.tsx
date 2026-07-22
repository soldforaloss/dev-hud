// Tailscale link state.
//
// "Connected" is not one fact: a node relayed through a DERP region is up but
// paying latency for it, and a key three days from expiry is up but about to
// stop being up. Both are said out loud rather than hidden behind a green dot.

import type { JSX } from "react";
import type { TailscalePeer, TailscaleStatus } from "../types";
import type { Redactor } from "../model/privacy";
import { safeText } from "../model/privacy";
import { fmtAgo, fmtCountdown } from "../format";
import { EmptyState, Stat } from "./StatusBits";
import { DataRow } from "./DataRow";
import { rowBudget, useCardDensity } from "./density";
import { Dot } from "./viz";

const NO_HOSTNAME = "this node has not been assigned a hostname in the tailnet";
const NO_IP = "no tailnet address has been assigned yet";
const NO_EXPIRY = "key expiry is not reported (key expiry may be disabled for this node)";
const NO_ROUTES = "this node advertises no subnet routes";
const NO_LAST_SEEN = "this peer has never been seen by the coordination server";

function PeerRow({ peer, redactor }: { peer: TailscalePeer; redactor: Redactor }): JSX.Element {
  const name = redactor.peer(peer.name) ?? peer.name;
  const ip = redactor.ip(peer.ip);
  // Path quality is only meaningful for a peer we can currently reach.
  const path = !peer.online
    ? "offline"
    : peer.direct
      ? "direct"
      : peer.relay
        ? `relay ${peer.relay}`
        : "relay";
  return (
    <DataRow
      lead={<Dot state={peer.online ? (peer.direct ? "good" : "warn") : "off"} title={path} />}
      primary={name}
      secondary={path}
      value={peer.online ? "online" : fmtAgo(peer.lastSeen) || "—"}
      valueHint={peer.lastSeen ? "last seen by the coordination server" : NO_LAST_SEEN}
      title={[
        name,
        ip ?? NO_IP,
        path,
        peer.os ? `operating system: ${peer.os}` : "operating system not reported",
        peer.exitNode ? "offers itself as an exit node" : "does not offer an exit node",
      ].join("\n")}
    />
  );
}

export function TailscaleCardBody({
  status,
  redactor,
}: {
  status: TailscaleStatus | null;
  redactor: Redactor;
}): JSX.Element {
  const density = useCardDensity();
  const compact = density === "compact";
  const expanded = density === "expanded";

  if (!status) {
    return (
      <EmptyState reason="no_data" detail="Waiting for the first `tailscale status`." compact={compact} />
    );
  }
  if (!status.installed) {
    return (
      <EmptyState
        reason="not_installed"
        detail="The tailscale CLI was not found on PATH."
        compact={compact}
      />
    );
  }
  if (status.error) {
    return (
      <EmptyState
        reason="collector_error"
        detail={safeText(redactor, status.error) ?? "tailscale status failed"}
        compact={compact}
      />
    );
  }

  const running = status.state === "Running";
  const dotState = running ? (status.selfDirect ? "good" : "warn") : status.state === "Stopped" ? "off" : "warn";
  const ip = redactor.ip(status.ip);
  const hostname = redactor.host(status.hostname);
  const magicDns = redactor.host(status.magicDns);
  // A relay is a working link, so it is a caveat on "Connected", not a failure.
  const pathLabel = !running
    ? (status.state ?? "Unknown")
    : status.selfDirect
      ? "Connected · direct"
      : status.relay
        ? `Connected · relayed via ${status.relay}`
        : "Connected · relayed";
  const pathHint = status.selfDirect
    ? "Traffic is taking a direct path to peers."
    : "Traffic is going through a DERP relay — expect higher latency than a direct path.";
  const expiry = status.keyExpiryUnix == null ? null : fmtCountdown(status.keyExpiryUnix);
  const expirySoon =
    status.keyExpiryUnix != null && status.keyExpiryUnix - Date.now() / 1000 < 7 * 86_400;

  if (compact) {
    return (
      <>
        <div className="gateway-row">
          <Dot state={dotState} title={pathLabel} />
          <span className="gateway-state" title={running ? pathHint : "tailscaled is not in the Running state"}>
            {pathLabel}
          </span>
        </div>
        <div className="muted small ip-line" title={ip ? "this node's tailnet address" : NO_IP}>
          {ip ?? "—"} · {status.peersOnline}/{status.peersTotal} peers online
        </div>
      </>
    );
  }

  const peers = status.peers.slice(0, rowBudget(density));

  return (
    <>
      <div className="gateway-row">
        <Dot state={dotState} title={pathLabel} />
        <span className="gateway-state" title={running ? pathHint : "tailscaled is not in the Running state"}>
          {pathLabel}
        </span>
      </div>

      <div className="stat-grid stat-grid-2">
        {/* The address used to be a chip in the header row. It belongs to the
            hostname, so it rides with it rather than competing for the line. */}
        <Stat
          value={hostname ?? "—"}
          label={magicDns ? `in ${magicDns}` : "hostname"}
          hint={
            (hostname ? `${hostname}${magicDns ? `.${magicDns}` : ""}` : NO_HOSTNAME) +
            ` — ${ip ?? NO_IP}`
          }
        />
        <Stat
          value={`${status.peersOnline}/${status.peersTotal}`}
          label="peers online"
          hint="Peers reachable now, out of every peer in this tailnet"
        />
        <Stat
          value={status.exitNodeActive ? "on" : "off"}
          label="exit node"
          hint={
            status.exitNodeActive
              ? `All traffic is leaving through ${redactor.peer(status.exitNodeActive)}`
              : "This node is not routing its traffic through an exit node"
          }
          tone={status.exitNodeActive ? "var(--warn)" : undefined}
        />
        <Stat
          value={expiry ?? "—"}
          label="key expires"
          hint={
            status.keyExpiryUnix == null
              ? NO_EXPIRY
              : `The node key stops being accepted in ${expiry} — re-authenticate before then.`
          }
          tone={expirySoon ? "var(--warn)" : undefined}
          freshness={status.keyExpiryUnix == null ? "not_measured" : "live"}
        />
      </div>

      <div className="muted small ip-line" title={status.advertisedRoutes.length === 0 ? NO_ROUTES : "subnet routes this node advertises"}>
        {status.advertisedRoutes.length === 0
          ? "advertises no subnet routes"
          : `advertises ${status.advertisedRoutes
              .map((r) => redactor.ip(r) ?? r)
              .join(", ")}`}
      </div>

      {expanded &&
        (status.peers.length === 0 ? (
          <EmptyState reason="valid_zero" detail="This tailnet has no other devices." compact={compact} />
        ) : (
          <>
            <div className="drow-list">
              {peers.map((p) => (
                <PeerRow key={p.name} peer={p} redactor={redactor} />
              ))}
            </div>
            {status.peers.length > peers.length && (
              <div className="proc-footer muted small">
                {status.peers.length - peers.length} more peer(s) not shown — enlarge the card
              </div>
            )}
          </>
        ))}
    </>
  );
}
