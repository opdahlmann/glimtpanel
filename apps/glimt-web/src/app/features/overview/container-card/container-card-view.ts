import { CardDto, ServerStatus } from '@core/live.types';
import { ChipTone } from '@shared/chip/chip.component';
import { DASH, f1, formatDuration, formatRate, GB, gbLabel } from '@shared/util/format';
import { CardTexts, severityColor } from '../server-card/card-view';

/** Det containerkortet tegner (steg 12.8, skjerm 20). Rene avledninger av `CardDto` med `kind: container`. */
export interface ContainerCardView {
  id: string;
  name: string;
  tags: string[];
  status: ServerStatus;
  /** Nede, sovende og pauset vises med opasitet .6. */
  dimmed: boolean;
  dot: 'up' | 'down' | 'paused';
  statusText: string;
  stripe: string;
  /** «container · nginx:1.27 · up 3d 4h · on web-02» */
  info: string;
  cpu: number;
  mem: number;
  cpuSub: string;
  memSub: string;
  /** Uten cgroup: «≈» foran prosentene med forklaring i `title`. */
  approx: boolean;
  net: string;
  restarts: string;
  restartsTone: ChipTone;
  health: string;
  healthTone: ChipTone;
  ports: string;
  onHost: string | null;
  image: string | null;
  ariaLabel: string;
}

/** «Restarts» blir oransje over dette antallet siste 24 t (CI 8). */
export const RESTARTS_WARN_OVER = 3;

export function containerCardView(card: CardDto, texts: CardTexts): ContainerCardView {
  const up = card.status === 'up';
  const sleeping = card.status === 'sleeping';
  const paused = card.status === 'paused';
  const cpu = up ? (card.cpu ?? 0) : 0;
  const mem = up ? (card.mem ?? 0) : 0;
  const cores = card.cores ?? 0;
  const limitGb = card.memLimit ? card.memLimit / GB : 0;
  const totalGb = card.ramBytes ? card.ramBytes / GB : 0;
  const approx = card.approx === true;

  const statusText = sleeping
    ? `${texts.t('sleepingSince')} ${card.lastSeenAt ? texts.formatWhen(Date.parse(card.lastSeenAt)) : ''}`.trim()
    : paused
      ? texts.t('paused')
      : up
        ? texts.t('liveLabel')
        : card.lastSeenAt
          ? `${texts.t('lastSeen')} ${texts.formatWhen(Date.parse(card.lastSeenAt))}`
          : texts.t('down');

  const infoParts = [
    texts.t('containerLabel'),
    card.image ?? '',
    up && card.uptimeSec !== null && card.uptimeSec !== undefined ? `${texts.t('uptime')} ${formatDuration(card.uptimeSec)}` : '',
    card.onHost ? `${texts.t('onHost')} ${card.onHost}` : '',
  ].filter(Boolean);

  const prefix = approx && up ? '≈' : '';
  const cpuSub = cores > 0 ? `${prefix}${f1((cpu / 100) * cores)} ${texts.t('of')} ${cores} ${texts.t('cores')}` : '';
  const memSub = limitGb > 0 ? `${prefix}${f1((mem / 100) * limitGb)} ${texts.t('of')} ${gbLabel(card.memLimit)} GB` : totalGb > 0 ? `${prefix}${f1((mem / 100) * totalGb)} GB · ${texts.t('noLimit')}` : texts.t('noLimit');

  const net = up && card.netRx !== null && card.netTx !== null ? `↓${formatRate(card.netRx)} ↑${formatRate(card.netTx)}` : DASH;
  const restarts = card.restarts24h ?? 0;
  const health = card.health === 'ok' ? texts.t('ok') : card.health === 'fail' ? texts.t('healthFail') : DASH;

  return {
    id: card.id,
    name: card.name,
    tags: card.tags,
    status: card.status,
    dimmed: !up,
    dot: up ? 'up' : card.status === 'down' ? 'down' : 'paused',
    statusText,
    stripe: severityColor(card),
    info: infoParts.join(' · '),
    cpu,
    mem,
    cpuSub,
    memSub,
    approx,
    net,
    restarts: String(restarts),
    restartsTone: restarts > RESTARTS_WARN_OVER ? 'warn' : 'default',
    health,
    healthTone: card.health === 'fail' ? 'crit' : card.health === 'ok' ? 'ok' : 'muted',
    ports: card.ports === null || card.ports === undefined ? DASH : String(card.ports),
    onHost: card.onHost,
    image: card.image,
    ariaLabel: `${card.name}: ${statusText}, ${texts.t('cpu')} ${Math.round(cpu)}%, ${texts.t('memory')} ${Math.round(mem)}%`,
  };
}
