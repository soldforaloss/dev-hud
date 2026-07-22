// Payload contract with the Rust backend — mirror of src-tauri/src/types.rs.
//
// Application settings live in src/model/settings.ts; this file is only the
// wire format, so collectors stay isolated from presentation state.

export interface ProcInfo {
  pid: number;
  ppid: number | null;
  name: string;
  label: string | null;
  cmdSummary: string;
  cwd: string | null;
  startTimeUnix: number;
  memBytes: number;
  cpuPercent: number;
  killable: boolean;
  childPids: number[];
  parentApp: string | null;
  orphaned: boolean;
  idleSecs: number;
}

export interface ProcessesPayload {
  scannedAt: string;
  processes: ProcInfo[];
}

export interface KillResult {
  status: "Killed" | "AlreadyExited" | "PidReused" | "AccessDenied" | "Unknown";
  osCode: number | null;
  killedPids: number[];
}

export interface TokenTotals {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

export interface ModelUsage {
  model: string;
  tokens: number;
  costUsd: number;
}

export interface HourBucket {
  hourUnix: number;
  tokens: number;
  costUsd: number;
}

export interface RateWindow {
  label: string;
  usedPercent: number;
  resetsAtUnix: number;
  windowMinutes: number;
}

export interface ActiveSession {
  name: string;
  cwd: string | null;
  ageSecs: number;
  /** Model last seen in the transcript, when the log records one. */
  model: string | null;
  /** Cumulative tokens attributed to this session, when derivable. */
  tokens: number | null;
  costUsd: number | null;
}

export interface SystemHealth {
  cpuPercent: number;
  memUsed: number;
  memTotal: number;
  swapUsed: number;
  swapTotal: number;
  commitUsed: number;
  commitTotal: number;
  netRxBps: number;
  netTxBps: number;
  localIp: string | null;
  publicIp: string | null;
  /** Windows processor queue length — the closest analogue to load average. */
  queueLength: number | null;
  /** Top consumers by memory, already sorted. */
  topProcesses: TopProcess[];
}

export interface TopProcess {
  pid: number;
  name: string;
  cpuPercent: number;
  memBytes: number;
}

export interface TailscalePeer {
  name: string;
  os: string | null;
  online: boolean;
  relay: string | null;
  direct: boolean;
  lastSeen: string | null;
  ip: string | null;
  exitNode: boolean;
}

export interface TailscaleStatus {
  installed: boolean;
  state: string | null;
  ip: string | null;
  hostname: string | null;
  magicDns: string | null;
  peersOnline: number;
  peersTotal: number;
  error: string | null;
  /** Self relay ("DERP region") when the tailnet link is relayed. */
  relay: string | null;
  /** True when this node's own traffic is going direct rather than via DERP. */
  selfDirect: boolean;
  exitNodeActive: string | null;
  advertisedRoutes: string[];
  keyExpiryUnix: number | null;
  peers: TailscalePeer[];
}

export interface GpuInfo {
  index: number;
  name: string;
  tempC: number | null;
  utilPercent: number | null;
  memUsedMb: number | null;
  memTotalMb: number | null;
  powerW: number | null;
  powerLimitW: number | null;
  clockMhz: number | null;
  fanPercent: number | null;
  pstate: string | null;
}

export interface GpuProcess {
  pid: number;
  name: string;
  memMb: number | null;
  startTimeUnix: number | null;
  killable: boolean;
}

export interface GpuStatus {
  available: boolean;
  error: string | null;
  driver: string | null;
  gpus: GpuInfo[];
  processes: GpuProcess[];
}

export interface ThermalsStatus {
  tier: "lhm" | "wmi" | "none";
  cpuPackageC: number | null;
  cpuMaxCoreC: number | null;
  zoneC: number | null;
  fansRpm: number[];
  sensorCount: number;
  /** True when LHM reports a thermal-limit sensor above zero. */
  throttling: boolean | null;
}

export interface ThermalsSetupResult {
  live: boolean;
  installedNow: boolean;
  configSeeded: boolean;
  launched: boolean;
  taskRegistered: boolean;
  message: string;
}

export interface DiskVolume {
  mount: string;
  label: string;
  total: number;
  available: number;
  /** "NTFS", "ReFS", … as reported by the OS. */
  fs: string | null;
  /** "ssd" | "hdd" | "unknown" */
  kind: string;
  removable: boolean;
  /** SMART predict-failure state, when the driver exposes it. */
  smartOk: boolean | null;
}

export interface DisksStatus {
  volumes: DiskVolume[];
  readBps: number;
  writeBps: number;
  /** Average disk queue seconds/transfer, when the counter is readable. */
  latencyMs: number | null;
}

export interface NetQuality {
  mode: "icmp" | "tcp" | "none";
  latencyMs: number | null;
  avgMs: number | null;
  jitterMs: number | null;
  lossPercent: number;
  samples: number[];
  wifiSsid: string | null;
  wifiSignal: number | null;
  linkMbps: number | null;
  /** Time to resolve a well-known name; null when not measured this cycle. */
  dnsMs: number | null;
  /** Active interface name and media type, when discoverable. */
  interfaceName: string | null;
  linkType: string | null;
}

export type PortExposure = "loopback" | "lan" | "public";

export interface PortListener {
  port: number;
  pid: number;
  process: string;
  proto: "tcp" | "udp";
  family: "v4" | "v6";
  bindAddr: string;
  exposure: PortExposure;
  /** Epoch seconds this listener was first observed in the current session. */
  firstSeenUnix: number;
}

export interface PortsStatus {
  listeners: PortListener[];
  /** Present when the collector could not enumerate sockets at all. */
  error: string | null;
}

export interface WslDistro {
  name: string;
  state: string;
  version: string;
  isDefault: boolean;
  /** Virtual disk size on disk, from the distro's registry BasePath. */
  diskBytes: number | null;
  /** True when docker-desktop's integration distro is present. */
  dockerIntegration: boolean;
}

export interface WslStatus {
  installed: boolean;
  distros: WslDistro[];
  /** Shared across all running distros — WSL2 runs one utility VM. */
  vmmemBytes: number | null;
}

export interface BatteryInfo {
  present: boolean;
  percent: number | null;
  onAc: boolean | null;
  runtimeMin: number | null;
  powerPlan: string | null;
}

export interface UptimeStatus {
  bootUnix: number;
  uptimeSecs: number;
  rebootPending: boolean;
  reasons: string[];
}

export interface OllamaModel {
  name: string;
  vramBytes: number | null;
  expiresAt: string | null;
}

export interface OllamaStatus {
  reachable: boolean;
  loaded: OllamaModel[];
  installedCount: number;
}

export interface WingetUpdate {
  name: string;
  id: string;
  current: string;
  available: string;
}

export interface WingetStatus {
  installed: boolean;
  updates: WingetUpdate[];
  error: string | null;
  checkedUnix: number;
}

export interface SpeedtestResult {
  downMbps: number;
  upMbps: number;
  latencyMs: number;
  jitterMs: number | null;
  atUnix: number;
  provider: string;
}

export interface McpServer {
  name: string;
  source: string;
  command: string;
  running: boolean;
  /** Live process backing this server, when one could be matched. */
  pid: number | null;
  cwd: string | null;
}

export interface McpStatus {
  servers: McpServer[];
}

/** Result of an explicit, on-demand MCP handshake (never polled). */
export interface McpHealth {
  name: string;
  ok: boolean;
  latencyMs: number | null;
  serverName: string | null;
  serverVersion: string | null;
  protocolVersion: string | null;
  tools: string[];
  error: string | null;
}

export interface PortMapping {
  containerPort: number;
  hostPort: number | null;
  hostIp: string | null;
  proto: string;
}

export interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  ports: string | null;
  portList: PortMapping[];
  /** "healthy" | "unhealthy" | "starting" | null when no healthcheck. */
  health: string | null;
  restartCount: number | null;
  createdUnix: number | null;
  cpuPercent: number | null;
  memBytes: number | null;
  memLimitBytes: number | null;
  netRxBytes: number | null;
  netTxBytes: number | null;
  blockReadBytes: number | null;
  blockWriteBytes: number | null;
}

export interface DockerStatus {
  installed: boolean;
  daemonUp: boolean;
  containers: ContainerInfo[];
  error: string | null;
}

export interface ClaudeUsage {
  available: boolean;
  plan: string | null;
  windows: RateWindow[];
  todayTokens: TokenTotals;
  todayCostUsd: number;
  weekTokensTotal: number;
  weekCostUsd: number;
  blockTokensTotal: number;
  blockCostUsd: number;
  blockStartedUnix: number;
  blockEndsUnix: number;
  modelsToday: ModelUsage[];
  hourly: HourBucket[];
  activeSessions: ActiveSession[];
  /** Per-project cost today, largest first. */
  projectsToday: ProjectUsage[];
  /** True when `windows` came from the provider; false = local estimate only. */
  windowsLive: boolean;
  /** Last provider error, e.g. a 429 or an expired token. */
  providerError: string | null;
}

export interface ProjectUsage {
  project: string;
  tokens: number;
  costUsd: number;
  sessions: number;
}

export interface CodexUsage {
  available: boolean;
  plan: string | null;
  primary: RateWindow | null;
  secondary: RateWindow | null;
  todayTokensTotal: number;
  todaySessions: number;
  lastEventUnix: number;
  activeSessions: ActiveSession[];
  projectsToday: ProjectUsage[];
}

export interface OpenClawStatus {
  installed: boolean;
  port: number;
  reachable: boolean;
  httpStatus: number | null;
  latencyMs: number | null;
  pid: number | null;
  uptimeSecs: number | null;
  memBytes: number | null;
  cpuPercent: number | null;
  processCount: number;
  /** Fields below are only present when /health reports them. */
  requestsPerMin: number | null;
  activeRequests: number | null;
  queuedRequests: number | null;
  errorRate: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  connectedClients: number | null;
  lastError: string | null;
  version: string | null;
}

export interface RepoRelease {
  tag: string;
  publishedAt: string | null;
  url: string;
}

export interface RepoStatus {
  repo: string;
  ok: boolean;
  error: string | null;
  stars: number | null;
  openIssues: number | null;
  openPrs: number | null;
  ciStatus: string | null;
  defaultBranch: string | null;
  release: RepoRelease | null;
  pushedAt: string | null;
}

export interface GithubPayload {
  authenticated: boolean;
  login: string | null;
  repos: RepoStatus[];
  /** Set when the API call failed outright (rate limit, no token, offline). */
  error: string | null;
}

/** A git working copy discovered on this machine. */
export interface LocalRepo {
  path: string;
  name: string;
  branch: string | null;
  /** Files with uncommitted modifications. */
  dirtyCount: number;
  ahead: number;
  behind: number;
  upstream: string | null;
  lastCommitSubject: string | null;
  lastCommitUnix: number | null;
  /** Slug matched against the GitHub card ("owner/name"), when a remote exists. */
  remoteSlug: string | null;
  /** Test command found in package.json / Cargo.toml, for the explicit run action. */
  testCommand: string | null;
  error: string | null;
}

export interface LocalReposStatus {
  repos: LocalRepo[];
  /** Directories that were scanned, for the "nothing found" empty state. */
  roots: string[];
  gitAvailable: boolean;
}

/** HUD's own resource use and collector timing. */
export interface SelfDiagnostics {
  pid: number;
  cpuPercent: number;
  memBytes: number;
  threadCount: number | null;
  uptimeSecs: number;
  /** Bytes the settings store occupies on disk. */
  storeBytes: number | null;
  storePath: string | null;
}

// ---------- operator actions ----------

export interface ActionResult {
  ok: boolean;
  /** Short machine-readable outcome: "killed", "denied", "not_found", … */
  code: string;
  message: string;
  /** stdout/stderr excerpt, already truncated and secret-masked. */
  detail: string | null;
}

export interface AuditEntry {
  id: string;
  atUnix: number;
  action: string;
  target: string;
  ok: boolean;
  code: string;
  message: string;
}

/** Payload contract every custom card must satisfy. */
export interface CustomCardPayload {
  schemaVersion: number;
  status: "ok" | "warning" | "critical" | "unknown";
  title: string;
  metrics: { label: string; value: string | number; unit?: string }[];
  message?: string;
}

export interface CustomCardResult {
  id: string;
  ok: boolean;
  payload: CustomCardPayload | null;
  error: string | null;
  durationMs: number;
  atUnix: number;
}

/** "auto" shows the card only when its data source is detected. */
export type UtilMode = "auto" | "on" | "off";

export const CARD_IDS = [
  ["claude", "Claude usage"],
  ["codex", "Codex usage"],
  ["sessions", "Active AI sessions"],
  ["openclaw", "OpenClaw gateway"],
  ["system", "System health"],
  ["gpu", "GPU (NVIDIA)"],
  ["thermals", "Thermals"],
  ["disks", "Disks & storage"],
  ["netq", "Network quality"],
  ["ports", "Ports map"],
  ["wsl", "WSL"],
  ["battery", "Battery & power"],
  ["uptime", "Uptime & reboot"],
  ["tailscale", "Tailscale"],
  ["docker", "Docker"],
  ["ollama", "Ollama"],
  ["winget", "Software updates"],
  ["speedtest", "Speedtest"],
  ["mcp", "MCP servers"],
  ["procs", "Processes"],
  ["repos", "GitHub repos"],
  ["git", "Local repositories"],
  ["diag", "HUD diagnostics"],
] as const;
