// Renderer for user-defined cards.
//
// The payload comes from a user's own command or endpoint, so nothing here
// interprets it as markup: every string is placed as a text node and the
// backend has already stripped control characters and angle brackets. There is
// deliberately no HTML escape hatch.

import type { CustomCardResult } from "../types";
import type { AttentionState } from "../model/status";
import { EmptyState, Stat } from "./StatusBits";
import { useCardDensity } from "./density";

/** The contract's `status` maps onto the same attention scale as every card. */
export function customAttention(result: CustomCardResult | null): AttentionState {
  const status = result?.payload?.status;
  return status === "critical" ? "critical" : status === "warning" ? "warning" : "normal";
}

export function CustomCardBody({
  result,
  title,
  onRefresh,
}: {
  result: CustomCardResult | null;
  title: string;
  onRefresh: () => void;
}) {
  const density = useCardDensity();

  if (!result) {
    return <EmptyState reason="no_data" detail={`Waiting for the first run of "${title}".`} />;
  }
  if (!result.ok || !result.payload) {
    return (
      <EmptyState
        reason="collector_error"
        detail={result.error ?? "The source returned nothing usable."}
        actions={[{ label: "Run now", onSelect: onRefresh }]}
      />
    );
  }

  const { payload } = result;
  const shown = density === "compact" ? payload.metrics.slice(0, 2) : payload.metrics;

  return (
    <>
      <div className="stat-grid">
        {shown.map((m, i) => (
          <Stat
            key={`${m.label}-${i}`}
            value={`${m.value}${m.unit ? ` ${m.unit}` : ""}`}
            label={m.label}
          />
        ))}
      </div>
      {payload.metrics.length === 0 && (
        <EmptyState reason="valid_zero" detail="This card reported no metrics." />
      )}
      {payload.message && density !== "compact" ? (
        <div className="muted small">{payload.message}</div>
      ) : null}
      {density === "expanded" && (
        <div className="muted small ip-line">
          schema v{payload.schemaVersion} · ran in {result.durationMs} ms ·{" "}
          {new Date(result.atUnix * 1000).toLocaleTimeString()}
        </div>
      )}
    </>
  );
}
