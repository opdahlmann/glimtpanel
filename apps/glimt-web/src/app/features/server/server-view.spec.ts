import en from '@i18n/en.json';
import { I18nKey } from '@core/i18n.service';
import { containersView, cpuView, diskSize, diskView, headerView, maintView, memSize, memView, netView, procView, rememberPorts, securityView, servicesView, snapshotText, ServerTexts } from './server-view';
import { demoDownServer, demoServer, GB, MB, NOW } from './server.fixtures';

const texts: ServerTexts = {
  t: (key: I18nKey) => en[key],
  formatWhen: () => '03:12',
  formatDate: () => 'Jul 30 01:05',
  formatTimeShort: () => '08:10',
  formatMonthYear: () => 'Apr 2029',
};
const item = { id: 'demo-web-02', name: 'web-02', hostname: 'web-02', tags: ['prod'], status: 'up' as const, lastSeenAt: null, role: 'owner' as const, supportUntil: '2029-04-30', eol: false };

describe('headerView', () => {
  it('oppe: live, infolinje, oppetid og support-badge som skjerm 5', () => {
    const h = headerView(demoServer(), item, texts);
    expect(h.dot).toBe('up');
    expect(h.statusText).toBe('live');
    expect(h.info).toBe('Ubuntu 24.04 · 6.8.0-45-generic · 4 cores · 8 GB');
    expect(h.uptime).toBe('up 41d 2h · last boot Jul 30 01:05');
    expect(h.support).toBe('Supported until Apr 2029');
    expect(h.eol).toBe(false);
    expect(h.down).toBe(false);
  });

  it('nede: «last seen», rød prikk, ingen oppetid; EOL fra listen', () => {
    const h = headerView(demoDownServer(), { ...item, eol: true, supportUntil: '2025-05-31' }, texts);
    expect(h.dot).toBe('down');
    expect(h.down).toBe(true);
    expect(h.statusText).toBe('last seen 03:12');
    expect(h.uptime).toBe('last boot Jul 30 01:05');
    expect(h.eol).toBe(true);
  });
});

describe('cpuView', () => {
  it('hode, kjernestolper og seks chips; load over kjerner og iowait over 5 % er oransje', () => {
    const v = cpuView(demoServer(), texts);
    expect(v.head).toBe('48% · 1.9 of 4 cores');
    expect(v.cores.map((c) => c.label)).toEqual(['C1', 'C2', 'C3', 'C4']);
    expect(v.cores[2].pct).toBe(61);
    expect(v.chips.map((c) => c.value)).toEqual(['1.9', '1.4', '1.1', '34%', '11%', '3.8%']);
    expect(v.chips[0].sub).toBe('/ 4');
    expect(v.chips.map((c) => c.tone)).toEqual(['default', 'default', 'default', 'default', 'default', 'default']);
    const hot = cpuView(demoServer({ host: { ...demoServer().host!, load: [5.2, 1, 1], cpu: { ...demoServer().host!.cpu, iowait: 7 } } }), texts);
    expect(hot.chips[0].tone).toBe('warn');
    expect(hot.chips[5].tone).toBe('warn');
  });

  it('nede: 0 % og stolper på 0', () => {
    const v = cpuView(demoDownServer(), texts);
    expect(v.pct).toBe(0);
    expect(v.cores.every((c) => c.pct === 0)).toBe(true);
    expect(v.chips[0].value).toBe('—');
  });
});

describe('memView', () => {
  it('brukt = total − free − buffers − cached, legende med GB og swap', () => {
    const v = memView(demoServer(), texts);
    expect(Math.round(v.pct)).toBe(61);
    expect(v.head).toBe('61% · 4.9 of 8 GB · Swap 0.4 GB');
    expect(Math.round(v.usedPct)).toBe(61);
    expect(Math.round(v.bufPct)).toBe(5);
    expect(v.legend.map((l) => l.value)).toEqual(['4.9 GB', '0.4 GB', '2.7 GB', '0.4 GB']);
  });
});

describe('diskView', () => {
  it('fulleste først, GB/TB, fot, inoder og I/O', () => {
    const v = diskView(demoServer(), texts);
    expect(v.head).toBe('2 mounted');
    expect(v.mounts.map((m) => m.path)).toEqual(['/', '/data']);
    const root = v.mounts[0];
    expect(root.pct).toBe(92);
    expect(root.color).toBe('var(--color-crit)');
    expect(root.free).toBe('6 GB');
    expect(root.foot).toBe('74 GB used of 80 GB');
    expect(root.inodePct).toBe(12);
    expect(root.io).toBe('read 3.2 · write 11.0 MB/s');
    expect(v.mounts[1].foot).toBe('520 GB used of 1.0 TB');
    expect(diskSize(1500 * GB)).toBe('1.5 TB');
    expect(memSize(812 * MB)).toBe('812 MB');
    expect(memSize(1.5 * 1024 * MB)).toBe('1.5 GB');
  });
});

describe('netView', () => {
  it('summerer hodet og viser første IPv4 per grensesnitt', () => {
    const v = netView(demoServer());
    expect(v.head).toBe('↓15.3 ↑1.4 MB/s');
    expect(v.ifaces[0]).toMatchObject({ name: 'eth0', ip: '10.0.1.12', ips: '10.0.1.12, fe80::1', rx: '↓14.8', tx: '↑1.2' });
    expect(netView(demoDownServer()).head).toBe('—');
  });
});

describe('procView', () => {
  it('hode fra totalene og rader med kjøretid fra startedAt', () => {
    const v = procView(demoServer(), texts, NOW);
    expect(v.head).toBe('182 total · 0 waiting');
    expect(v.rows[0]).toMatchObject({ pid: 4410, name: 'python3', user: 'ole', cpu: 61.9, time: 12 * 60 + 33, cmd: 'python3 -m http.server 8000' });
    expect(v.rows[1].time).toBe(41 * 86_400 + 2 * 3600);
  });
});

describe('containersView', () => {
  it('restarting og stopped først, så etter CPU; minne mot grense; fot', () => {
    const v = containersView(demoServer(), texts, NOW);
    expect(v.available).toBe(true);
    expect(v.head).toBe('2 running · 2 stopped/restarting');
    expect(v.rows.map((r) => r.name)).toEqual(['web-worker', 'web-cron', 'web-api', 'web-web']);
    const web = v.rows[3];
    expect(web.status).toBe('running · 3d 4h');
    expect(web.cpu).toBe('2.1%');
    expect(web.mem).toBe('412 MB');
    expect(web.limit).toBe('/ 1024 MB');
    expect(web.memPct).toBe(40);
    expect(web.age).toBe('12 d');
    expect(web.health).toBe('healthy');
    const api = v.rows[2];
    expect(api.ageTone).toBe('warn');
    expect(api.health).toBe('—');
    const worker = v.rows[0];
    expect(worker.state).toBe('restarting');
    expect(worker.restartsTone).toBe('warn');
    expect(worker.limit).toBe('no limit');
    expect(worker.memColor).toBe('var(--w-35)');
    const cron = v.rows[1];
    expect(cron.cpu).toBe('—');
    expect(cron.status).toBe('stopped');
  });

  it('uten Docker: available = false', () => {
    const v = containersView(demoServer({ dockerMode: 'none', containers: null }), texts, NOW);
    expect(v.available).toBe(false);
    expect(v.rows).toEqual([]);
  });
});

describe('servicesView', () => {
  it('feilede først, så running, så stoppede; kun .service; needs restart', () => {
    const v = servicesView(demoServer(), texts);
    expect(v.head).toBe('1 failed · 3 running');
    expect(v.rows.map((r) => r.name)).toEqual(['cron-sync.service', 'docker.service', 'nginx.service', 'ssh.service', 'postgresql.service']);
    expect(v.rows[0].state).toBe('failed');
    expect(v.rows[3].needsRestart).toBe(true);
    expect(v.rows[4].state).toBe('stopped');
    expect(v.hidden).toBe(0);
  });

  it('skjuler alt over 200 til «Show all»', () => {
    const units = Array.from({ length: 250 }, (_, i) => ({ name: `u${String(i).padStart(3, '0')}.service`, state: 'running' }));
    const v = servicesView(demoServer({ services: { units, failed: [], needsRestart: [] } }), texts);
    expect(v.rows.length).toBe(200);
    expect(v.hidden).toBe(50);
    expect(servicesView(demoServer({ services: { units, failed: [], needsRestart: [] } }), texts, true).rows.length).toBe(250);
  });
});

describe('maintView', () => {
  it('chips, «Triggered by», needs restart og support-badge', () => {
    const v = maintView(demoServer(), item, texts);
    expect(v.chips.map((c) => c.value)).toEqual(['Yes', '7', '2']);
    expect(v.chips.map((c) => c.tone)).toEqual(['warn', 'default', 'warn']);
    expect(v.triggeredBy).toBe('Triggered by: linux-image-6.8.0-45-generic, libssl3');
    expect(v.needsRestart).toBe('ssh.service');
    expect(v.checked).toBe('checked 08:10');
    expect(v.support).toBe('Supported until Apr 2029');
    expect(maintView(demoServer(), { ...item, eol: true }, texts)).toMatchObject({ eol: true, supportTone: 'crit', support: 'No longer receives security updates' });
  });
});

describe('securityView', () => {
  it('porter sortert, innloggede, SSH-chips og brannmur', () => {
    const v = securityView(demoServer(), {}, NOW, texts);
    expect(v.ports.map((p) => p.port)).toEqual([22, 80, 443]);
    expect(v.ports.every((p) => !p.isNew)).toBe(true);
    expect(v.users).toEqual(['ole · 10.0.0.12 · pts/0 · 08:10']);
    expect(v.sshChips.map((c) => c.value)).toEqual(['12', '84']);
    expect(v.sshChips[0].tone).toBe('warn');
    expect(v.sshLast[0]).toBe('08:10 · root @ 45.33.12.9');
    expect(v.fwChips.map((c) => c.value)).toEqual(['active', '42 blocked']);
  });

  it('«new»: ikke første gang, bare porter sett i løpet av siste 24 t', () => {
    const server = demoServer();
    const first = rememberPorts({}, server, NOW);
    expect(first).toEqual({ '22/tcp': 0, '80/tcp': 0, '443/tcp': 0 });
    expect(rememberPorts(first, server, NOW + 1000)).toBe(first);
    const later = demoServer({ security: { ...server.security, listeningPorts: [...(server.security?.listeningPorts ?? []), { port: 8000, proto: 'tcp', process: 'python3' }] } });
    const known = rememberPorts(first, later, NOW + 60_000);
    expect(known['8000/tcp']).toBe(NOW + 60_000);
    expect(securityView(later, known, NOW + 120_000, texts).ports.find((p) => p.port === 8000)?.isNew).toBe(true);
    expect(securityView(later, known, NOW + 60_000 + 25 * 3600_000, texts).ports.find((p) => p.port === 8000)?.isNew).toBe(false);
    expect(securityView(later, {}, NOW, texts).ports.every((p) => !p.isNew)).toBe(true);
  });

  it('ufw/fail2ban ikke funnet', () => {
    const v = securityView(demoServer({ security: { firewall: { ufw: 'notfound', fail2ban: 'notfound' } } }), {}, NOW, texts);
    expect(v.fwChips.map((c) => c.value)).toEqual(['not found', 'not found']);
    expect(v.fwChips.map((c) => c.tone)).toEqual(['muted', 'muted']);
    expect(v.ports).toEqual([]);
    expect(v.users).toEqual([]);
  });
});

describe('snapshotText', () => {
  it('samler hodene i ren tekst (Copy snapshot, bak flagg)', () => {
    const lines = snapshotText(demoServer(), item, texts, NOW).split('\n');
    expect(lines[0]).toBe('web-02 · Ubuntu 24.04 · 6.8.0-45-generic · 4 cores · 8 GB · up 41d 2h · last boot Jul 30 01:05 · 08:10');
    expect(lines[1]).toBe('CPU 48% · 1.9 of 4 cores');
    expect(lines).toContain('Disk / 92% (74 GB used of 80 GB)');
  });
});
