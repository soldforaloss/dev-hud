// Settings panel — every persisted preference, grouped behind tabs.
//
// The panel outgrew a single scroll once alerts gained tiers and cards gained
// per-card polling, so each concern gets its own tab. Nothing here owns state
// that matters: every write is a shallow `onChange` patch and the caller stays
// the single owner of persistence.

import { useRef, useState } from "react";
import type { JSX, ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CARD_IDS } from "../types";
import type { ThermalsSetupResult, UtilMode } from "../types";
import { BUILTIN_PROFILE_PRESETS } from "../model/settings";
import type {
  AlertRules,
  BoolRule,
  CustomCardDef,
  CustomCardKind,
  RetentionSettings,
  Settings,
  ThresholdRule,
} from "../model/settings";

const MODES: UtilMode[] = ["auto", "on", "off"];

type Tab = "appearance" | "cards" | "polling" | "alerts" | "privacy" | "advanced";

const TABS: [Tab, string][] = [
  ["appearance", "Appearance"],
  ["cards", "Cards"],
  ["polling", "Polling"],
  ["alerts", "Alerts"],
  ["privacy", "Privacy & profiles"],
  ["advanced", "Advanced"],
];

type ThresholdKey = "gpuTemp" | "cpuTemp" | "ram" | "diskFree" | "packetLoss" | "latency";
type BoolKey = "gatewayDown" | "orphanProcs" | "collectorStale";
type FlagKey = "newRelease" | "wanChange" | "networkAndGateway";

const THRESHOLD_RULES: [ThresholdKey, string, string][] = [
  ["gpuTemp", "GPU temperature", "°C"],
  ["cpuTemp", "CPU temperature", "°C"],
  ["ram", "RAM used", "%"],
  ["diskFree", "Disk free", "%"],
  ["packetLoss", "Packet loss", "%"],
  ["latency", "Latency", "ms"],
];

const BOOL_RULES: [BoolKey, string][] = [
  ["gatewayDown", "OpenClaw gateway down"],
  ["orphanProcs", "Orphaned processes lingering"],
  ["collectorStale", "A collector stopped reporting"],
];

const FLAG_RULES: [FlagKey, string][] = [
  ["newRelease", "New release on my repos"],
  ["wanChange", "Public IP changed"],
  ["networkAndGateway", "Packet loss and the gateway unhealthy together"],
];

/** Poll intervals are stored in ms; 1 s–24 h is the range the UI accepts. */
const MIN_INTERVAL_S = 1;
const MAX_INTERVAL_S = 86_400;

const HOURS = Array.from({ length: 24 }, (_, i) => i);

export interface SettingsPanelProps {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  onClose: () => void;
  thermalsTier: string | null;
  /** Card id → the plain-language reason it is currently shown or hidden. */
  autoReasons: Record<string, string>;
  /** Card id → collector dependency/permission diagnosis, may be empty. */
  collectorNotes: Record<string, string>;
  /** Built-in poll cadence per card id, in ms — shown as the override placeholder. */
  defaultIntervals?: Record<string, number>;
  onResetCard: (id: string) => void;
  onResetAllCards: () => void;
  onSaveProfile: (name: string) => void;
  onApplyProfile: (name: string) => void;
  onDeleteProfile: (name: string) => void;
  onExportProfiles: () => void;
  onImportProfiles: () => void;
  onExportDiagnostics: () => void;
}

export function SettingsPanel({
  settings,
  onChange,
  onClose,
  thermalsTier,
  autoReasons,
  collectorNotes,
  defaultIntervals,
  onResetCard,
  onResetAllCards,
  onSaveProfile,
  onApplyProfile,
  onDeleteProfile,
  onExportProfiles,
  onImportProfiles,
  onExportDiagnostics,
}: SettingsPanelProps): JSX.Element {
  const [tab, setTab] = useState<Tab>("appearance");
  const alerts = settings.alerts;

  const patchAlerts = (patch: Partial<AlertRules>) => onChange({ alerts: { ...alerts, ...patch } });
  // Computed keys widen to `string`, so each patch needs the cast back.
  const patchRule = (key: ThresholdKey, patch: Partial<ThresholdRule>) =>
    patchAlerts({ [key]: { ...alerts[key], ...patch } } as Partial<AlertRules>);
  const patchBool = (key: BoolKey, patch: Partial<BoolRule>) =>
    patchAlerts({ [key]: { ...alerts[key], ...patch } } as Partial<AlertRules>);
  const patchFlag = (key: FlagKey, on: boolean) =>
    patchAlerts({ [key]: { on } } as Partial<AlertRules>);
  const patchRetention = (patch: Partial<RetentionSettings>) =>
    onChange({ retention: { ...settings.retention, ...patch } });

  const effOpacity = settings.bgOpacity ?? (settings.background === "acrylic" ? 55 : 97);
  const activeTabLabel = TABS.find(([id]) => id === tab)?.[1] ?? "";

  return (
    <div className="settings">
      <div className="settings-head">
        <span className="card-title">Settings</span>
        <button className="icon-btn" onClick={onClose} title="Close" aria-label="Close settings">
          ✕
        </button>
      </div>

      <div className="set-tabs" role="tablist" aria-label="Settings sections">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            className={`set-tab${tab === id ? " set-tab-on" : ""}`}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="settings-grid" role="tabpanel" aria-label={activeTabLabel}>
        {tab === "appearance" && (
          <AppearanceTab settings={settings} onChange={onChange} effOpacity={effOpacity} />
        )}

        {tab === "cards" && (
          <CardsTab
            settings={settings}
            onChange={onChange}
            autoReasons={autoReasons}
            collectorNotes={collectorNotes}
            onResetCard={onResetCard}
            onResetAllCards={onResetAllCards}
          />
        )}

        {tab === "polling" && (
          <PollingTab settings={settings} onChange={onChange} defaultIntervals={defaultIntervals} />
        )}

        {tab === "alerts" && (
          <AlertsTab
            settings={settings}
            onChange={onChange}
            patchAlerts={patchAlerts}
            patchRule={patchRule}
            patchBool={patchBool}
            patchFlag={patchFlag}
          />
        )}

        {tab === "privacy" && (
          <PrivacyTab
            settings={settings}
            onChange={onChange}
            onSaveProfile={onSaveProfile}
            onApplyProfile={onApplyProfile}
            onDeleteProfile={onDeleteProfile}
            onExportProfiles={onExportProfiles}
            onImportProfiles={onImportProfiles}
            onExportDiagnostics={onExportDiagnostics}
          />
        )}

        {tab === "advanced" && (
          <AdvancedTab
            settings={settings}
            onChange={onChange}
            patchRetention={patchRetention}
            thermalsTier={thermalsTier}
          />
        )}
      </div>
    </div>
  );
}

// ---------- tabs ----------

function AppearanceTab({
  settings,
  onChange,
  effOpacity,
}: {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  effOpacity: number;
}) {
  return (
    <Group title="Widget">
      <label className="field">
        <span>Layering</span>
        <select
          value={settings.layering}
          onChange={(e) => onChange({ layering: e.target.value as Settings["layering"] })}
        >
          <option value="desktop">Pinned to desktop</option>
          <option value="normal">Normal window</option>
          <option value="top">Always on top</option>
        </select>
      </label>
      <label className="field">
        <span>Launch position</span>
        <select
          value={settings.launchMode}
          onChange={(e) => onChange({ launchMode: e.target.value as Settings["launchMode"] })}
        >
          <option value="remember">Remember last spot</option>
          <option value="center">Pin top-center</option>
        </select>
      </label>
      <label className="field">
        <span>Background</span>
        <select
          value={settings.background}
          onChange={(e) => onChange({ background: e.target.value as Settings["background"] })}
        >
          <option value="acrylic">Acrylic glass</option>
          <option value="solid">Solid</option>
        </select>
      </label>
      <label className="field field-col">
        <span>
          Opacity <span className="muted small">({effOpacity}%)</span>
        </span>
        <input
          type="range"
          min={15}
          max={100}
          step={5}
          value={effOpacity}
          onChange={(e) => onChange({ bgOpacity: Number(e.target.value) })}
        />
      </label>
      <Check
        checked={settings.locked}
        onChange={(v) => onChange({ locked: v })}
        label="Lock position & card layout"
      />
      <Check
        checked={settings.autostart}
        onChange={(v) => onChange({ autostart: v })}
        label="Start with Windows"
      />
      <div className="muted small">
        Size persists across launches. Drag cards by their ⠿ grip to rearrange;
        drag the ◢ corner to resize (double-click it to reset). Resized cards
        still shrink responsively — the size is a cap.
      </div>
    </Group>
  );
}

function CardsTab({
  settings,
  onChange,
  autoReasons,
  collectorNotes,
  onResetCard,
  onResetAllCards,
}: {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  autoReasons: Record<string, string>;
  collectorNotes: Record<string, string>;
  onResetCard: (id: string) => void;
  onResetAllCards: () => void;
}) {
  return (
    <Group title="Cards">
      <div className="muted small">
        auto = shown only when detected. off = hidden and never polled.
      </div>
      {CARD_IDS.map(([id, label]) => {
        const reason = autoReasons[id];
        const note = collectorNotes[id];
        return (
          <div className="set-card" key={id}>
            <div className="mode-row">
              <span className="mode-label">{label}</span>
              <ModeSeg
                label={label}
                value={settings.utilities[id] ?? "auto"}
                onChange={(m) => onChange({ utilities: { ...settings.utilities, [id]: m } })}
              />
            </div>
            {reason ? <div className="muted small">{reason}</div> : null}
            {note ? <div className="set-note">{note}</div> : null}
            <div className="btn-row">
              <button className="btn btn-slim" onClick={() => onResetCard(id)}>
                Reset size &amp; position
              </button>
              <Check
                checked={!settings.cardActionsDisabled[id]}
                onChange={(v) =>
                  onChange({
                    cardActionsDisabled: { ...settings.cardActionsDisabled, [id]: !v },
                  })
                }
                label="Actions"
                ariaLabel={`Enable actions on ${label}`}
              />
            </div>
          </div>
        );
      })}
      <div className="btn-row">
        <button className="btn" onClick={onResetAllCards}>
          Reset all cards
        </button>
      </div>
    </Group>
  );
}

function PollingTab({
  settings,
  onChange,
  defaultIntervals,
}: {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  defaultIntervals?: Record<string, number>;
}) {
  const setPollInterval = (id: string, secs: number) =>
    onChange({ pollIntervals: { ...settings.pollIntervals, [id]: secs * 1000 } });
  const clearPollInterval = (id: string) => {
    const next = { ...settings.pollIntervals };
    delete next[id];
    onChange({ pollIntervals: next });
  };

  return (
    <>
      <Group title="Per-card interval">
        <div className="muted small">
          Blank means the card's built-in cadence. Overrides are capped at 24 h.
        </div>
        {CARD_IDS.map(([id, label]) => {
          const override = settings.pollIntervals[id];
          const builtIn = defaultIntervals?.[id];
          return (
            <div className="set-row" key={id}>
              <span className="mode-label">{label}</span>
              <NumInput
                label="every"
                ariaLabel={`${label} poll interval in seconds`}
                value={override === undefined ? null : Math.round(override / 1000)}
                min={MIN_INTERVAL_S}
                max={MAX_INTERVAL_S}
                unit="s"
                placeholder={builtIn === undefined ? "—" : String(Math.round(builtIn / 1000))}
                onCommit={(n) => setPollInterval(id, n)}
              />
              <button
                className="btn btn-slim"
                disabled={override === undefined}
                onClick={() => clearPollInterval(id)}
              >
                use default
              </button>
            </div>
          );
        })}
      </Group>

      <Group title="Throttling">
        <label className="field">
          <span>Slow polling to … while the HUD is hidden</span>
          <select
            value={String(settings.hiddenSlowdown)}
            onChange={(e) => onChange({ hiddenSlowdown: Number(e.target.value) })}
          >
            <option value="1">1× (no slowdown)</option>
            <option value="2">2×</option>
            <option value="4">4×</option>
            <option value="8">8×</option>
          </select>
        </label>
        <Check
          checked={settings.pauseExpensiveOnBattery}
          onChange={(v) => onChange({ pauseExpensiveOnBattery: v })}
          label="Pause bandwidth- and CPU-heavy collectors while on battery"
        />
      </Group>
    </>
  );
}

function AlertsTab({
  settings,
  onChange,
  patchAlerts,
  patchRule,
  patchBool,
  patchFlag,
}: {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  patchAlerts: (patch: Partial<AlertRules>) => void;
  patchRule: (key: ThresholdKey, patch: Partial<ThresholdRule>) => void;
  patchBool: (key: BoolKey, patch: Partial<BoolRule>) => void;
  patchFlag: (key: FlagKey, on: boolean) => void;
}) {
  const alerts = settings.alerts;
  const quiet = alerts.quietHours;

  return (
    <>
      <Group title="Delivery">
        <Check
          checked={alerts.master}
          onChange={(v) => patchAlerts({ master: v })}
          label="Enable toast notifications"
        />
        <Check
          checked={quiet.on}
          onChange={(v) => patchAlerts({ quietHours: { ...quiet, on: v } })}
          label="Quiet hours"
        />
        <div className="set-row">
          <label className="set-field">
            <span className="muted small">from</span>
            <select
              aria-label="Quiet hours start"
              value={String(quiet.startHour)}
              onChange={(e) =>
                patchAlerts({ quietHours: { ...quiet, startHour: Number(e.target.value) } })
              }
            >
              {HOURS.map((h) => (
                <option key={h} value={h}>
                  {pad2(h)}:00
                </option>
              ))}
            </select>
          </label>
          <label className="set-field">
            <span className="muted small">to</span>
            <select
              aria-label="Quiet hours end"
              value={String(quiet.endHour)}
              onChange={(e) =>
                patchAlerts({ quietHours: { ...quiet, endHour: Number(e.target.value) } })
              }
            >
              {HOURS.map((h) => (
                <option key={h} value={h}>
                  {pad2(h)}:00
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="muted small">Critical alerts are delivered during quiet hours anyway.</div>
        <Check
          checked={settings.autoSnapshot}
          onChange={(v) => onChange({ autoSnapshot: v })}
          label="Capture an incident snapshot when a critical alert opens"
        />
      </Group>

      <Group title="Thresholds">
        {THRESHOLD_RULES.map(([key, label, unit]) => {
          const rule = alerts[key];
          // Free-space style rules invert the comparison, so the captions flip too.
          const worse = rule.higherIsWorse ? "above" : "below";
          const better = rule.higherIsWorse ? "below" : "above";
          return (
            <div className="set-rule" key={key}>
              <Check
                checked={rule.on}
                onChange={(v) => patchRule(key, { on: v })}
                label={label}
                ariaLabel={`Alert on ${label}`}
              />
              <div className="set-fields">
                <NumInput
                  label={`warn ${worse}`}
                  ariaLabel={`${label} warning threshold`}
                  value={rule.warn}
                  min={0}
                  max={100_000}
                  unit={unit}
                  onCommit={(n) => patchRule(key, { warn: n })}
                />
                <NumInput
                  label={`critical ${worse}`}
                  ariaLabel={`${label} critical threshold`}
                  value={rule.critical}
                  min={0}
                  max={100_000}
                  unit={unit}
                  onCommit={(n) => patchRule(key, { critical: n })}
                />
                <NumInput
                  label="sustain"
                  ariaLabel={`${label} sustain before firing, seconds`}
                  value={rule.sustainSecs}
                  min={0}
                  max={86_400}
                  unit="s"
                  onCommit={(n) => patchRule(key, { sustainSecs: n })}
                />
                <NumInput
                  label={`recover ${better}`}
                  ariaLabel={`${label} recovery threshold`}
                  value={rule.recoverAt}
                  min={0}
                  max={100_000}
                  unit={unit}
                  onCommit={(n) => patchRule(key, { recoverAt: n })}
                />
                <NumInput
                  label="recover for"
                  ariaLabel={`${label} recovery dwell, seconds`}
                  value={rule.recoverSecs}
                  min={0}
                  max={86_400}
                  unit="s"
                  onCommit={(n) => patchRule(key, { recoverSecs: n })}
                />
                <NumInput
                  label="cooldown"
                  ariaLabel={`${label} re-notification cooldown, minutes`}
                  value={Math.round(rule.cooldownSecs / 60)}
                  min={0}
                  max={1_440}
                  unit="min"
                  onCommit={(n) => patchRule(key, { cooldownSecs: n * 60 })}
                />
              </div>
            </div>
          );
        })}
      </Group>

      <Group title="Conditions">
        {BOOL_RULES.map(([key, label]) => {
          const rule = alerts[key];
          return (
            <div className="set-rule" key={key}>
              <Check
                checked={rule.on}
                onChange={(v) => patchBool(key, { on: v })}
                label={label}
                ariaLabel={`Alert on ${label}`}
              />
              <div className="set-fields">
                <NumInput
                  label="sustain"
                  ariaLabel={`${label} sustain before firing, seconds`}
                  value={rule.sustainSecs}
                  min={0}
                  max={86_400}
                  unit="s"
                  onCommit={(n) => patchBool(key, { sustainSecs: n })}
                />
                <NumInput
                  label="cooldown"
                  ariaLabel={`${label} re-notification cooldown, minutes`}
                  value={Math.round(rule.cooldownSecs / 60)}
                  min={0}
                  max={1_440}
                  unit="min"
                  onCommit={(n) => patchBool(key, { cooldownSecs: n * 60 })}
                />
              </div>
            </div>
          );
        })}
        {FLAG_RULES.map(([key, label]) => (
          <Check
            key={key}
            checked={alerts[key].on}
            onChange={(v) => patchFlag(key, v)}
            label={label}
          />
        ))}
      </Group>
    </>
  );
}

function PrivacyTab({
  settings,
  onChange,
  onSaveProfile,
  onApplyProfile,
  onDeleteProfile,
  onExportProfiles,
  onImportProfiles,
  onExportDiagnostics,
}: {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  onSaveProfile: (name: string) => void;
  onApplyProfile: (name: string) => void;
  onDeleteProfile: (name: string) => void;
  onExportProfiles: () => void;
  onImportProfiles: () => void;
  onExportDiagnostics: () => void;
}) {
  const [draft, setDraft] = useState("");
  const names = Object.keys(settings.profiles);
  const trimmed = draft.trim();

  return (
    <>
      <Group title="Privacy">
        <Check
          checked={settings.privacy}
          onChange={(v) => onChange({ privacy: v })}
          label="Redact identifying detail"
        />
        <div className="muted small">
          Replaces IP addresses, hostnames, file paths, repository names, process
          arguments and session ids with placeholders everywhere they appear:
          cards, inspectors, alerts, the timeline, copied text and exports.
        </div>
      </Group>

      <Group title="Profiles">
        {names.length === 0 ? (
          <div className="muted small">No saved profiles yet.</div>
        ) : (
          names.map((name) => (
            <div className="set-row" key={name}>
              <span className="mode-label">{name}</span>
              {settings.activeProfile === name ? <span className="chip">active</span> : null}
              <button className="btn btn-slim" onClick={() => onApplyProfile(name)}>
                Apply
              </button>
              <button className="btn btn-slim" onClick={() => onDeleteProfile(name)}>
                Delete
              </button>
            </div>
          ))
        )}
        <div className="set-row">
          <label className="set-field">
            <span className="muted small">Profile name</span>
            <input
              className="num"
              value={draft}
              placeholder="Focus mode"
              onChange={(e) => setDraft(e.target.value)}
            />
          </label>
          <button
            className="btn btn-slim"
            disabled={trimmed === ""}
            onClick={() => {
              onSaveProfile(trimmed);
              setDraft("");
            }}
          >
            Save current layout as profile
          </button>
        </div>
        <div className="settings-section">Presets</div>
        <div className="btn-row">
          {Object.keys(BUILTIN_PROFILE_PRESETS).map((name) => (
            <button key={name} className="btn btn-slim" onClick={() => onApplyProfile(name)}>
              {name}
            </button>
          ))}
        </div>
        <div className="btn-row">
          <button className="btn btn-slim" onClick={onExportProfiles}>
            Export profiles
          </button>
          <button className="btn btn-slim" onClick={onImportProfiles}>
            Import profiles
          </button>
        </div>
      </Group>

      <Group title="Diagnostics">
        <div className="muted small">
          Bundles versions, collector status and recent errors for a bug report.
          Identifying detail is redacted regardless of the setting above.
        </div>
        <div className="btn-row">
          <button className="btn" onClick={onExportDiagnostics}>
            Export redacted diagnostics
          </button>
        </div>
      </Group>
    </>
  );
}

function AdvancedTab({
  settings,
  onChange,
  patchRetention,
  thermalsTier,
}: {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  patchRetention: (patch: Partial<RetentionSettings>) => void;
  thermalsTier: string | null;
}) {
  const [rootDraft, setRootDraft] = useState("");
  const retention = settings.retention;

  const addRoot = () => {
    const v = rootDraft.trim();
    if (v === "" || settings.repoRoots.includes(v)) return;
    onChange({ repoRoots: [...settings.repoRoots, v] });
    setRootDraft("");
  };

  return (
    <>
      <Group title="Retention">
        <div className="muted small">Oldest records are pruned first once a cap is hit.</div>
        <div className="set-fields">
          <NumInput
            label="Timeline events"
            value={retention.events}
            min={0}
            max={100_000}
            onCommit={(n) => patchRetention({ events: n })}
          />
          <NumInput
            label="Alerts"
            value={retention.alerts}
            min={0}
            max={100_000}
            onCommit={(n) => patchRetention({ alerts: n })}
          />
          <NumInput
            label="Snapshots"
            value={retention.snapshots}
            min={0}
            max={1_000}
            onCommit={(n) => patchRetention({ snapshots: n })}
          />
          <NumInput
            label="Snapshot budget"
            value={Math.round(retention.snapshotBytes / 1_000_000)}
            min={1}
            max={1_000}
            unit="MB"
            onCommit={(n) => patchRetention({ snapshotBytes: n * 1_000_000 })}
          />
          <NumInput
            label="History points"
            value={retention.historyPoints}
            min={10}
            max={100_000}
            onCommit={(n) => patchRetention({ historyPoints: n })}
          />
        </div>
      </Group>

      <Group title="Display & actions">
        <label className="field">
          <span>Temperature unit</span>
          <select
            value={settings.tempUnit}
            onChange={(e) => onChange({ tempUnit: e.target.value as Settings["tempUnit"] })}
          >
            <option value="c">Celsius (°C)</option>
            <option value="f">Fahrenheit (°F)</option>
          </select>
        </label>
        <Check
          checked={settings.actionsEnabled}
          onChange={(v) => onChange({ actionsEnabled: v })}
          label="Allow state-changing actions"
        />
        <div className="set-note">
          Off disables every action that changes machine state — killing
          processes, restarting containers, running tests — on every card,
          regardless of the per-card toggles.
        </div>
      </Group>

      <Group title="Repository roots">
        <div className="muted small">Folders scanned for git working copies.</div>
        {settings.repoRoots.length === 0 ? (
          <div className="muted small">No roots configured.</div>
        ) : (
          settings.repoRoots.map((root) => (
            <div className="set-row" key={root}>
              <span className="mode-label">{root}</span>
              <button
                className="btn btn-slim"
                aria-label={`Remove ${root}`}
                onClick={() => onChange({ repoRoots: settings.repoRoots.filter((r) => r !== root) })}
              >
                Remove
              </button>
            </div>
          ))
        )}
        <div className="set-row">
          <label className="set-field">
            <span className="muted small">Add folder</span>
            <input
              className="num"
              value={rootDraft}
              placeholder="C:\\Users\\me\\Projects"
              onChange={(e) => setRootDraft(e.target.value)}
            />
          </label>
          <button
            className="btn btn-slim"
            disabled={rootDraft.trim() === "" || settings.repoRoots.includes(rootDraft.trim())}
            onClick={addRoot}
          >
            Add
          </button>
        </div>
      </Group>

      <CustomCardsGroup settings={settings} onChange={onChange} />

      <ThermalsGroup settings={settings} onChange={onChange} thermalsTier={thermalsTier} />

      <Group title="Connections">
        <label className="field">
          <span>Ping host</span>
          <input
            className="num"
            value={settings.pingHost}
            onChange={(e) => onChange({ pingHost: e.target.value })}
          />
        </label>
        <NumInput
          label="Ollama port"
          value={settings.ollamaPort}
          min={1}
          max={65_535}
          onCommit={(n) => onChange({ ollamaPort: n })}
        />
        <div className="muted small">
          Repos come from your gh CLI account automatically. Close hides to tray;
          quit from the tray menu.
        </div>
        <div className="muted small">Settings schema version {settings.schemaVersion}</div>
      </Group>
    </>
  );
}

// ---------- advanced sub-groups ----------

function CustomCardsGroup({
  settings,
  onChange,
}: {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
}) {
  // Monotonic counter rather than a clock/random id: render must stay pure and
  // ids must survive a re-render without changing.
  const counter = useRef(settings.customCards.length);

  const patchCard = (id: string, patch: Partial<CustomCardDef>) =>
    onChange({
      customCards: settings.customCards.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    });

  const addCard = () => {
    const title = "New card";
    let id = "";
    do {
      counter.current += 1;
      id = `custom-${counter.current}-${slug(title)}`;
    } while (settings.customCards.some((c) => c.id === id));
    onChange({
      customCards: [
        ...settings.customCards,
        {
          id,
          title,
          kind: "command",
          target: "",
          args: [],
          intervalMs: 60_000,
          timeoutMs: 5_000,
          maxBytes: 64_000,
          enabled: false,
        },
      ],
    });
  };

  return (
    <Group title="Custom cards">
      <div className="set-note">
        Commands run with the arguments exactly as listed and are never passed
        through a shell. http cards only accept loopback URLs.
      </div>
      {settings.customCards.map((c) => (
        <div className="set-custom" key={c.id}>
          <label className="field">
            <span>Title</span>
            <input
              className="num"
              value={c.title}
              onChange={(e) => patchCard(c.id, { title: e.target.value })}
            />
          </label>
          <label className="field">
            <span>Kind</span>
            <select
              value={c.kind}
              onChange={(e) => patchCard(c.id, { kind: e.target.value as CustomCardKind })}
            >
              <option value="command">command</option>
              <option value="http">http</option>
              <option value="file">file</option>
            </select>
          </label>
          <label className="field">
            <span>{targetLabel(c.kind)}</span>
            <input
              className="num"
              value={c.target}
              onChange={(e) => patchCard(c.id, { target: e.target.value })}
            />
          </label>
          <label className="field">
            <span>Arguments</span>
            <input
              className="num"
              value={c.args.join(", ")}
              placeholder="--json, --fast"
              disabled={c.kind !== "command"}
              onChange={(e) => patchCard(c.id, { args: parseArgs(e.target.value) })}
            />
          </label>
          <div className="set-fields">
            <NumInput
              label="interval"
              ariaLabel={`${c.title} interval, seconds`}
              value={Math.round(c.intervalMs / 1000)}
              min={MIN_INTERVAL_S}
              max={MAX_INTERVAL_S}
              unit="s"
              onCommit={(n) => patchCard(c.id, { intervalMs: n * 1000 })}
            />
            <NumInput
              label="timeout"
              ariaLabel={`${c.title} timeout, milliseconds`}
              value={c.timeoutMs}
              min={100}
              max={120_000}
              unit="ms"
              onCommit={(n) => patchCard(c.id, { timeoutMs: n })}
            />
            <NumInput
              label="max payload"
              ariaLabel={`${c.title} maximum payload, bytes`}
              value={c.maxBytes}
              min={256}
              max={10_000_000}
              unit="bytes"
              onCommit={(n) => patchCard(c.id, { maxBytes: n })}
            />
          </div>
          <div className="btn-row">
            <Check
              checked={c.enabled}
              onChange={(v) => patchCard(c.id, { enabled: v })}
              label="Enabled"
              ariaLabel={`Enable ${c.title}`}
            />
            <button
              className="btn btn-slim"
              aria-label={`Remove ${c.title}`}
              onClick={() =>
                onChange({ customCards: settings.customCards.filter((x) => x.id !== c.id) })
              }
            >
              Remove
            </button>
          </div>
        </div>
      ))}
      <div className="btn-row">
        <button className="btn" onClick={addCard}>
          Add custom card
        </button>
      </div>
    </Group>
  );
}

function ThermalsGroup({
  settings,
  onChange,
  thermalsTier,
}: {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  thermalsTier: string | null;
}) {
  const [setupBusy, setSetupBusy] = useState(false);
  const [setupMsg, setSetupMsg] = useState<string | null>(null);
  const runThermalsSetup = () => {
    setSetupBusy(true);
    setSetupMsg("Working — approve the UAC prompt when it appears…");
    void invoke<ThermalsSetupResult>("setup_thermals", { lhmPort: settings.lhmPort })
      .then((r) => {
        const steps = [
          r.installedNow ? "installed via winget" : null,
          r.configSeeded ? "config seeded" : null,
          r.launched ? "started elevated" : null,
          r.taskRegistered ? "logon task registered" : null,
        ].filter(Boolean);
        setSetupMsg(`${r.live ? "✓ " : ""}${r.message}${steps.length ? ` (${steps.join(", ")})` : ""}`);
      })
      .catch((e) => setSetupMsg(String(e)))
      .finally(() => setSetupBusy(false));
  };

  return (
    <Group title="CPU thermals">
      <div className="muted small">
        Status:{" "}
        {thermalsTier === "lhm"
          ? "full telemetry via LibreHardwareMonitor ✓"
          : thermalsTier === "wmi"
            ? "basic (ACPI zone). For package + per-core temps and fans:"
            : "no sensor readable. Windows doesn't expose CPU temps to apps — LibreHardwareMonitor (free, open source) bridges that:"}
      </div>
      {thermalsTier !== "lhm" && (
        <>
          <div className="btn-row">
            <button className="btn" onClick={runThermalsSetup} disabled={setupBusy}>
              {setupBusy ? "Setting up…" : "Set up automatically"}
            </button>
          </div>
          <div className="muted small">
            One click: installs LibreHardwareMonitor from winget (official
            source), enables its web server on the port below, starts it with
            admin rights (one UAC prompt), and registers it to start at logon.
          </div>
          {setupMsg && <div className="small setup-msg">{setupMsg}</div>}
          <details className="manual-steps">
            <summary className="muted small">manual steps instead</summary>
            <ol className="wizard">
              <li>
                Install:{" "}
                <input
                  className="cmd-copy"
                  readOnly
                  aria-label="winget install command"
                  value="winget install LibreHardwareMonitor.LibreHardwareMonitor"
                  onFocus={(e) => e.currentTarget.select()}
                />
              </li>
              <li>Open LibreHardwareMonitor → Options → Remote Web Server → Run</li>
              <li>Optional: Options → Run at startup</li>
            </ol>
          </details>
        </>
      )}
      <NumInput
        label="LHM web server port"
        value={settings.lhmPort}
        min={1}
        max={65_535}
        onCommit={(n) => onChange({ lhmPort: n })}
      />
    </Group>
  );
}

// ---------- shared controls ----------

function ModeSeg({
  label,
  value,
  onChange,
}: {
  label: string;
  value: UtilMode;
  onChange: (m: UtilMode) => void;
}) {
  return (
    <span className="seg">
      {MODES.map((m) => (
        <button
          key={m}
          className={`seg-btn${value === m ? " seg-active" : ""}`}
          aria-pressed={value === m}
          aria-label={`${label}: ${m}`}
          onClick={() => onChange(m)}
        >
          {m}
        </button>
      ))}
    </span>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="settings-group">
      <div className="settings-section">{title}</div>
      {children}
    </section>
  );
}

function Check({
  checked,
  onChange,
  label,
  ariaLabel,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  ariaLabel?: string;
}) {
  return (
    <label className="field field-check">
      <input
        type="checkbox"
        checked={checked}
        aria-label={ariaLabel ?? label}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

/**
 * Numeric field that keeps the half-typed value local: only finite, clamped
 * numbers are committed, so an empty or malformed box can never write NaN into
 * settings. `value === null` renders empty, which is how "no override" reads.
 */
function NumInput({
  label,
  ariaLabel,
  value,
  min,
  max,
  unit,
  placeholder,
  onCommit,
}: {
  label: string;
  ariaLabel?: string;
  value: number | null;
  min: number;
  max: number;
  unit?: string;
  placeholder?: string;
  onCommit: (n: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (value === null ? "" : String(value));

  return (
    <label className="set-field">
      <span className="muted small">{label}</span>
      <input
        className="num num-small"
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={shown}
        placeholder={placeholder}
        aria-label={ariaLabel ?? label}
        onChange={(e) => {
          const raw = e.target.value;
          setDraft(raw);
          const n = Number(raw);
          if (raw.trim() !== "" && Number.isFinite(n)) {
            onCommit(Math.min(max, Math.max(min, n)));
          }
        }}
        onBlur={() => setDraft(null)}
      />
      {unit ? <span className="muted small">{unit}</span> : null}
    </label>
  );
}

// ---------- helpers ----------

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function parseArgs(raw: string): string[] {
  return raw
    .split(",")
    .map((a) => a.trim())
    .filter((a) => a !== "");
}

function targetLabel(kind: CustomCardKind): string {
  return kind === "command" ? "Executable" : kind === "http" ? "Loopback URL" : "File path";
}
