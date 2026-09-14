import { ServerDto } from '@core/live.types';
import { panelsFor } from './server.page';
import { containersView, headerView, healthView, hostView, memView, ServerTexts } from './server-view';
import { demoServer, NOW } from './server.fixtures';

const texts: ServerTexts = {
  t: (k) => k,
  formatWhen: (ms) => `@${ms}`,
  formatDate: (ms) => `d${ms}`,
  formatTimeShort: (ms) => `t${ms}`,
  formatMonthYear: (ms) => `m${ms}`,
};

const GB = 1024 ** 3;

function node(over: Partial<ServerDto> = {}): ServerDto {
  const base = demoServer();
  return {
    ...base,
    id: 'demo-acme-backend',
    name: 'acme-backend',
    kind: 'container',
    image: 'ghcr.io/acme/backend:2.4.1',
    cores: 2,
    host: { ...base.host!, limits: { cpuCores: 2, memBytes: 1 * GB }, mem: { total: GB, used: 0.4 * GB, free: 0.6 * GB, buffers: 0, cached: 0, swapTotal: 0, swapUsed: 0 } },
    health: { url: 'http://127.0.0.1:3000/healthz', ok: true, status: 200, ms: 12, checkedAt: NOW },
    checks: [
      { name: 'db', target: 'postgres:5432', ok: true, ms: 3 },
      { name: 'cache', target: 'redis:6379', ok: false, ms: 2000, error: 'timeout' },
    ],
    hostServer: { serverId: 'demo-web-02', name: 'web-02' },
    hostContainer: { id: 'abc', name: 'web-api', image: 'ghcr.io/acme/backend:2.4.1', imageCreated: NOW - 3 * 86_400_000, state: 'running', restartCount: 1, memLimit: 512 * 1024 ** 2 },
    logPaths: ['/var/log/app/app.log'],
    services: null,
    maintenance: null,
    containers: null,
    ...over,
  };
}

/** Containernodens avledninger (steg 12.9): topp, helse og sjekker, verten, minne uten grense, paneler etter type. */
describe('containernodens side', () => {
  it('toppen viser container, image, tildelte kjerner, grense og verten', () => {
    const h = headerView(node(), null, texts);
    expect(h.isContainer).toBe(true);
    expect(h.image).toBe('ghcr.io/acme/backend:2.4.1');
    expect(h.info).toBe('containerLabel · 2 cpuLimit · 1 GB memLimitOf');
    expect(h.onHost).toEqual({ serverId: 'demo-web-02', name: 'web-02' });
    expect(h.eol).toBe(false);
    expect(h.support).toBe('');
  });

  it('sovende node: nøytral prikk og «sleeping since»', () => {
    const h = headerView(node({ status: 'sleeping', connected: false, lastSeenAt: new Date(NOW).toISOString() }), null, texts);
    expect(h.dot).toBe('paused');
    expect(h.statusText).toBe(`sleepingSince @${NOW}`);
    expect(h.down).toBe(false);
  });

  it('uten grense og uten cgroup: «no limit» og «approx» i toppen, minnehodet sier no limit', () => {
    const n = node({ approx: true, host: { ...node().host!, limits: { cpuCores: null, memBytes: null } } });
    expect(headerView(n, null, texts).info).toBe('containerLabel · 2 cpuLimit · noLimit · approx');
    expect(memView(n, texts).head).toMatch(/ · noLimit$/);
    expect(memView(node(), texts).head).not.toMatch(/swap/);
  });

  it('helse og sjekker: linje, tidspunkt, rader og tone', () => {
    const v = healthView(node(), texts);
    expect(v.configured).toBe(true);
    expect(v.line).toBe('GET /healthz · 200 · 12 ms');
    expect(v.checked).toBe(`checkedAt t${NOW}`);
    expect(v.checks.map((c) => [c.name, c.ok, c.text])).toEqual([
      ['db', true, '3 ms'],
      ['cache', false, 'timeout'],
    ]);
    expect(v.tone).toBe('crit');
    expect(v.head).toBe('ok · 1/2 checks');

    const failing = healthView(node({ health: { url: 'http://127.0.0.1:3000/healthz', ok: false, status: 503, ms: 1240, checkedAt: NOW }, checks: [] }), texts);
    expect(failing.line).toBe('GET /healthz · 503 · 1240 ms');
    expect(failing.tone).toBe('crit');
    expect(failing.head).toBe('healthFail');

    const none = healthView(node({ health: null, checks: null }), texts);
    expect(none.configured).toBe(false);
    expect(none.tone).toBe('neutral');
    expect(none.head).toBe('—');
  });

  it('verten: image, alder, omstarter, tilstand og grense fra vertsagenten', () => {
    const v = hostView(node(), texts, NOW)!;
    expect(v).toEqual({ serverId: 'demo-web-02', name: 'web-02', image: 'ghcr.io/acme/backend:2.4.1', age: '3 days', restarts: '1', state: 'running', memLimit: '512 MB' });
    expect(hostView(node({ hostServer: null, hostContainer: null }), texts, NOW)).toBeNull();
  });

  it('panelene følger typen; verten bare når lenket', () => {
    expect(panelsFor('server', false)).toEqual(['cpu', 'mem', 'disk', 'net', 'proc', 'cont', 'svc', 'maint', 'sec', 'logs']);
    expect(panelsFor('container', true)).toEqual(['cpu', 'mem', 'disk', 'net', 'proc', 'ports', 'health', 'host', 'logs']);
    expect(panelsFor('container', false)).not.toContain('host');
  });

  it('vertens containerrad får node-id når containeren er en egen node', () => {
    const host = demoServer({ linkedNodes: { [demoServer().containers![0].id]: 'demo-acme-backend' } });
    const rows = containersView(host, texts, NOW).rows;
    expect(rows.find((r) => r.id === demoServer().containers![0].id)?.nodeId).toBe('demo-acme-backend');
    expect(rows.filter((r) => r.nodeId).length).toBe(1);
  });
});
