import { CardDto } from '@core/live.types';

/**
 * De 16 demoserverne fra hubens DemoData (design/glimtData.js) som kort, til testene i fase 4.
 * Tallene er «typiske» verdier for hver server, ikke levende. nordic-db er nede siden 03:12, media er pauset
 * (tilstanden finnes selv om pause er Neste), backup har 31 oppdateringer (14 sikkerhet).
 */
const GB = 1024 ** 3;
const MB = 1024 ** 2;

interface Def {
  name: string;
  tags: string[];
  cores: number;
  ramGb: number;
  ubuntu: string;
  cpu: number;
  mem: number;
  disk: [string, number];
  containers: number;
  bad?: number;
  updates: number;
  security: number;
  reboot?: boolean;
  failed?: number;
  status?: 'up' | 'down' | 'paused';
  alerts?: number;
  uptimeDays: number;
}

const DEFS: Def[] = [
  { name: 'web-01', tags: ['prod'], cores: 4, ramGb: 8, ubuntu: '24.04', cpu: 34, mem: 62, disk: ['/var', 66], containers: 8, bad: 1, updates: 3, security: 1, uptimeDays: 12 },
  { name: 'web-02', tags: ['prod'], cores: 4, ramGb: 8, ubuntu: '24.04', cpu: 48, mem: 61, disk: ['/', 92], containers: 6, updates: 7, security: 2, alerts: 1, uptimeDays: 41 },
  { name: 'api-prod', tags: ['prod'], cores: 8, ramGb: 16, ubuntu: '24.04', cpu: 96, mem: 71, disk: ['/', 58], containers: 9, updates: 0, security: 0, alerts: 1, uptimeDays: 6 },
  { name: 'db-prod', tags: ['prod'], cores: 8, ramGb: 32, ubuntu: '22.04', cpu: 28, mem: 79, disk: ['/data', 71], containers: 1, updates: 12, security: 4, reboot: true, uptimeDays: 98 },
  { name: 'worker-01', tags: ['prod'], cores: 4, ramGb: 8, ubuntu: '24.04', cpu: 44, mem: 52, disk: ['/', 38], containers: 5, updates: 2, security: 0, failed: 1, alerts: 1, uptimeDays: 3 },
  { name: 'cache-01', tags: ['prod'], cores: 2, ramGb: 4, ubuntu: '24.04', cpu: 12, mem: 84, disk: ['/', 21], containers: 2, updates: 1, security: 0, uptimeDays: 21 },
  { name: 'staging-web', tags: ['staging'], cores: 2, ramGb: 4, ubuntu: '24.04', cpu: 18, mem: 44, disk: ['/', 55], containers: 7, updates: 4, security: 1, uptimeDays: 7 },
  { name: 'staging-db', tags: ['staging'], cores: 2, ramGb: 8, ubuntu: '24.04', cpu: 9, mem: 62, disk: ['/', 47], containers: 1, updates: 0, security: 0, uptimeDays: 15 },
  { name: 'acme-app', tags: ['client-a'], cores: 4, ramGb: 8, ubuntu: '24.04', cpu: 38, mem: 58, disk: ['/', 66], containers: 11, bad: 1, updates: 9, security: 3, alerts: 1, uptimeDays: 2 },
  { name: 'acme-db', tags: ['client-a'], cores: 4, ramGb: 16, ubuntu: '22.04', cpu: 21, mem: 74, disk: ['/data', 83], containers: 1, updates: 5, security: 2, uptimeDays: 63 },
  { name: 'nordic-shop', tags: ['client-b'], cores: 4, ramGb: 8, ubuntu: '26.04', cpu: 52, mem: 49, disk: ['/', 44], containers: 9, updates: 2, security: 0, uptimeDays: 9 },
  { name: 'nordic-db', tags: ['client-b'], cores: 4, ramGb: 16, ubuntu: '24.04', cpu: 0, mem: 0, disk: ['/data', 61], containers: 1, updates: 0, security: 0, status: 'down', alerts: 1, uptimeDays: 0 },
  { name: 'nas', tags: ['homelab'], cores: 4, ramGb: 16, ubuntu: '24.04', cpu: 6, mem: 35, disk: ['/mnt/pool', 86], containers: 4, updates: 3, security: 1, uptimeDays: 120 },
  { name: 'pi-hole', tags: ['homelab'], cores: 4, ramGb: 4, ubuntu: '24.04', cpu: 3, mem: 28, disk: ['/', 19], containers: 2, updates: 1, security: 0, uptimeDays: 200 },
  { name: 'media', tags: ['homelab'], cores: 6, ramGb: 16, ubuntu: '24.04', cpu: 14, mem: 41, disk: ['/', 58], containers: 5, updates: 0, security: 0, status: 'paused', uptimeDays: 4 },
  { name: 'backup', tags: ['homelab'], cores: 2, ramGb: 4, ubuntu: '20.04', cpu: 4, mem: 23, disk: ['/backup', 78], containers: 0, updates: 31, security: 14, uptimeDays: 311 },
];

export function demoCard(def: Def, i: number): CardDto {
  const status = def.status ?? 'up';
  const up = status === 'up';
  const series = Array.from({ length: 120 }, (_, k) => (up ? Math.round(def.cpu + 5 * Math.sin(k / 8)) : null));
  return {
    id: `demo-${def.name}`,
    name: def.name,
    hostname: def.name,
    tags: def.tags,
    status,
    connected: status !== 'down',
    lastSeenAt: status === 'down' ? '2026-09-09T01:12:00Z' : '2026-09-09T06:14:05Z',
    os: `Ubuntu ${def.ubuntu}${def.ubuntu === '24.04' ? '.3' : ''} LTS`,
    versionId: def.ubuntu,
    arch: 'amd64',
    cores: def.cores,
    ramBytes: def.ramGb * GB,
    uptimeSec: up ? def.uptimeDays * 86400 + 4 * 3600 : null,
    cpu: up ? def.cpu : null,
    mem: up ? def.mem : null,
    diskWorst: up ? { path: def.disk[0], pct: def.disk[1] } : null,
    netRx: up ? (14.8 + i) * MB : null,
    netTx: up ? 1.2 * MB : null,
    containersRunning: def.containers - (def.bad ?? 0),
    containersTotal: def.containers,
    containersBad: def.bad ?? 0,
    updates: def.updates,
    securityUpdates: def.security,
    rebootRequired: def.reboot ?? false,
    failedServices: def.failed ?? 0,
    activeAlerts: def.alerts ?? 0,
    alertSeverity: def.alerts ? (def.name === 'web-02' ? 'critical' : 'warning') : null,
    cpuLastHour: series,
    memLastHour: series.map((v) => (v === null ? null : Math.round(def.mem))),
  };
}

export const DEMO_CARDS: CardDto[] = DEFS.map(demoCard);

export function demoCardByName(name: string): CardDto {
  const c = DEMO_CARDS.find((x) => x.name === name);
  if (!c) throw new Error(`no demo card named ${name}`);
  return c;
}
