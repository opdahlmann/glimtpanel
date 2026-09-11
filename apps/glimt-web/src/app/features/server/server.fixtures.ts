import { ContainerInfo, ServerDto } from '@core/live.types';

/**
 * Demoserveren web-02 slik hubens FakeServer sender den (Server-projeksjonen), med typiske verdier fra
 * DemoData: 4 kjerner, 8 GB, Ubuntu 24.04, CPU 48 %, minne 61 %, `/` 92 %, seks containere, én feilet tjeneste
 * kun på worker-01 (ikke her). Tidene er relative til `NOW`.
 */
export const GB = 1024 ** 3;
export const MB = 1024 ** 2;
export const NOW = Date.UTC(2026, 8, 10, 6, 14, 5);
const BOOT = NOW - (41 * 86_400 + 2 * 3600) * 1000;

export function demoContainer(over: Partial<ContainerInfo> & Pick<ContainerInfo, 'id' | 'name'>): ContainerInfo {
  return {
    image: 'nginx:1.27',
    imageCreated: NOW - 12 * 86_400_000,
    state: 'running',
    health: 'healthy',
    restartCount: 0,
    startedAt: NOW - (3 * 86_400 + 4 * 3600) * 1000,
    cpuPct: 2.1,
    memBytes: 412 * MB,
    memLimit: 1024 * MB,
    rxBps: 0.4 * MB,
    txBps: 0.1 * MB,
    ports: ['80→8080', '443→8443'],
    mounts: ['./nginx → /etc/nginx/conf.d'],
    compose: 'web',
    ...over,
  };
}

export function demoServer(over: Partial<ServerDto> = {}): ServerDto {
  const total = 8 * GB;
  const used = 0.61 * total;
  return {
    id: 'demo-web-02',
    name: 'web-02',
    hostname: 'web-02',
    tags: ['prod'],
    status: 'up',
    connected: true,
    lastSeenAt: new Date(NOW).toISOString(),
    agentVersion: '0.1.0',
    os: { id: 'ubuntu', versionId: '24.04', prettyName: 'Ubuntu 24.04.3 LTS' },
    kernel: '6.8.0-45-generic',
    arch: 'x86_64',
    cores: 4,
    ramBytes: total,
    dockerMode: 'proxy',
    bootTime: BOOT,
    uptimeSec: 41 * 86_400 + 2 * 3600,
    host: {
      cpu: { total: 48, user: 34, system: 11, iowait: 3.8, perCore: [52, 40, 61, 39] },
      load: [1.9, 1.4, 1.1],
      mem: { total, used, free: total - used - total / 20, buffers: total / 100, cached: total / 25, swapTotal: 2 * GB, swapUsed: 0.4 * GB },
      uptimeSec: 41 * 86_400 + 2 * 3600,
      mounts: [
        { path: '/', fs: 'ext4', total: 80 * GB, used: 0.92 * 80 * GB, inodesTotal: 5_242_880, inodesUsed: 629_146, readBps: 3.2 * MB, writeBps: 11 * MB },
        { path: '/data', fs: 'xfs', total: 1000 * GB, used: 0.52 * 1000 * GB, inodesTotal: 5_242_880, inodesUsed: 100_000, readBps: 0, writeBps: 0 },
      ],
      ifaces: [
        { name: 'eth0', ips: ['10.0.1.12', 'fe80::1'], rxBps: 14.8 * MB, txBps: 1.2 * MB },
        { name: 'docker0', ips: ['172.17.0.1'], rxBps: 0.5 * MB, txBps: 0.2 * MB },
      ],
    },
    processes: [
      { pid: 4410, name: 'python3', user: 'ole', cpuPct: 61.9, rssBytes: 220 * MB, startedAt: NOW - (12 * 60 + 33) * 1000, cmdline: 'python3 -m http.server 8000' },
      { pid: 1, name: 'systemd', user: 'root', cpuPct: 0.4, rssBytes: 12 * MB, startedAt: BOOT, cmdline: '/sbin/init' },
      { pid: 1182, name: 'nginx', user: 'www-data', cpuPct: 3.2, rssBytes: 1.5 * 1024 * MB, startedAt: BOOT + 90_000, cmdline: 'nginx: worker process' },
    ],
    processTotals: { total: 182, running: 2, blocked: 0 },
    containers: [
      demoContainer({ id: 'c0web', name: 'web-web' }),
      demoContainer({ id: 'c1api', name: 'web-api', image: 'node:22-alpine', cpuPct: 8.5, memBytes: 300 * MB, memLimit: 512 * MB, health: 'none', restartCount: 1, imageCreated: NOW - 120 * 86_400_000 }),
      demoContainer({ id: 'c2cron', name: 'web-cron', image: 'alpine:3.20', state: 'exited', cpuPct: 0, memBytes: 0, memLimit: 0, startedAt: null, health: 'none' }),
      demoContainer({ id: 'c3wrk', name: 'web-worker', image: 'ghcr.io/acme/worker:2.4.1', state: 'restarting', restartCount: 7, startedAt: NOW - 41_000, memLimit: 0, memBytes: 900 * MB, cpuPct: 1 }),
    ],
    services: {
      units: [
        { name: 'nginx.service', state: 'running' },
        { name: 'docker.service', state: 'running' },
        { name: 'ssh.service', state: 'running', needsRestart: true },
        { name: 'postgresql.service', state: 'stopped' },
        { name: 'cron-sync.service', state: 'failed' },
        { name: 'systemd-tmpfiles-clean.timer', state: 'running' },
      ],
      failed: ['cron-sync.service'],
      needsRestart: ['ssh.service'],
    },
    maintenance: { rebootRequired: true, rebootPkgs: ['linux-image-6.8.0-45-generic', 'libssl3'], updates: 7, securityUpdates: 2, checkedAt: NOW - 4 * 60_000 },
    security: {
      listeningPorts: [
        { port: 443, proto: 'tcp', process: 'nginx', pid: 1182 },
        { port: 22, proto: 'tcp', process: 'sshd', pid: 812 },
        { port: 80, proto: 'tcp', process: 'nginx', pid: 1182 },
      ],
      loggedIn: [{ user: 'ole', from: '10.0.0.12', tty: 'pts/0', since: NOW - 33 * 60_000 }],
      sshFailed: { hour: 12, day: 84, last: [{ user: 'root', from: '45.33.12.9', at: NOW - 3 * 60_000 }, { user: 'admin', from: '185.220.101.4', at: NOW - 6 * 60_000 }] },
      firewall: { ufw: 'active', fail2ban: 'active', banned: 14, blocked: 42 },
    },
    snapshotAt: new Date(NOW - 10_000).toISOString(),
    streamAt: new Date(NOW).toISOString(),
    ...over,
  };
}

/** nordic-db nede siden 03:12 (skjerm 16): siste kjente tall, ingen prosesser. */
export function demoDownServer(): ServerDto {
  const s = demoServer({ id: 'demo-nordic-db', name: 'nordic-db', hostname: 'nordic-db', tags: ['client-b'], status: 'down', connected: false, lastSeenAt: new Date(NOW - 3 * 3600_000).toISOString(), uptimeSec: null, processes: null, processTotals: null });
  return s;
}
