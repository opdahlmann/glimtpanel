import { CardDto } from '@core/live.types';
import { demoCard } from '../overview.fixtures';
import { containerCardView } from './container-card-view';

const GB = 1024 ** 3;
const texts = { t: (k: string) => k, formatWhen: (ms: number) => `@${ms}` };

function node(over: Partial<CardDto> = {}): CardDto {
  return {
    ...demoCard({ name: 'acme-backend', tags: ['prod'], cores: 2, ramGb: 1, ubuntu: '24.04', cpu: 31, mem: 58, disk: ['/', 38], containers: 0, updates: 0, security: 0, uptimeDays: 3 }, 0),
    kind: 'container',
    health: 'ok',
    approx: false,
    onHost: 'web-02',
    image: 'ghcr.io/acme/backend:2.4.1',
    restarts24h: 1,
    memLimit: 1 * GB,
    ports: 1,
    ...over,
  };
}

describe('containerCardView', () => {
  it('infolinje, ringer mot tildelte kjerner og grense, fire chips', () => {
    const v = containerCardView(node(), texts);
    expect(v.info).toBe('containerLabel · ghcr.io/acme/backend:2.4.1 · uptime 3d 4h · onHost web-02');
    expect(v.cpu).toBe(31);
    expect(v.cpuSub).toBe('0.6 of 2 cores');
    expect(v.memSub).toBe('0.6 of 1 GB');
    expect(v.health).toBe('ok');
    expect(v.healthTone).toBe('ok');
    expect(v.restarts).toBe('1');
    expect(v.restartsTone).toBe('default');
    expect(v.ports).toBe('1');
    expect(v.approx).toBe(false);
    expect(v.dot).toBe('up');
    expect(v.dimmed).toBe(false);
    expect(v.ariaLabel).toBe('acme-backend: liveLabel, cpu 31%, memory 58%');
  });

  it('sleeping: nøytral prikk, «sleeping since», ringer på 0, nedtonet', () => {
    const v = containerCardView(node({ status: 'sleeping', connected: false, lastSeenAt: '2026-09-14T00:02:00Z', cpu: 40, mem: 50 }), texts);
    expect(v.dot).toBe('paused');
    expect(v.statusText).toBe(`sleepingSince @${Date.parse('2026-09-14T00:02:00Z')}`);
    expect(v.cpu).toBe(0);
    expect(v.mem).toBe(0);
    expect(v.dimmed).toBe(true);
    expect(v.net).toBe('—');
  });

  it('approx gir «≈» foran tallene, uten grense vises minnet i GB med «no limit»', () => {
    const v = containerCardView(node({ approx: true, memLimit: null, ramBytes: 16 * GB, mem: 25, onHost: null }), texts);
    expect(v.approx).toBe(true);
    expect(v.cpuSub.startsWith('≈')).toBe(true);
    expect(v.memSub).toBe('≈4.0 GB · noLimit');
    expect(v.info).toBe('containerLabel · ghcr.io/acme/backend:2.4.1 · uptime 3d 4h');
  });

  it('feilet helsesjekk og mange omstarter tones', () => {
    const v = containerCardView(node({ health: 'fail', restarts24h: 5, ports: null }), texts);
    expect(v.health).toBe('healthFail');
    expect(v.healthTone).toBe('crit');
    expect(v.restartsTone).toBe('warn');
    expect(v.ports).toBe('—');
    const none = containerCardView(node({ health: 'none' }), texts);
    expect(none.health).toBe('—');
    expect(none.healthTone).toBe('muted');
  });
});
