import { CardDto, ServerDto, ServerStatusDto } from './live.types';
import { cardFromStatus, CHART_POINTS, CHART_STEP_MS, HourRing, HOUR_POINTS, LiveStore, RING_SLOTS, serverPercent } from './live.store';

function card(overrides: Partial<CardDto> & Pick<CardDto, 'id' | 'name'>): CardDto {
  return {
    ...cardFromStatus({ id: overrides.id, name: overrides.name, hostname: `${overrides.name}.local`, status: 'up', lastSeenAt: null, connected: true }),
    cpu: 40,
    mem: 60,
    ...overrides,
  };
}

function status(overrides: Partial<ServerStatusDto> & Pick<ServerStatusDto, 'id'>): ServerStatusDto {
  return { name: overrides.id, hostname: `${overrides.id}.local`, status: 'up', lastSeenAt: null, connected: true, ...overrides };
}

describe('LiveStore', () => {
  let store: LiveStore;
  let nowS: number;

  beforeEach(() => {
    store = new LiveStore();
    nowS = 1_800_000_000;
    store.now = () => nowS;
  });

  it('applyCard oppdaterer kun den ene signalen og sorterer listen på navn', () => {
    const a = store.card('a');
    store.applyCard(card({ id: 'b', name: 'web-02' }));
    store.applyCard(card({ id: 'a', name: 'Alpha' }));
    expect(a()?.name).toBe('Alpha');
    expect(store.cards().map((c) => c.id)).toEqual(['a', 'b']);
    expect(store.count()).toBe(2);
  });

  it('applyStatus fletter status/connected/lastSeen inn i kortet uten å røre tallene', () => {
    store.applyCard(card({ id: 'a', name: 'a', cpu: 42, mem: 61 }));
    store.applyStatus(status({ id: 'a', status: 'down', connected: false, lastSeenAt: '2026-09-09T03:12:00Z' }));
    const c = store.card('a')();
    expect(c?.status).toBe('down');
    expect(c?.connected).toBe(false);
    expect(c?.lastSeenAt).toBe('2026-09-09T03:12:00Z');
    expect(c?.cpu).toBe(42);
    expect(c?.mem).toBe(61);
  });

  it('applyStatus før første Card lager et kort uten tall', () => {
    store.applyStatus(status({ id: 'n', name: 'nordic-db', status: 'down', connected: false }));
    expect(store.cards().length).toBe(1);
    expect(store.card('n')()?.cpu).toBeNull();
    expect(store.card('n')()?.name).toBe('nordic-db');
  });

  it('applyServer og applyStatus holder serversiden i takt', () => {
    store.applyServer({ ...card({ id: 'a', name: 'a' }), os: null, kernel: null, dockerMode: null, bootTime: null, uptimeSec: null, host: null, processes: null, processTotals: null, containers: null, services: null, maintenance: null, security: null, snapshotAt: null, streamAt: null, agentVersion: '0.1', kind: 'server', health: null });
    store.applyStatus(status({ id: 'a', status: 'down', connected: false }));
    expect(store.server('a')()?.status).toBe('down');
  });

  it('remove tømmer kortet og listen', () => {
    store.applyCard(card({ id: 'a', name: 'a' }));
    store.remove('a');
    expect(store.cards()).toEqual([]);
    expect(store.card('a')()).toBeNull();
    expect(store.lastHour('a')()).toEqual({ cpu: [], mem: [] });
  });

  it('ignorerer meldinger uten id', () => {
    store.applyCard({ id: '' } as CardDto);
    store.applyStatus(null as unknown as ServerStatusDto);
    expect(store.cards()).toEqual([]);
  });

  describe('siste time', () => {
    it('seedes fra kortets 120 punkter à 30 s og gir 120 punkter tilbake', () => {
      const cpuLastHour = Array.from({ length: HOUR_POINTS }, (_, i) => i);
      const memLastHour = Array.from({ length: HOUR_POINTS }, (_, i) => 100 - i);
      store.applyCard(card({ id: 'a', name: 'a', cpu: 99, mem: 1, cpuLastHour, memLastHour }));
      const h = store.lastHour('a')();
      expect(h.cpu.length).toBe(HOUR_POINTS);
      expect(h.mem.length).toBe(HOUR_POINTS);
      expect(h.cpu[0]).toBe(0);
      expect(h.cpu[50]).toBe(50);
      // nyeste bøtte inneholder både seed-punktet (119) og live-punktet (99): maks per bøtte
      expect(h.cpu[HOUR_POINTS - 1]).toBe(119);
      // seed-punktet er -19 (100 - 119), live-punktet 1: maks per bøtte
      expect(h.mem[HOUR_POINTS - 1]).toBe(1);
    });

    it('legger til ett punkt per Card og nedsampler med maks per 30 s', () => {
      store.applyCard(card({ id: 'a', name: 'a', cpu: 10, mem: 10, cpuLastHour: [], memLastHour: [] }));
      for (let i = 1; i <= 60; i++) {
        nowS += 1;
        store.applyCard(card({ id: 'a', name: 'a', cpu: i === 45 ? 90 : 10, mem: 20, cpuLastHour: [], memLastHour: [] }));
      }
      const h = store.lastHour('a')();
      expect(h.cpu.length).toBe(HOUR_POINTS);
      // de to siste bøttene dekker de siste 60 sekundene; toppen 90 ligger i nest siste eller siste
      expect(Math.max(h.cpu[HOUR_POINTS - 1], h.cpu[HOUR_POINTS - 2])).toBe(90);
      expect(h.mem[HOUR_POINTS - 1]).toBe(20);
      // eldre bøtter er tomme → 0
      expect(h.cpu[0]).toBe(0);
    });

    it('nede server gir hull (0 i nedsamplingen), og hull > 10 s fylles ikke', () => {
      const ring = new HourRing();
      ring.append(50, 50, 1000);
      ring.append(50, 50, 1005); // 5 s: fylles med 50
      expect(ring.cpu[1003 % RING_SLOTS]).toBe(50);
      ring.append(70, 70, 1030); // 25 s: NaN i hullet
      expect(Number.isNaN(ring.cpu[1020 % RING_SLOTS])).toBe(true);
      expect(ring.cpu[1030 % RING_SLOTS]).toBe(70);
      ring.append(null, null, 1031);
      expect(Number.isNaN(ring.cpu[1031 % RING_SLOTS])).toBe(true);
    });

    it('seeder på nytt etter lang stillhet (skjult fane)', () => {
      store.applyCard(card({ id: 'a', name: 'a', cpu: 10, mem: 10, cpuLastHour: new Array(HOUR_POINTS).fill(5), memLastHour: new Array(HOUR_POINTS).fill(5) }));
      nowS += 600;
      store.applyCard(card({ id: 'a', name: 'a', cpu: 10, mem: 10, cpuLastHour: new Array(HOUR_POINTS).fill(77), memLastHour: new Array(HOUR_POINTS).fill(77) }));
      const h = store.lastHour('a')();
      expect(h.cpu[0]).toBe(77);
      expect(h.cpu[HOUR_POINTS - 1]).toBe(77);
    });

    it('ringen bruker 3 600 slots og ruller rundt', () => {
      const ring = new HourRing();
      for (let t = 0; t < RING_SLOTS + 100; t++) ring.append(t % 100, 1, t);
      const h = ring.sample(RING_SLOTS + 99);
      expect(h.cpu.length).toBe(HOUR_POINTS);
      expect(h.cpu[HOUR_POINTS - 1]).toBe(99);
    });
  });
});

describe('LiveStore: serversiden (fase 5)', () => {
  let store: LiveStore;
  let nowS: number;

  beforeEach(() => {
    store = new LiveStore();
    nowS = 1_800_000_000;
    store.now = () => nowS;
  });

  const server = (over: Partial<ServerDto> = {}): ServerDto => ({
    ...card({ id: 's', name: 's' }),
    os: null, kernel: null, dockerMode: null, bootTime: null, uptimeSec: null, processes: null, processTotals: null, containers: null,
    services: null, maintenance: null, security: null, snapshotAt: null, streamAt: null, agentVersion: '0.1', kind: 'server', health: null,
    host: { cpu: { total: 30 }, mem: { total: 1000, used: 400, free: 600 } },
    ...over,
  });

  it('applyServer legger ett punkt i ringen (cpu total, mem brukt/total) og oppdaterer kurven', () => {
    const chart = store.hourChart('s');
    expect(chart().cpu).toEqual([]);
    store.applyServer(server());
    expect(store.lastHour('s')().cpu[HOUR_POINTS - 1]).toBe(30);
    expect(store.lastHour('s')().mem[HOUR_POINTS - 1]).toBe(40);
    const c = chart();
    expect(c.cpu.length).toBe(CHART_POINTS);
    expect(c.stepMs).toBe(CHART_STEP_MS);
    expect(c.cpu[CHART_POINTS - 1]).toBe(30);
    expect(c.cpu[0]).toBeNull();
    expect(c.from).toBe((nowS - RING_SLOTS + 1) * 1000);
  });

  it('applyServer for en server som er nede gir hull (null) i kurven', () => {
    store.applyServer(server({ status: 'down', connected: false }));
    expect(store.hourChart('s')().cpu[CHART_POINTS - 1]).toBeNull();
    expect(store.lastHour('s')().cpu[HOUR_POINTS - 1]).toBe(0);
  });

  it('seedHour fyller ringen fra historikken uten å røre levende punkter, og hopper over en fersk seeding', () => {
    store.applyServer(server({ host: { cpu: { total: 77 }, mem: { total: 100, used: 50, free: 50 } } }));
    const cpu = Array.from({ length: HOUR_POINTS }, (_, i) => (i === 3 ? null : 10));
    store.seedHour('s', cpu, cpu.map((v) => (v === null ? null : 20)));
    const hour = store.lastHour('s')();
    expect(hour.cpu[HOUR_POINTS - 1]).toBe(77);
    expect(hour.cpu[0]).toBe(10);
    expect(hour.cpu[3]).toBe(0);
    expect(hour.mem[10]).toBe(20);
    expect(store.hourChart('s')().cpu[15]).toBeNull();
    // Allerede seedet og fersk: en ny seeding (f.eks. et annet svar) endrer ikke ringen.
    store.seedHour('s', cpu.map(() => 99), cpu.map(() => 99));
    expect(store.lastHour('s')().cpu[0]).toBe(10);
  });

  it('seedHour uten ring lager en (dyplenke før første Server)', () => {
    store.seedHour('n', [50, 60], [1, 2]);
    expect(store.lastHour('n')().cpu[HOUR_POINTS - 1]).toBe(60);
    expect(store.hourChart('n')().cpu[CHART_POINTS - 1]).toBe(60);
  });

  it('serverPercent: null når nede eller uten host', () => {
    expect(serverPercent(server())).toEqual({ cpu: 30, mem: 40 });
    expect(serverPercent(server({ status: 'down', connected: false }))).toEqual({ cpu: null, mem: null });
    expect(serverPercent(server({ host: null }))).toEqual({ cpu: null, mem: null });
  });
});
