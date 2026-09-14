import { I18nKey } from '@core/i18n.service';
import { ContainerInfo, OsInfo, ProcessInfo, ServerDto, ServerListItem, ServerStatus } from '@core/live.types';
import { BadgeTone } from '@shared/badge/badge.component';
import { ChipTone } from '@shared/chip/chip.component';
import { formatDuration, formatRate } from '@shared/util/format';
import { thr } from '@shared/util/thr';

/** Det serversiden trenger fra I18nService (så funksjonene kan testes uten Angular). */
export interface ServerTexts {
  t(key: I18nKey): string;
  formatWhen(ms: number): string;
  formatDate(ms: number): string;
  formatTimeShort(ms: number): string;
  formatMonthYear(ms: number): string;
}

export const GB = 1024 ** 3;
export const MB = 1024 ** 2;
const DASH = '—';
const DAY_MS = 86_400_000;

/** Prototypens `f1`: én desimal, alltid. */
export const f1 = (n: number): string => (Math.round(n * 10) / 10).toFixed(1);

/** 8 GB → "8", 7.8 GB → "7.8" (ingen ".0"). */
export function gbLabel(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return DASH;
  const gb = Math.round((bytes / GB) * 10) / 10;
  return Number.isInteger(gb) ? String(gb) : gb.toFixed(1);
}

/** Disk (steg 5.5): GB under 1 000 GB, TB over, én desimal for TB. */
export function diskSize(bytes: number): string {
  const gb = bytes / GB;
  if (gb >= 1000) return `${f1(gb / 1024)} TB`;
  return `${Math.round(gb)} GB`;
}

/** Prosessminne (steg 5.7): "812 MB" eller "1.5 GB". */
export function memSize(bytes: number): string {
  const mb = bytes / MB;
  if (mb >= 1000) return `${f1(mb / 1024)} GB`;
  return `${Math.round(mb)} MB`;
}

/** "Ubuntu 24.04.3 LTS" + versionId "24.04" → "Ubuntu 24.04"; ellers prettyName. */
export function osLabel(os: OsInfo | null): string {
  if (!os) return '';
  if (os.prettyName && os.versionId && /^ubuntu/i.test(os.prettyName)) return `Ubuntu ${os.versionId}`;
  return os.prettyName || os.id || '';
}

export type Dot = 'up' | 'down' | 'paused';

export interface HeaderView {
  name: string;
  tags: string[];
  status: ServerStatus;
  down: boolean;
  dot: Dot;
  statusText: string;
  /** Containernoder (steg 12.9): image-badge og verten når lenket. */
  isContainer: boolean;
  image: string;
  onHost: { serverId: string; name: string } | null;
  /** «Ubuntu 24.04 · 6.8.0-45-generic · 4 cores · 8 GB» */
  info: string;
  /** «up 41d 2h · last boot Jul 30 01:05», tom når nede. */
  uptime: string;
  eol: boolean;
  /** «Supported until Apr 2029», tom uten Ubuntu-tabellen. */
  support: string;
}

export function headerView(server: ServerDto, item: ServerListItem | null, texts: ServerTexts): HeaderView {
  const up = server.status === 'up';
  const paused = server.status === 'paused';
  const sleeping = server.status === 'sleeping';
  const isContainer = (server.kind ?? item?.kind ?? 'server') === 'container';
  const statusText = sleeping
    ? `${texts.t('sleepingSince')} ${server.lastSeenAt ? texts.formatWhen(Date.parse(server.lastSeenAt)) : ''}`.trim()
    : paused
      ? texts.t('paused')
      : up
        ? texts.t('liveLabel')
        : server.lastSeenAt
          ? `${texts.t('lastSeen')} ${texts.formatWhen(Date.parse(server.lastSeenAt))}`
          : texts.t('down');
  const limits = server.host?.limits;
  const info = (
    isContainer
      ? [
          texts.t('containerLabel'),
          server.cores ? `${server.cores} ${texts.t('cpuLimit')}` : '',
          limits?.memBytes ? `${gbLabel(limits.memBytes)} GB ${texts.t('memLimitOf')}` : texts.t('noLimit'),
          server.approx ? texts.t('approx') : '',
        ]
      : [osLabel(server.os), server.kernel ?? '', server.cores ? `${server.cores} ${texts.t('cores')}` : '', server.ramBytes ? `${gbLabel(server.ramBytes)} GB` : '']
  )
    .filter(Boolean)
    .join(' · ');
  const uptimeParts: string[] = [];
  if (up && server.uptimeSec !== null && server.uptimeSec !== undefined) uptimeParts.push(`${texts.t('uptime')} ${formatDuration(server.uptimeSec)}`);
  if (server.bootTime) uptimeParts.push(`${texts.t('lastBoot')} ${texts.formatDate(server.bootTime)}`);
  const supportUntil = item?.supportUntil ? Date.parse(item.supportUntil) : NaN;
  return {
    name: server.name,
    tags: server.tags ?? [],
    status: server.status,
    down: server.status === 'down',
    dot: paused || sleeping ? 'paused' : up ? 'up' : 'down',
    statusText,
    isContainer,
    image: isContainer ? (server.image ?? '') : '',
    onHost: isContainer && server.hostServer ? { serverId: server.hostServer.serverId, name: server.hostServer.name } : null,
    info,
    uptime: uptimeParts.join(' · '),
    eol: !isContainer && !!item?.eol,
    support: !isContainer && Number.isFinite(supportUntil) ? `${texts.t('supported')} ${texts.formatMonthYear(supportUntil)}` : '',
  };
}

// ---- Helse og sjekker (containernoder, steg 12.9) ----------------------------------------------

export interface CheckRow {
  name: string;
  target: string;
  ok: boolean;
  /** «3 ms» eller feilteksten. */
  text: string;
}

export interface HealthView {
  configured: boolean;
  ok: boolean | null;
  /** «GET /healthz · 200 · 12 ms» */
  line: string;
  /** «checked 08:14:02» */
  checked: string;
  checks: CheckRow[];
  /** Panelets tone: grønn når alt er ok, rød ved feil, nøytral uten sjekker. */
  tone: 'ok' | 'crit' | 'neutral';
  head: string;
}

export function healthView(server: ServerDto, texts: ServerTexts): HealthView {
  const h = server.health ?? null;
  const checks = (server.checks ?? []).map<CheckRow>((c) => ({ name: c.name, target: c.target, ok: c.ok, text: c.ok ? `${c.ms ?? 0} ms` : (c.error ?? texts.t('healthFail')) }));
  const failed = (h ? !h.ok : false) || checks.some((c) => !c.ok);
  const configured = h !== null || checks.length > 0;
  let line = '';
  if (h) {
    let path = h.url;
    try {
      path = new URL(h.url).pathname || '/';
    } catch {
      // ikke en absolutt URL: vis den som den er
    }
    line = `GET ${path} · ${h.status ?? (h.error ?? texts.t('down'))}${h.ms !== null && h.ms !== undefined ? ` · ${h.ms} ms` : ''}`;
  }
  const okCount = checks.filter((c) => c.ok).length;
  const headParts = [h ? (h.ok ? texts.t('ok') : texts.t('healthFail')) : '', checks.length ? `${okCount}/${checks.length} ${texts.t('checks').toLowerCase()}` : ''].filter(Boolean);
  return {
    configured,
    ok: configured ? !failed : null,
    line,
    checked: h ? `${texts.t('checkedAt')} ${texts.formatTimeShort(h.checkedAt)}` : '',
    checks,
    tone: !configured ? 'neutral' : failed ? 'crit' : 'ok',
    head: headParts.join(' · ') || DASH,
  };
}

// ---- Verten (lenket containernode) ---------------------------------------------------------------

export interface HostView {
  serverId: string;
  name: string;
  image: string;
  age: string;
  restarts: string;
  state: string;
  memLimit: string;
}

export function hostView(server: ServerDto, texts: ServerTexts, nowMs: number): HostView | null {
  const link = server.hostServer;
  if (!link) return null;
  const c = server.hostContainer ?? null;
  const ageDays = c?.imageCreated ? Math.max(0, Math.floor((nowMs - c.imageCreated) / DAY_MS)) : null;
  return {
    serverId: link.serverId,
    name: link.name,
    image: c?.image ?? server.image ?? DASH,
    age: ageDays === null ? DASH : `${ageDays} ${texts.t('days')}`,
    restarts: c?.restartCount === null || c?.restartCount === undefined ? DASH : String(c.restartCount),
    state: c ? texts.t(containerState(c)) : DASH,
    memLimit: c?.memLimit ? `${Math.round(c.memLimit / MB)} MB` : texts.t('noLimit'),
  };
}

// ---- CPU ------------------------------------------------------------------------------------------

export interface LoadChip {
  label: string;
  value: string;
  sub: string;
  tone: ChipTone;
}

export interface CpuView {
  pct: number;
  /** «48% · 1.9 of 4 cores» */
  head: string;
  cores: { label: string; pct: number }[];
  chips: LoadChip[];
}

export function cpuView(server: ServerDto, texts: ServerTexts): CpuView {
  const up = server.status === 'up';
  const host = server.host;
  const cores = server.cores ?? host?.cpu.perCore?.length ?? 0;
  const pct = up && host ? host.cpu.total : 0;
  const perCore = host?.cpu.perCore ?? [];
  const n = Math.max(cores, perCore.length);
  const coreBars = Array.from({ length: n }, (_, i) => ({ label: `C${i + 1}`, pct: up ? Math.round(perCore[i] ?? pct) : 0 }));
  const load = host?.load ?? [];
  const loadChip = (i: number, label: string): LoadChip => {
    const v = load[i];
    const has = up && v !== undefined && v !== null;
    return { label, value: has ? f1(v) : DASH, sub: cores > 0 ? `/ ${cores}` : '', tone: has && i === 0 && cores > 0 && v > cores ? 'warn' : 'default' };
  };
  const pctChip = (label: string, v: number | null | undefined, warnOver: number | null, decimals: boolean): LoadChip => {
    const has = up && v !== undefined && v !== null;
    return { label, value: has ? `${decimals ? f1(v) : Math.round(v)}%` : DASH, sub: '', tone: has && warnOver !== null && v > warnOver ? 'warn' : 'default' };
  };
  return {
    pct,
    head: `${Math.round(pct)}%${cores > 0 ? ` · ${f1((pct / 100) * cores)} ${texts.t('of')} ${cores} ${texts.t('cores')}` : ''}`,
    cores: coreBars,
    chips: [
      loadChip(0, `${texts.t('load')} 1m`),
      loadChip(1, `${texts.t('load')} 5m`),
      loadChip(2, `${texts.t('load')} 15m`),
      pctChip(texts.t('user'), host?.cpu.user, null, false),
      pctChip(texts.t('system'), host?.cpu.system, null, false),
      pctChip(texts.t('iowait'), host?.cpu.iowait, 5, true),
    ],
  };
}

// ---- Minne ----------------------------------------------------------------------------------------

export interface MemView {
  pct: number;
  /** «61% · 4.9 of 8 GB · Swap 0.4 GB» */
  head: string;
  usedPct: number;
  bufPct: number;
  legend: { name: string; value: string; color: string }[];
}

/** Prosent «brukt» = (total − free − buffers − cached) / total, som `free -m` sin «used» (steg 5.4). */
export function memView(server: ServerDto, texts: ServerTexts): MemView {
  const up = server.status === 'up';
  const m = server.host?.mem;
  const total = m?.total ?? server.ramBytes ?? 0;
  const buffers = (m?.buffers ?? 0) + (m?.cached ?? 0);
  const used = m && total > 0 ? Math.max(0, total - m.free - (m.buffers ?? 0) - (m.cached ?? 0)) : 0;
  const free = m ? Math.max(0, total - used - buffers) : 0;
  const pct = up && total > 0 ? (used / total) * 100 : 0;
  const swap = m?.swapUsed ?? 0;
  const container = server.kind === 'container';
  const tail = container ? (server.host?.limits?.memBytes ? '' : ` · ${texts.t('noLimit')}`) : ` · ${texts.t('swap')} ${f1(swap / GB)} GB`;
  return {
    pct,
    head: `${Math.round(pct)}%${total > 0 ? ` · ${f1((pct / 100) * (total / GB))} ${texts.t('of')} ${gbLabel(total)} GB` : ''}${tail}`,
    usedPct: up && total > 0 ? (used / total) * 100 : 0,
    bufPct: up && total > 0 ? (buffers / total) * 100 : 0,
    legend: [
      { name: texts.t('used'), value: `${f1(up ? used / GB : 0)} GB`, color: 'var(--color-ram)' },
      { name: texts.t('buffers'), value: `${f1(up ? buffers / GB : 0)} GB`, color: 'var(--color-disk)' },
      { name: texts.t('free'), value: `${f1(up ? free / GB : 0)} GB`, color: 'var(--color-neutral)' },
      { name: texts.t('swap'), value: `${f1(up ? swap / GB : 0)} GB`, color: 'var(--color-swap)' },
    ],
  };
}

// ---- Disk -----------------------------------------------------------------------------------------

export interface MountView {
  path: string;
  fs: string;
  pct: number;
  color: string;
  /** «38 GB» */
  free: string;
  /** «42 GB used of 80 GB» */
  foot: string;
  inodePct: number | null;
  inodeColor: string;
  /** «read 3.2 · write 11.0 MB/s» */
  io: string;
}

export interface DiskView {
  /** «2 mounted» */
  head: string;
  mounts: MountView[];
}

export function diskView(server: ServerDto, texts: ServerTexts): DiskView {
  const up = server.status === 'up';
  const mounts = (server.host?.mounts ?? []).map<MountView>((m) => {
    const pct = m.total > 0 ? (m.used / m.total) * 100 : 0;
    const inodePct = m.inodesTotal && m.inodesTotal > 0 ? ((m.inodesUsed ?? 0) / m.inodesTotal) * 100 : null;
    return {
      path: m.path,
      fs: m.fs,
      pct: Math.round(pct),
      color: thr(pct, 'var(--color-disk)'),
      free: diskSize(Math.max(0, m.total - m.used)),
      foot: `${diskSize(m.used)} ${texts.t('used')} ${texts.t('of')} ${diskSize(m.total)}`,
      inodePct: inodePct === null ? null : Math.round(inodePct),
      inodeColor: inodePct === null ? 'var(--w-35)' : thr(inodePct, 'var(--w-35)'),
      io: up ? `${texts.t('read')} ${formatRate(m.readBps ?? 0)} · ${texts.t('write')} ${formatRate(m.writeBps ?? 0)} MB/s` : DASH,
    };
  });
  mounts.sort((a, b) => b.pct - a.pct || a.path.localeCompare(b.path));
  return { head: `${mounts.length} ${texts.t('mounted')}`, mounts };
}

// ---- Nettverk -------------------------------------------------------------------------------------

export interface IfaceView {
  name: string;
  /** Første IPv4 (ellers første adresse), tom uten. */
  ip: string;
  /** Alle adressene, til `title`. */
  ips: string;
  rx: string;
  tx: string;
  rxBps: number;
}

export interface NetView {
  /** «↓14.8 ↑1.2 MB/s» */
  head: string;
  ifaces: IfaceView[];
}

export function netView(server: ServerDto): NetView {
  const up = server.status === 'up';
  const ifaces = (server.host?.ifaces ?? []).map<IfaceView>((i) => {
    const ips = i.ips ?? [];
    const v4 = ips.find((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip)) ?? ips[0] ?? '';
    return { name: i.name, ip: v4, ips: ips.join(', '), rx: up ? `↓${formatRate(i.rxBps ?? 0)}` : DASH, tx: up ? `↑${formatRate(i.txBps ?? 0)}` : '', rxBps: i.rxBps ?? 0 };
  });
  const rx = ifaces.reduce((a, i) => a + i.rxBps, 0);
  const tx = (server.host?.ifaces ?? []).reduce((a, i) => a + (i.txBps ?? 0), 0);
  return { head: up ? `↓${formatRate(rx)} ↑${formatRate(tx)} MB/s` : DASH, ifaces };
}

// ---- Prosesser ------------------------------------------------------------------------------------

export interface ProcessRow {
  pid: number;
  name: string;
  user: string;
  cpu: number;
  /** Bytes. */
  mem: number;
  /** Kjøretid i sekunder (fra `startedAt`), null uten. */
  time: number | null;
  cmd: string;
}

export interface ProcView {
  /** «182 total · 0 waiting» */
  head: string;
  rows: ProcessRow[];
}

export function procView(server: ServerDto, texts: ServerTexts, nowMs: number): ProcView {
  const rows = (server.processes ?? []).map<ProcessRow>((p: ProcessInfo) => ({
    pid: p.pid,
    name: p.name,
    user: p.user,
    cpu: p.cpuPct,
    mem: p.rssBytes,
    time: p.startedAt ? Math.max(0, Math.floor((nowMs - p.startedAt) / 1000)) : null,
    cmd: p.cmdline ?? '',
  }));
  const totals = server.processTotals;
  const total = totals?.total ?? rows.length;
  const waiting = totals?.blocked ?? 0;
  return { head: `${total} ${texts.t('total')} · ${waiting} ${texts.t('waiting')}`, rows };
}

// ---- Containere -----------------------------------------------------------------------------------

export type ContainerState = 'running' | 'restarting' | 'stopped';

export interface ContainerView {
  id: string;
  name: string;
  image: string;
  state: ContainerState;
  dot: 'up' | 'paused' | 'connecting';
  /** «running · 3d 4h» */
  status: string;
  cpu: string;
  /** «412 MB» */
  mem: string;
  /** «/ 1024 MB» eller «no limit» */
  limit: string;
  memPct: number;
  memColor: string;
  restarts: string;
  restartsTone: ChipTone;
  age: string;
  ageTone: ChipTone;
  net: string;
  health: string;
  compose: string;
  ports: string[];
  mounts: string[];
  /** Containeren er en egen containernode (steg 12.6): id-en til noden. */
  nodeId: string | null;
}

export interface ContainersView {
  /** Docker leses på serveren (hello.dockerMode ≠ none). */
  available: boolean;
  /** «5 running · 1 stopped/restarting» */
  head: string;
  running: number;
  bad: number;
  rows: ContainerView[];
}

export function containerState(c: Pick<ContainerInfo, 'state'>): ContainerState {
  if (c.state === 'running') return 'running';
  if (c.state === 'restarting') return 'restarting';
  return 'stopped';
}

/** Uten grense skaleres stolpen mot 2 GB som i prototypen, i nøytral farge. */
const NO_LIMIT_SCALE = 2 * 1024 * MB;

export function containerView(c: ContainerInfo, texts: ServerTexts, nowMs: number, nodeId: string | null = null): ContainerView {
  const state = containerState(c);
  const stopped = state === 'stopped';
  const limit = c.memLimit && c.memLimit > 0 ? c.memLimit : null;
  const mem = c.memBytes ?? 0;
  const pct = limit ? (mem / limit) * 100 : (mem / NO_LIMIT_SCALE) * 100;
  const ageDays = c.imageCreated ? Math.max(0, Math.floor((nowMs - c.imageCreated) / DAY_MS)) : null;
  const restarts = c.restartCount ?? 0;
  const upFor = c.startedAt && !stopped ? formatDuration((nowMs - c.startedAt) / 1000) : '';
  return {
    id: c.id,
    name: c.name,
    image: c.image,
    state,
    dot: state === 'running' ? 'up' : state === 'restarting' ? 'connecting' : 'paused',
    status: upFor ? `${texts.t(state)} · ${upFor}` : texts.t(state),
    cpu: stopped ? DASH : `${f1(c.cpuPct ?? 0)}%`,
    mem: stopped ? DASH : `${Math.round(mem / MB)} MB`,
    limit: limit ? `/ ${Math.round(limit / MB)} MB` : texts.t('noLimit'),
    memPct: stopped ? 0 : Math.round(Math.min(100, pct)),
    memColor: limit ? thr(pct, 'var(--color-swap)') : 'var(--w-35)',
    restarts: String(restarts),
    restartsTone: restarts > 3 ? 'warn' : 'default',
    age: ageDays === null ? DASH : `${ageDays} ${texts.t('days')}`,
    ageTone: ageDays !== null && ageDays > 90 ? 'warn' : 'default',
    net: stopped ? DASH : `↓${formatRate(c.rxBps ?? 0)} ↑${formatRate(c.txBps ?? 0)}`,
    health: c.health && c.health !== 'none' ? (c.health === 'healthy' ? texts.t('healthy') : c.health) : DASH,
    compose: c.compose ?? DASH,
    ports: c.ports ?? [],
    mounts: c.mounts ?? [],
    nodeId,
  };
}

/** Sortering (steg 5.8): restarting og stopped først, så etter CPU synkende. */
export function containersView(server: ServerDto, texts: ServerTexts, nowMs: number): ContainersView {
  const available = server.dockerMode !== null && server.dockerMode !== 'none' && server.containers !== null;
  const list = server.containers ?? [];
  const linked = server.linkedNodes ?? {};
  const rows = list.map((c) => containerView(c, texts, nowMs, linked[c.id] ?? null));
  const rank = (s: ContainerState) => (s === 'running' ? 1 : 0);
  const cpuOf = new Map(list.map((c) => [c.id, c.cpuPct ?? 0]));
  rows.sort((a, b) => rank(a.state) - rank(b.state) || (cpuOf.get(b.id) ?? 0) - (cpuOf.get(a.id) ?? 0) || a.name.localeCompare(b.name));
  const running = rows.filter((r) => r.state === 'running').length;
  const bad = rows.length - running;
  return {
    available,
    head: rows.length ? `${running} ${texts.t('running')} · ${bad} ${texts.t('stopped')}/${texts.t('restarting')}` : available ? texts.t('noContainers') : DASH,
    running,
    bad,
    rows,
  };
}

// ---- Tjenester ------------------------------------------------------------------------------------

export type ServiceState = 'failed' | 'running' | 'stopped';

export interface ServiceView {
  name: string;
  state: ServiceState;
  dot: 'up' | 'down' | 'paused';
  status: string;
  needsRestart: boolean;
}

export interface ServicesView {
  /** «1 failed · 8 running» */
  head: string;
  failed: number;
  running: number;
  rows: ServiceView[];
  /** Antall som er skjult bak «Show all». */
  hidden: number;
}

export const SERVICES_MAX = 200;

/** Feilede først, så running, så stoppede, alfabetisk innen gruppen. Kun `.service`, maks 200 (steg 5.9). */
export function servicesView(server: ServerDto, texts: ServerTexts, showAll = false): ServicesView {
  const units = (server.services?.units ?? []).filter((u) => u.name.endsWith('.service'));
  const failedSet = new Set(server.services?.failed ?? []);
  const restartSet = new Set(server.services?.needsRestart ?? []);
  const stateOf = (u: { name: string; state: string }): ServiceState => (u.state === 'failed' || failedSet.has(u.name) ? 'failed' : u.state === 'running' || u.state === 'active' ? 'running' : 'stopped');
  const rank: Record<ServiceState, number> = { failed: 0, running: 1, stopped: 2 };
  const rows = units
    .map<ServiceView>((u) => {
      const state = stateOf(u);
      return { name: u.name, state, dot: state === 'failed' ? 'down' : state === 'running' ? 'up' : 'paused', status: texts.t(state), needsRestart: !!u.needsRestart || restartSet.has(u.name) };
    })
    .sort((a, b) => rank[a.state] - rank[b.state] || a.name.localeCompare(b.name));
  const failed = rows.filter((r) => r.state === 'failed').length;
  const running = rows.filter((r) => r.state === 'running').length;
  const shown = showAll ? rows : rows.slice(0, SERVICES_MAX);
  return { head: `${failed} ${texts.t('failed')} · ${running} ${texts.t('running')}`, failed, running, rows: shown, hidden: rows.length - shown.length };
}

// ---- Vedlikehold ----------------------------------------------------------------------------------

export interface MaintView {
  chips: { label: string; value: string; tone: ChipTone }[];
  rebootRequired: boolean;
  /** «Triggered by: linux-image-…, libssl3» */
  triggeredBy: string;
  /** «ssh.service, nginx.service» */
  needsRestart: string;
  /** «checked 08:10», til `title` på hodet. */
  checked: string;
  ubuntu: string;
  support: string;
  eol: boolean;
  supportTone: BadgeTone;
}

export function maintView(server: ServerDto, item: ServerListItem | null, texts: ServerTexts): MaintView {
  const m = server.maintenance;
  const reboot = !!m?.rebootRequired;
  const updates = m?.updates ?? null;
  const security = m?.securityUpdates ?? null;
  const supportUntil = item?.supportUntil ? Date.parse(item.supportUntil) : NaN;
  const eol = !!item?.eol;
  return {
    chips: [
      { label: texts.t('rebootReq'), value: m ? texts.t(reboot ? 'yes' : 'no') : DASH, tone: reboot ? 'warn' : 'default' },
      { label: texts.t('pending'), value: updates === null ? DASH : String(updates), tone: 'default' },
      { label: texts.t('secUpd'), value: security === null ? DASH : String(security), tone: (security ?? 0) > 0 ? 'warn' : 'default' },
    ],
    rebootRequired: reboot,
    triggeredBy: reboot && m?.rebootPkgs?.length ? `${texts.t('triggeredBy')}: ${m.rebootPkgs.join(', ')}` : '',
    needsRestart: (server.services?.needsRestart ?? []).join(', '),
    checked: m?.checkedAt ? `${texts.t('checked')} ${texts.formatTimeShort(m.checkedAt)}` : '',
    ubuntu: osLabel(server.os) || 'Ubuntu',
    support: eol ? texts.t('eol') : Number.isFinite(supportUntil) ? `${texts.t('supported')} ${texts.formatMonthYear(supportUntil)}` : '',
    eol,
    supportTone: eol ? 'crit' : 'default',
  };
}

// ---- Sikkerhet ------------------------------------------------------------------------------------

export interface PortRow {
  key: string;
  port: number;
  proto: string;
  process: string;
  isNew: boolean;
}

export interface SecurityView {
  ports: PortRow[];
  users: string[];
  sshChips: { label: string; value: string; tone: ChipTone }[];
  /** «08:11:52 · root @ 45.33.12.9» */
  sshLast: string[];
  fwChips: { label: string; value: string; tone: ChipTone }[];
}

export const PORT_NEW_MS = DAY_MS;

/**
 * «new»-badge (steg 5.11): porter som ikke fantes i et tidligere øyeblikksbilde, i høyst 24 t. `known` er
 * «port/proto» → første gang sett (ms); tom første gang, da regnes ingenting som nytt (0 = kjent fra før).
 */
export function securityView(server: ServerDto, known: Record<string, number>, nowMs: number, texts: ServerTexts): SecurityView {
  const sec = server.security;
  const first = Object.keys(known).length === 0;
  const ports = (sec?.listeningPorts ?? [])
    .map<PortRow>((p) => {
      const key = `${p.port}/${p.proto}`;
      const seen = known[key];
      return { key, port: p.port, proto: p.proto, process: p.process ?? DASH, isNew: !first && seen !== undefined && seen > 0 && nowMs - seen < PORT_NEW_MS };
    })
    .sort((a, b) => a.port - b.port || a.proto.localeCompare(b.proto));
  const users = (sec?.loggedIn ?? []).map((u) => [u.user, u.from, u.tty, u.since ? texts.formatTimeShort(u.since) : ''].filter(Boolean).join(' · '));
  const ssh = sec?.sshFailed;
  const hour = ssh?.hour ?? null;
  const day = ssh?.day ?? null;
  const fw = sec?.firewall;
  const ufwActive = fw?.ufw === 'active';
  const f2b = fw?.fail2ban;
  const f2bPresent = !!f2b && f2b !== 'notfound' && f2b !== 'not found';
  return {
    ports,
    users,
    sshChips: [
      { label: texts.t('lastH'), value: hour === null ? DASH : String(hour), tone: (hour ?? 0) > 10 ? 'warn' : 'default' },
      { label: texts.t('lastD'), value: day === null ? DASH : String(day), tone: (day ?? 0) > 100 ? 'warn' : 'default' },
    ],
    sshLast: (ssh?.last ?? []).map((a) => `${a.at ? texts.formatTimeShort(a.at) : DASH} · ${a.user ?? '?'} @ ${a.from ?? '?'}`),
    fwChips: [
      { label: 'ufw', value: fw?.ufw ? (ufwActive ? texts.t('active') : fw.ufw === 'inactive' ? texts.t('off').toLowerCase() : texts.t('notFound')) : texts.t('notFound'), tone: ufwActive ? 'ok' : 'muted' },
      { label: 'fail2ban', value: f2bPresent ? `${fw?.blocked ?? fw?.banned ?? 0} ${texts.t('blocked')}` : texts.t('notFound'), tone: f2bPresent ? 'default' : 'muted' },
    ],
  };
}

/** Oppdaterer «kjente porter» for en server: nye nøkler får `nowMs` (eller 0 første gang). Returnerer samme objekt når ingenting er nytt. */
export function rememberPorts(known: Record<string, number>, server: ServerDto, nowMs: number): Record<string, number> {
  const ports = server.security?.listeningPorts;
  if (!ports) return known;
  const first = Object.keys(known).length === 0;
  let next: Record<string, number> | null = null;
  for (const p of ports) {
    const key = `${p.port}/${p.proto}`;
    if (known[key] !== undefined) continue;
    next ??= { ...known };
    next[key] = first ? 0 : nowMs;
  }
  return next ?? known;
}

// ---- Tekstmodus og «Copy snapshot» (bak flagg) ----------------------------------------------------

export function snapshotText(server: ServerDto, item: ServerListItem | null, texts: ServerTexts, nowMs: number): string {
  const h = headerView(server, item, texts);
  const cpu = cpuView(server, texts);
  const mem = memView(server, texts);
  const disk = diskView(server, texts);
  const net = netView(server);
  const cont = containersView(server, texts, nowMs);
  const svc = servicesView(server, texts, true);
  const lines = [
    `${h.name} · ${h.info} · ${h.uptime || h.statusText} · ${texts.formatTimeShort(nowMs)}`,
    `${texts.t('cpu')} ${cpu.head}`,
    `${texts.t('memory')} ${mem.head}`,
    ...disk.mounts.map((m) => `${texts.t('disk')} ${m.path} ${m.pct}% (${m.foot})`),
    `${texts.t('network')} ${net.head}`,
    `${texts.t('containers')} ${cont.head}`,
    `${texts.t('services')} ${svc.head}`,
  ];
  return lines.join('\n');
}
