/**
 * DTO-ene fra huben slik JSON-protokollen serialiserer dem (camelCase). Kilde: apps/glimt-hub/src/Glimt.Hub/
 * Features/Agents/Projections.cs (CardDto, ServerDto), Features/Live/ServerStatusDto.cs, Features/Agents/Protocol/Messages.cs
 * og Features/Auth/AuthDtos.cs. Vi holder oss til JSON (MessagePack sender PascalCase-navn).
 */

/** Tilstanden til SignalR-forbindelsen mot /hub/live. */
export type LiveState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

/** `sleeping`: en containernode som sa `bye` (planlagt stopp), aldri varslet som nede (fase 12). */
export type ServerStatus = 'up' | 'down' | 'paused' | 'sleeping';

/** Nodetype (fase 12): en server med agent, eller en container agenten kjører inne i. */
export type NodeKind = 'server' | 'container';
export type HealthState = 'ok' | 'fail' | 'none';

/** Hub → klient `ServerStatus(dto)`: tilkobling, frakobling, nede. */
export interface ServerStatusDto {
  id: string;
  name: string;
  hostname: string;
  status: ServerStatus;
  /** ISO 8601 eller null hvis agenten aldri har meldt seg. */
  lastSeenAt: string | null;
  connected: boolean;
  agentVersion?: string | null;
  os?: string | null;
  arch?: string | null;
  cores?: number | null;
  ramBytes?: number | null;
}

export interface DiskWorstDto {
  path: string;
  pct: number;
}

/** Hub → klient `Card(dto)`: alt serverkortet viser (IMPLEMENTERINGSPLAN 4.3). */
export interface CardDto {
  id: string;
  name: string;
  hostname: string;
  tags: string[];
  status: ServerStatus;
  connected: boolean;
  lastSeenAt: string | null;
  os: string | null;
  versionId: string | null;
  arch: string | null;
  cores: number | null;
  ramBytes: number | null;
  /** Oppetid i sekunder; null når serveren er nede. */
  uptimeSec: number | null;
  cpu: number | null;
  mem: number | null;
  diskWorst: DiskWorstDto | null;
  netRx: number | null;
  netTx: number | null;
  containersRunning: number;
  containersTotal: number;
  containersBad: number;
  updates: number | null;
  securityUpdates: number | null;
  rebootRequired: boolean | null;
  failedServices: number;
  activeAlerts: number;
  /** Verste alvorsgrad blant aktive varsler: critical, warning, info eller null. */
  alertSeverity: AlertSeverity | null;
  /** 120 punkter à 30 s, hele prosent, null der bufferen mangler. */
  cpuLastHour: (number | null)[];
  memLastHour: (number | null)[];
  kind: NodeKind;
  /** Containernoder: siste helsesjekk; null for servere. */
  health: HealthState | null;
  /** Containernoder uten lesbar cgroup: CPU og minne er summert over prosessene. */
  approx: boolean | null;
  /** Vertsagenten som ser containeren (lenket), ellers null. */
  onHost: string | null;
  image: string | null;
  restarts24h: number | null;
  /** memory.max i bytes; null uten grense. */
  memLimit: number | null;
  /** Antall lyttende porter i containeren. */
  ports: number | null;
}

export interface OsInfo {
  id: string;
  versionId: string;
  prettyName: string;
}

export interface CpuMetrics {
  total: number;
  user?: number | null;
  system?: number | null;
  iowait?: number | null;
  steal?: number | null;
  perCore?: number[] | null;
}

export interface MemMetrics {
  total: number;
  used: number;
  free: number;
  buffers?: number | null;
  cached?: number | null;
  swapTotal?: number | null;
  swapUsed?: number | null;
}

export interface MountMetrics {
  path: string;
  fs: string;
  device?: string | null;
  total: number;
  used: number;
  inodesTotal?: number | null;
  inodesUsed?: number | null;
  readBps?: number | null;
  writeBps?: number | null;
}

export interface IfaceMetrics {
  name: string;
  ips?: string[] | null;
  rxBps?: number | null;
  txBps?: number | null;
}

export interface LimitsInfo {
  cpuCores?: number | null;
  memBytes?: number | null;
}

export interface HostMetrics {
  cpu: CpuMetrics;
  load?: number[] | null;
  mem: MemMetrics;
  uptimeSec?: number | null;
  mounts?: MountMetrics[] | null;
  ifaces?: IfaceMetrics[] | null;
  /** Containernoder: tallene er summert over prosessene (ingen cgroup). */
  approx?: boolean | null;
  /** Containernoder: cpu.max og memory.max. */
  limits?: LimitsInfo | null;
}

/** `GET GLIMT_HEALTH_URL` (fase 12). */
export interface HealthInfo {
  url: string;
  ok: boolean;
  status?: number | null;
  ms?: number | null;
  checkedAt: number;
  error?: string | null;
}

/** Én TCP-sjekk fra GLIMT_CHECKS. */
export interface CheckInfo {
  name: string;
  target: string;
  ok: boolean;
  ms?: number | null;
  error?: string | null;
}

export interface Capabilities {
  cgroup: boolean;
  procAll: boolean;
  netns: boolean;
  health: boolean;
}

/** Vertsagenten en containernode er lenket til. */
export interface HostLinkDto {
  serverId: string;
  name: string;
}

export interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  imageCreated?: number | null;
  state: string;
  health?: string | null;
  restartCount?: number | null;
  startedAt?: number | null;
  cpuPct?: number | null;
  memBytes?: number | null;
  memLimit?: number | null;
  rxBps?: number | null;
  txBps?: number | null;
  ports?: string[] | null;
  mounts?: string[] | null;
  compose?: string | null;
}

export interface ProcessInfo {
  pid: number;
  name: string;
  user: string;
  cpuPct: number;
  rssBytes: number;
  startedAt?: number | null;
  cmdline?: string | null;
}

export interface ProcessTotals {
  total?: number | null;
  running?: number | null;
  blocked?: number | null;
}

export interface ServiceUnit {
  name: string;
  state: string;
  needsRestart?: boolean | null;
}

export interface ServicesInfo {
  units?: ServiceUnit[] | null;
  failed?: string[] | null;
  needsRestart?: string[] | null;
}

export interface MaintenanceInfo {
  rebootRequired?: boolean | null;
  rebootPkgs?: string[] | null;
  updates?: number | null;
  securityUpdates?: number | null;
  checkedAt?: number | null;
  needrestartAvailable?: boolean | null;
}

export interface ListeningPort {
  port: number;
  proto: string;
  process?: string | null;
  pid?: number | null;
}

export interface LoggedInUser {
  user: string;
  from?: string | null;
  tty?: string | null;
  since?: number | null;
}

export interface SshAttempt {
  user?: string | null;
  from?: string | null;
  at?: number | null;
}

export interface SshFailed {
  hour?: number | null;
  day?: number | null;
  last?: SshAttempt[] | null;
}

export interface FirewallInfo {
  ufw?: string | null;
  fail2ban?: string | null;
  banned?: number | null;
  blocked?: number | null;
}

export interface SecurityInfo {
  listeningPorts?: ListeningPort[] | null;
  loggedIn?: LoggedInUser[] | null;
  sshFailed?: SshFailed | null;
  firewall?: FirewallInfo | null;
}

/** Hub → klient `Server(dto)`: siste snapshot flettet med siste stream for én server. */
export interface ServerDto {
  id: string;
  name: string;
  hostname: string;
  tags: string[];
  status: ServerStatus;
  connected: boolean;
  lastSeenAt: string | null;
  agentVersion: string | null;
  os: OsInfo | null;
  kernel: string | null;
  arch: string | null;
  cores: number | null;
  ramBytes: number | null;
  dockerMode: string | null;
  bootTime: number | null;
  uptimeSec: number | null;
  host: HostMetrics | null;
  processes: ProcessInfo[] | null;
  processTotals: ProcessTotals | null;
  containers: ContainerInfo[] | null;
  services: ServicesInfo | null;
  maintenance: MaintenanceInfo | null;
  security: SecurityInfo | null;
  snapshotAt: string | null;
  streamAt: string | null;
  kind: NodeKind;
  containerId?: string | null;
  capabilities?: Capabilities | null;
  image?: string | null;
  health?: HealthInfo | null;
  checks?: CheckInfo[] | null;
  approx?: boolean | null;
  restarts24h?: number | null;
  restarts10m?: number | null;
  hostServer?: HostLinkDto | null;
  hostContainer?: ContainerInfo | null;
  /** Verter: container-id → node-id for containere som er egne noder. */
  linkedNodes?: Record<string, string> | null;
  /** Containernoder: filene `source: file` får hale (GLIMT_LOG_PATHS). */
  logPaths?: string[] | null;
}

/** Én logglinje fra `Log(streamId, lines, dropped)`. */
export interface LogLineDto {
  ts: number;
  unit: string | null;
  container: string | null;
  priority: string | null;
  message: string;
}

/** Klient → hub `StartLog(req)`. */
export interface LogRequest {
  serverId: string;
  source: string;
  unit?: string | null;
  container?: string | null;
  priority?: string | null;
  sinceMs?: number | null;
  tail?: number | null;
  /** `source: file`: én av nodens `logPaths`. */
  path?: string | null;
}

export type LogEndReason = string;

/** Brukeren slik login/confirm/refresh og /api/auth/me returnerer den. */
export interface UserDto {
  id: string;
  email: string;
  name: string;
  timezone: string;
  language: string;
  plan: string;
  earlyAdopter: boolean;
  emailConfirmed: boolean;
  /** Kun på /api/auth/me og /api/account. */
  ownsServers?: boolean;
  readerOf?: number;
}

export interface LoginResponse {
  accessToken: string;
  /** ISO 8601. */
  expiresAt: string;
  user: UserDto;
}

export type ServerRole = 'owner' | 'reader';

// ---- varsler (fase 7) --------------------------------------------------------------------------

export type AlertRuleId = 'server_down' | 'disk_full' | 'mem_pressure' | 'cpu_sat' | 'cont_restart' | 'svc_failed' | 'reboot' | 'health_failed';
export const ALERT_RULE_IDS: readonly AlertRuleId[] = ['server_down', 'disk_full', 'mem_pressure', 'cpu_sat', 'cont_restart', 'svc_failed', 'reboot', 'health_failed'];
export type AlertSeverity = 'critical' | 'warning' | 'info';
export type AlertState = 'firing' | 'resolved';
export type AlertEventKind = 'fired' | 'resolved' | 'reminder';
export type ThresholdUnit = 'percent' | 'seconds' | 'count' | 'none';

/** Én rad på varselsiden og nyttelasten i `Alert(event)` (Features/Alerts/AlertDtos.cs). */
export interface AlertDto {
  id: string;
  serverId: string;
  serverName: string;
  rule: AlertRuleId;
  key: string;
  severity: AlertSeverity;
  state: AlertState;
  detail: string;
  firedAt: string;
  resolvedAt: string | null;
  lastReminderAt: string | null;
  silenced: boolean;
  notifiedVia: string[];
}

/** Hub → klient `Alert(event)`. */
export interface AlertEventDto {
  kind: AlertEventKind;
  alert: AlertDto;
  activeOnServer: number;
  worstSeverity: AlertSeverity | null;
}

export interface AlertListResponse {
  alerts: AlertDto[];
  active: number;
  resolved: number;
}

export type SilenceChoice = '1h' | 'tomorrow' | 'monday';

export interface RuleInfoDto {
  id: AlertRuleId;
  severity: AlertSeverity;
  thresholdUnit: ThresholdUnit;
  defaultThreshold: number | null;
  defaultDurationSec: number | null;
  enabled: boolean;
  threshold: number | null;
  durationSec: number | null;
  overridden: boolean;
}

export interface RuleSettingDto {
  enabled?: boolean | null;
  threshold?: number | null;
  durationSec?: number | null;
}

export interface ChannelsDto {
  push: boolean;
  email: boolean;
  webhookUrl: string | null;
  webhookSecret: string;
  pushConfigured: boolean;
}

export interface DigestDto {
  enabled: boolean;
  time: string;
}

export interface PushDeviceDto {
  id: string;
  device: string;
  createdAt: string;
}

/** `GET /api/alert-settings` (skjerm 10). */
export interface AlertSettingsDto {
  rules: RuleInfoDto[];
  channels: ChannelsDto;
  digest: DigestDto;
  pushDevices: PushDeviceDto[];
  email: string;
}

/** `GET /api/servers/{id}/alert-settings` (skjerm 10 med ?server=). */
export interface ServerAlertSettingsDto {
  serverId: string;
  serverName: string;
  useAccountDefaults: boolean;
  muted: boolean;
  silencedUntil: string | null;
  rules: RuleInfoDto[];
}

/** `GET /api/servers` og `GET /api/servers/{id}`. */
export interface ServerListItem {
  id: string;
  name: string;
  hostname: string;
  tags: string[];
  status: ServerStatus;
  lastSeenAt: string | null;
  role: ServerRole;
  ownerEmail?: string | null;
  os?: string | null;
  kernel?: string | null;
  arch?: string | null;
  cores?: number | null;
  ramBytes?: number | null;
  dockerMode?: string | null;
  createdAt?: string;
  supportUntil?: string | null;
  eol?: boolean;
  kind?: NodeKind;
  image?: string | null;
  containerId?: string | null;
}

/** `POST /api/servers { kind: "container", name }` (steg 12.5): tokenet vises én gang. */
export interface CreateNodeResponse {
  id: string;
  name: string;
  kind: NodeKind;
  token: string;
  hubUrl: string;
  agentImage: string;
  compose: string;
  dockerfile: string;
}

/** `POST /api/servers/{id}/rotate-key` for en containernode. */
export interface RotateKeyResponse {
  token: string;
  oldTokenValidUntil: string;
}

/** `GET /api/groups` (fase 13): en personlig, navngitt samling av noder. `memberIds` er filtrert til det brukeren ser. */
export interface GroupDto {
  id: string;
  name: string;
  memberIds: string[];
  order: number;
  createdAt: string;
}

/** `DELETE /api/servers/{id}`. */
export interface DeleteServerResponse {
  uninstallCommand: string | null;
  kind: NodeKind;
  hint: string | null;
}
