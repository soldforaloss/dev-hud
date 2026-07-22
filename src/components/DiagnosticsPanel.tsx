// Read-only preview of the diagnostics export.
//
// The caller builds and redacts the text; this surface exists so the user can
// read exactly what would leave the machine before it reaches the clipboard.

import type { JSX } from "react";

export interface DiagnosticsPanelProps {
  /** The fully-built, already-redacted export. */
  text: string;
  onCopy: () => void;
  onClose: () => void;
}

export function DiagnosticsPanel({ text, onCopy, onClose }: DiagnosticsPanelProps): JSX.Element {
  return (
    <section className="panel" role="region" aria-label="Diagnostics export">
      <header className="panel-head">
        <h2 className="panel-title">Diagnostics export</h2>
        <span className="head-spacer" />
        <button className="btn btn-slim" onClick={onCopy}>
          Copy to clipboard
        </button>
        <button className="icon-btn" onClick={onClose} aria-label="Close diagnostics export">
          ✕
        </button>
      </header>

      <div className="panel-body">
        <p className="muted small">
          Addresses, hostnames, paths, repository names, process arguments and
          session ids are redacted from this export.
        </p>
        {/* tabIndex keeps the scroll region reachable without a mouse. */}
        <pre className="set-diag-pre" tabIndex={0} aria-label="Diagnostics export preview">
          {text}
        </pre>
      </div>
    </section>
  );
}
