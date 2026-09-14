import { I18nKey } from '@core/i18n.service';
import { CardDto, ServerStatus } from '@core/live.types';
import { ChipTone } from '@shared/chip/chip.component';
import { formatDuration, formatRate } from '@shared/util/format';

/** Det kortet trenger fra I18nService (så funksjonene kan testes uten Angular). */
export interface CardTexts {
  t(key: I18nKey): string;
  /** "03:12" i dag, "yesterday 21:04", ellers dato. */
  formatWhen(ms: number): string;
}

export interface CardView {
  id: string;
  name: string;
  tags: string[];
  status: ServerStatus;
  /** Nede og pauset vises med opasitet .6. */
  dimmed: boolean;
  dot: 'up' | 'down' | 'paused';
  statusText: string;
  /** CSS-farge på 3 px-stripen øverst; gjennomsiktig uten varsel. */
  stripe: string;
  info: string;
  cpu: number;
  mem: number;
  disk: number;
  cpuSub: string;
  memSub: string;
  diskSub: string;
  net: string;
  containers: string;
  containersTone: ChipTone;
  updates: string;
  updatesTone: ChipTone;
  reboot: string;
  rebootTone: ChipTone;
  services: string;
  servicesTone: ChipTone;
  ariaLabel: string;
}

const GB = 1024 ** 3;
const DASH = '—';

/** Prototypens `f1`: én desimal, alltid. */
export function f1(n: number): string {
  return (Math.round(n * 10) / 10).toFixed(1);
}

/** 8 GB-maskin → "8", 7.8 → "7.8" (ingen ".0"). */
export function gbLabel(bytes: number | null): string {
  if (!bytes || bytes <= 0) return DASH;
  const gb = Math.round((bytes / GB) * 10) / 10;
  return Number.isInteger(gb) ? String(gb) : gb.toFixed(1);
}

/** "Ubuntu 24.04.3 LTS" + versionId "24.04" → "Ubuntu 24.04" (som designet); ellers os slik den er. */
export function osShort(card: Pick<CardDto, 'os' | 'versionId'>): string {
  if (card.os && card.versionId && /^ubuntu/i.test(card.os)) return `Ubuntu ${card.versionId}`;
  return card.os ?? '';
}

export function severityColor(card: Pick<CardDto, 'activeAlerts' | 'status' | 'alertSeverity'>): string {
  if (card.status === 'paused' || !(card.activeAlerts > 0)) return 'transparent';
  if (card.alertSeverity === 'warning') return 'var(--color-warn)';
  if (card.alertSeverity === 'info') return 'var(--color-info)';
  return 'var(--color-crit)';
}

export function cardView(card: CardDto, texts: CardTexts): CardView {
  const up = card.status === 'up';
  const paused = card.status === 'paused';
  const cpu = up ? (card.cpu ?? 0) : 0;
  const mem = up ? (card.mem ?? 0) : 0;
  const disk = up ? (card.diskWorst?.pct ?? 0) : 0;
  const cores = card.cores ?? 0;
  const ramGb = card.ramBytes ? card.ramBytes / GB : 0;

  const statusText = paused
    ? texts.t('paused')
    : up
      ? texts.t('liveLabel')
      : card.lastSeenAt
        ? `${texts.t('lastSeen')} ${texts.formatWhen(Date.parse(card.lastSeenAt))}`
        : texts.t('down');

  const infoParts = [
    osShort(card),
    cores > 0 ? `${cores} ${texts.t('cores')}` : '',
    card.ramBytes ? `${gbLabel(card.ramBytes)} GB` : '',
    up && card.uptimeSec !== null && card.uptimeSec !== undefined ? `${texts.t('uptime')} ${formatDuration(card.uptimeSec)}` : '',
  ].filter(Boolean);

  const net = up && card.netRx !== null && card.netTx !== null ? `↓${formatRate(card.netRx)} ↑${formatRate(card.netTx)}` : DASH;
  const containers = card.containersTotal > 0 ? `${card.containersRunning} / ${card.containersTotal}` : DASH;
  const updates = card.updates === null || card.updates === undefined ? DASH : card.updates > 0 ? `${card.updates} (${card.securityUpdates ?? 0})` : '0';
  const reboot = card.rebootRequired ? texts.t('required') : DASH;
  const services = card.failedServices > 0 ? `${card.failedServices} ${texts.t('failed')}` : texts.t('ok');

  return {
    id: card.id,
    name: card.name,
    tags: card.tags,
    status: card.status,
    dimmed: !up,
    dot: paused ? 'paused' : up ? 'up' : 'down',
    statusText,
    stripe: severityColor(card),
    info: infoParts.join(' · '),
    cpu,
    mem,
    disk,
    cpuSub: cores > 0 ? `${f1((cpu / 100) * cores)} ${texts.t('of')} ${cores} ${texts.t('cores')}` : '',
    memSub: ramGb > 0 ? `${f1((mem / 100) * ramGb)} ${texts.t('of')} ${gbLabel(card.ramBytes)} GB` : '',
    diskSub: card.diskWorst ? `${card.diskWorst.path} ${Math.round(disk)}%` : DASH,
    net,
    containers,
    containersTone: card.containersBad > 0 ? 'swap' : 'default',
    updates,
    updatesTone: (card.securityUpdates ?? 0) > 0 ? 'warn' : 'default',
    reboot,
    rebootTone: card.rebootRequired ? 'warn' : 'muted',
    services,
    servicesTone: card.failedServices > 0 ? 'crit' : 'default',
    ariaLabel: `${card.name}: ${statusText}, ${texts.t('cpu')} ${Math.round(cpu)}%, ${texts.t('memory')} ${Math.round(mem)}%, ${texts.t('disk')} ${Math.round(disk)}%`,
  };
}
