/**
 * DTO-ene fra huben slik JSON-protokollen serialiserer dem (camelCase). Kilde: apps/glimt-hub/src/Glimt.Hub/
 * Features/Agents/Projections.cs (CardDto, ServerDto), Features/Live/ServerStatusDto.cs, Features/Agents/Protocol/Messages.cs
 * og Features/Auth/AuthDtos.cs. Vi holder oss til JSON (MessagePack sender PascalCase-navn).
 */

/** Tilstanden til SignalR-forbindelsen mot /hub/live. */
export type LiveState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

export type ServerStatus = 'up' | 'down' | 'paused';

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
  /** 120 punkter à 30 s, hele prosent, null der bufferen mangler. */
  cpuLastHour: (number | null)[];
  memLastHour: (number | null)[];
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

export interface HostMetrics {
  cpu: CpuMetrics;
  load?: number[] | null;
  mem: MemMetrics;
  uptimeSec?: number | null;
  mounts?: MountMetrics[] | null;
  ifaces?: IfaceMetrics[] | null;
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
}
