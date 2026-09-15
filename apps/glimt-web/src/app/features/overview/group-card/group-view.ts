import { CardDto, GroupDto, NodeKind, ServerStatus } from '@core/live.types';
import { DASH, f1, GB, gbLabel } from '@shared/util/format';
import { CardTexts } from '../server-card/card-view';

/** Én kompakt medlemsrad på gruppekortet (steg 13.2): prikk, navn, type, CPU %, Mem %. */
export interface MemberRow {
  id: string;
  name: string;
  kind: NodeKind;
  status: ServerStatus;
  dot: 'up' | 'down' | 'paused';
  cpu: string;
  mem: string;
}

export interface GroupView {
  id: string;
  name: string;
  count: number;
  /** «4 nodes · 3 up · 1 sleeping» */
  summary: string;
  worst: ServerStatus;
  dot: 'up' | 'down' | 'paused';
  stripe: string;
  dimmed: boolean;
  /** «5.8 of 12 cores» */
  cpu: string;
  /** «14.2 of 32 GB» */
  mem: string;
  /** «2 active» */
  alerts: string;
  alertsTone: 'default' | 'warn' | 'crit';
  members: MemberRow[];
  empty: boolean;
  ariaLabel: string;
}

const STATUS_RANK: Record<ServerStatus, number> = { down: 0, sleeping: 1, paused: 2, up: 3 };

/** Verste status i gruppen: nede > sover > pauset > oppe. */
export function worstStatus(statuses: readonly ServerStatus[]): ServerStatus {
  let worst: ServerStatus = 'up';
  for (const s of statuses) if (STATUS_RANK[s] < STATUS_RANK[worst]) worst = s;
  return worst;
}

/** Summer over medlemmene som finnes i lageret: kjerner i bruk av totalt, GB i bruk av totalt, aktive varsler. */
export function groupSums(cards: readonly CardDto[]): { cpuCores: number; totalCores: number; memGb: number; totalGb: number; alerts: number } {
  let cpuCores = 0;
  let totalCores = 0;
  let memGb = 0;
  let totalGb = 0;
  let alerts = 0;
  for (const c of cards) {
    const up = c.status === 'up';
    const cores = c.cores ?? 0;
    const gb = (c.ramBytes ?? 0) / GB;
    totalCores += cores;
    totalGb += gb;
    if (up) {
      cpuCores += ((c.cpu ?? 0) / 100) * cores;
      memGb += ((c.mem ?? 0) / 100) * gb;
    }
    alerts += c.activeAlerts;
  }
  return { cpuCores, totalCores, memGb, totalGb, alerts };
}

export function groupView(group: GroupDto, cardsById: ReadonlyMap<string, CardDto>, texts: CardTexts): GroupView {
  const cards = group.memberIds.map((id) => cardsById.get(id)).filter((c): c is CardDto => !!c);
  const count = cards.length;
  const up = cards.filter((c) => c.status === 'up').length;
  const down = cards.filter((c) => c.status === 'down').length;
  const sleeping = cards.filter((c) => c.status === 'sleeping').length;
  const paused = cards.filter((c) => c.status === 'paused').length;
  const worst = count === 0 ? 'up' : worstStatus(cards.map((c) => c.status));
  const sums = groupSums(cards);
  const summaryParts = [`${count} ${texts.t(count === 1 ? 'node' : 'nodes').toLowerCase()}`, `${up} ${texts.t('up')}`];
  if (down > 0) summaryParts.push(`${down} ${texts.t('down')}`);
  if (sleeping > 0) summaryParts.push(`${sleeping} ${texts.t('sleeping')}`);
  if (paused > 0) summaryParts.push(`${paused} ${texts.t('paused')}`);
  const members = cards.map<MemberRow>((c) => ({
    id: c.id,
    name: c.name,
    kind: c.kind ?? 'server',
    status: c.status,
    dot: c.status === 'up' ? 'up' : c.status === 'down' ? 'down' : 'paused',
    cpu: c.status === 'up' && c.cpu !== null ? `${Math.round(c.cpu)}%` : DASH,
    mem: c.status === 'up' && c.mem !== null ? `${Math.round(c.mem)}%` : DASH,
  }));
  const cpu = sums.totalCores > 0 ? `${f1(sums.cpuCores)} ${texts.t('of')} ${sums.totalCores} ${texts.t('cores')}` : DASH;
  const mem = sums.totalGb > 0 ? `${f1(sums.memGb)} ${texts.t('of')} ${gbLabel(sums.totalGb * GB)} GB` : DASH;
  const alerts = `${sums.alerts} ${texts.t('active')}`;
  const worstSeverity = cards.reduce<string | null>((acc, c) => (c.alertSeverity === 'critical' || acc === 'critical' ? 'critical' : (c.alertSeverity ?? acc)), null);
  return {
    id: group.id,
    name: group.name,
    count,
    summary: count === 0 ? texts.t('noNodesYet') : summaryParts.join(' · '),
    worst,
    dot: worst === 'up' ? 'up' : worst === 'down' ? 'down' : 'paused',
    stripe: worst === 'down' ? 'var(--color-crit)' : worst === 'up' ? 'transparent' : 'var(--color-neutral)',
    dimmed: count > 0 && up === 0,
    cpu,
    mem,
    alerts,
    alertsTone: sums.alerts === 0 ? 'default' : worstSeverity === 'critical' ? 'crit' : 'warn',
    members,
    empty: count === 0,
    ariaLabel: `${group.name}: ${count === 0 ? texts.t('noNodesYet') : summaryParts.join(', ')}, ${texts.t('cpu')} ${cpu}, ${texts.t('memory')} ${mem}, ${texts.t('alerts')} ${alerts}`,
  };
}
