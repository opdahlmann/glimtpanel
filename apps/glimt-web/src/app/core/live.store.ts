import { computed, Injectable, signal, Signal, WritableSignal } from '@angular/core';
import { CardDto, ServerDto, ServerStatusDto } from './live.types';

/** Siste time som ring på 3 600 slots à 1 s (IMPLEMENTERINGSPLAN 3.4). */
export const RING_SLOTS = 3600;
/** Kortets cpuLastHour/memLastHour: 120 punkter à 30 s. */
export const HOUR_POINTS = 120;
export const HOUR_STEP_S = RING_SLOTS / HOUR_POINTS;
/** Hull kortere enn dette fylles med forrige verdi (5 s-intervall i idle), lengre blir NaN. */
const FILL_GAP_S = 10;
/** Etter så lang stillhet (skjult fane) seedes ringen på nytt fra kortets siste-time-serie. */
const RESEED_AFTER_S = 60;

export interface LastHour {
  cpu: number[];
  mem: number[];
}

/** Siste time i kurveoppløsning (steg 5.3): 600 punkter à 6 s, maks per bøtte, `null` der ringen er tom. */
export const CHART_POINTS = 600;
export const CHART_STEP_MS = (RING_SLOTS / CHART_POINTS) * 1000;

export interface HourChart {
  cpu: (number | null)[];
  mem: (number | null)[];
  /** Unix-ms for første punkt. */
  from: number;
  stepMs: number;
}

/** Det ringen trenger fra en `Server`-melding (steg 5.1): prosent brukt, som kortet regner det. */
export function serverPercent(server: Pick<ServerDto, 'host' | 'status' | 'connected'>): { cpu: number | null; mem: number | null } {
  const host = server.host;
  if (!host || server.status !== 'up' || !server.connected) return { cpu: null, mem: null };
  const mem = host.mem.total > 0 ? (host.mem.used / host.mem.total) * 100 : null;
  return { cpu: host.cpu.total, mem };
}

/** Sortert liste: navn (uavhengig av store/små bokstaver), deretter id som stabil tiebreaker. */
export function compareCards(a: { name: string; id: string }, b: { name: string; id: string }): number {
  const byName = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  return byName !== 0 ? byName : a.id.localeCompare(b.id);
}

/** Ringen for én server. Tid i hele sekunder; slot = t mod 3 600. */
export class HourRing {
  readonly cpu = new Float32Array(RING_SLOTS).fill(NaN);
  readonly mem = new Float32Array(RING_SLOTS).fill(NaN);
  /** Siste sekund det ble skrevet i, eller -1. */
  lastT = -1;
  /** Ringen har fått en hel time fra kortet eller fra historikken. */
  seeded = false;

  /**
   * Fyller ringen fra 30 s-punktene (nyeste sist, dekker den siste timen fram til `nowS`).
   * Med `merge` beholdes sekunder som allerede har en verdi (levende punkter fra strømmen) og `lastT` rykker ikke tilbake.
   */
  seed(cpu: (number | null)[], mem: (number | null)[], nowS: number, merge = false): void {
    if (!merge) {
      this.cpu.fill(NaN);
      this.mem.fill(NaN);
    }
    const n = Math.max(cpu.length, mem.length);
    if (n === 0) return;
    const step = Math.round(RING_SLOTS / n);
    for (let i = 0; i < n; i++) {
      const c = cpu[i];
      const m = mem[i];
      const from = nowS - (n - i) * step + 1;
      for (let t = from; t <= from + step - 1; t++) {
        if (t < nowS - RING_SLOTS + 1 || t > nowS) continue;
        const slot = mod(t, RING_SLOTS);
        if (merge && this.lastT >= 0 && t > this.lastT - FILL_GAP_S && t <= this.lastT && !Number.isNaN(this.cpu[slot])) continue;
        this.cpu[slot] = c === null || c === undefined ? NaN : c;
        this.mem[slot] = m === null || m === undefined ? NaN : m;
      }
    }
    this.lastT = merge ? Math.max(this.lastT, nowS) : nowS;
    this.seeded = true;
  }

  /** Skriver ett punkt ved `nowS`; fyller små hull siden forrige skriving med forrige verdi, større med NaN. */
  append(cpu: number | null, mem: number | null, nowS: number): void {
    if (nowS <= this.lastT) {
      const slot = mod(nowS, RING_SLOTS);
      if (nowS === this.lastT) {
        this.cpu[slot] = num(cpu);
        this.mem[slot] = num(mem);
      }
      return;
    }
    if (this.lastT >= 0) {
      const gap = nowS - this.lastT;
      const prevSlot = mod(this.lastT, RING_SLOTS);
      const fillCpu = gap <= FILL_GAP_S ? this.cpu[prevSlot] : NaN;
      const fillMem = gap <= FILL_GAP_S ? this.mem[prevSlot] : NaN;
      for (let t = this.lastT + 1; t < nowS && t > nowS - RING_SLOTS; t++) {
        const slot = mod(t, RING_SLOTS);
        this.cpu[slot] = fillCpu;
        this.mem[slot] = fillMem;
      }
      if (gap >= RING_SLOTS) {
        this.cpu.fill(NaN);
        this.mem.fill(NaN);
      }
    }
    const slot = mod(nowS, RING_SLOTS);
    this.cpu[slot] = num(cpu);
    this.mem[slot] = num(mem);
    this.lastT = nowS;
  }

  /** Nedsampler til `points` bøtter (maks per bøtte, 0 for tomme), eldste først, fram til `nowS`. */
  sample(nowS: number, points = HOUR_POINTS): LastHour {
    return { cpu: downsample(this.cpu, nowS, points), mem: downsample(this.mem, nowS, points) };
  }

  /** Som `sample`, men for kurven: `null` for tomme bøtter (hull i kurven) og tidspunkt for første punkt. */
  sampleChart(nowS: number, points = CHART_POINTS): HourChart {
    const step = RING_SLOTS / points;
    return {
      cpu: downsample(this.cpu, nowS, points, true),
      mem: downsample(this.mem, nowS, points, true),
      from: (nowS - RING_SLOTS + 1) * 1000,
      stepMs: step * 1000,
    };
  }
}

function num(v: number | null | undefined): number {
  return v === null || v === undefined || !Number.isFinite(v) ? NaN : v;
}

function mod(t: number, n: number): number {
  return ((t % n) + n) % n;
}

function downsample(ring: Float32Array, nowS: number, points: number): number[];
function downsample(ring: Float32Array, nowS: number, points: number, nullable: true): (number | null)[];
function downsample(ring: Float32Array, nowS: number, points: number, nullable = false): (number | null)[] {
  const out = new Array<number | null>(points);
  const step = RING_SLOTS / points;
  for (let i = 0; i < points; i++) {
    const from = nowS - RING_SLOTS + 1 + i * step;
    let max = NaN;
    for (let t = from; t < from + step; t++) {
      const v = ring[mod(t, RING_SLOTS)];
      if (Number.isNaN(v)) continue;
      if (Number.isNaN(max) || v > max) max = v;
    }
    out[i] = Number.isNaN(max) ? (nullable ? null : 0) : Math.round(max * 10) / 10;
  }
  return out;
}

/**
 * Ett signal per server for kortet og for serversiden (steg 3.4), slik at en `Card`-melding bare oppdaterer den
 * ene signalen. `cards` er den sorterte listen for oversikten. Ringen for siste time seedes fra kortets
 * 30 s-punkter og får ett punkt per `Card` (1 s aktiv, 5 s idle).
 */
@Injectable({ providedIn: 'root' })
export class LiveStore {
  private readonly cardSignals = new Map<string, WritableSignal<CardDto | null>>();
  private readonly serverSignals = new Map<string, WritableSignal<ServerDto | null>>();
  private readonly hourSignals = new Map<string, WritableSignal<LastHour>>();
  private readonly chartSignals = new Map<string, WritableSignal<HourChart>>();
  private readonly rings = new Map<string, HourRing>();
  private readonly ids = signal<ReadonlySet<string>>(new Set());

  /** Klokke i hele sekunder; byttes ut i tester. */
  now: () => number = () => Math.floor(Date.now() / 1000);

  /** Kortene sortert på navn. Servere vi bare har id for (uten kort) er ikke med. */
  readonly cards: Signal<CardDto[]> = computed(() => {
    const out: CardDto[] = [];
    for (const id of this.ids()) {
      const c = this.cardSignals.get(id)?.();
      if (c) out.push(c);
    }
    return out.sort(compareCards);
  });

  readonly count = computed(() => this.cards().length);

  card(id: string): WritableSignal<CardDto | null> {
    let s = this.cardSignals.get(id);
    if (!s) {
      s = signal<CardDto | null>(null);
      this.cardSignals.set(id, s);
    }
    return s;
  }

  server(id: string): WritableSignal<ServerDto | null> {
    let s = this.serverSignals.get(id);
    if (!s) {
      s = signal<ServerDto | null>(null);
      this.serverSignals.set(id, s);
    }
    return s;
  }

  /** Siste time (120 punkter, eldste først) for sparklines. */
  lastHour(id: string): Signal<LastHour> {
    return this.hour(id).asReadonly();
  }

  /** Siste time i kurveoppløsning (600 punkter à 6 s) for serversiden. Beregnes bare for servere noen ser på. */
  hourChart(id: string): Signal<HourChart> {
    return this.chart(id).asReadonly();
  }

  /**
   * Seeder ringen fra `history?metric=cpu|mem&range=1h` (120 punkter à 30 s) når serversiden åpnes uten at kortet
   * har fylt den (dyplenke). Levende punkter som allerede står i ringen beholdes.
   */
  seedHour(id: string, cpu: (number | null)[], mem: (number | null)[]): void {
    const nowS = this.now();
    let ring = this.rings.get(id);
    if (!ring) {
      ring = new HourRing();
      this.rings.set(id, ring);
    }
    if (ring.seeded && ring.lastT >= 0 && nowS - ring.lastT <= RESEED_AFTER_S) return;
    ring.seed(cpu, mem, nowS, true);
    this.publishRing(id, ring, nowS);
  }

  applyCard(card: CardDto): void {
    if (!card || typeof card.id !== 'string' || !card.id) return;
    this.card(card.id).set(card);
    this.track(card.id);
    this.feedRing(card);
  }

  /** `Server`: serversidens signal, og ett punkt i ringen (serversiden abonnerer ikke på kortene). */
  applyServer(server: ServerDto): void {
    if (!server || typeof server.id !== 'string' || !server.id) return;
    this.server(server.id).set(server);
    this.track(server.id);
    const { cpu, mem } = serverPercent(server);
    this.appendRing(server.id, cpu, mem);
  }

  /** `ServerStatus`: fletter status/connected/lastSeen inn i kortet (og serversiden) uten å røre tallene. */
  applyStatus(status: ServerStatusDto): void {
    if (!status || typeof status.id !== 'string' || !status.id) return;
    const cardSignal = this.card(status.id);
    const existing = cardSignal();
    if (existing) {
      cardSignal.set({ ...existing, name: status.name, hostname: status.hostname, status: status.status, connected: status.connected, lastSeenAt: status.lastSeenAt });
    } else {
      cardSignal.set(cardFromStatus(status));
    }
    const serverSignal = this.serverSignals.get(status.id);
    const server = serverSignal?.();
    if (serverSignal && server) {
      serverSignal.set({ ...server, name: status.name, status: status.status, connected: status.connected, lastSeenAt: status.lastSeenAt });
    }
    this.track(status.id);
  }

  remove(id: string): void {
    this.cardSignals.get(id)?.set(null);
    this.serverSignals.get(id)?.set(null);
    this.rings.delete(id);
    this.hourSignals.get(id)?.set({ cpu: [], mem: [] });
    this.chartSignals.get(id)?.set(emptyChart());
    if (this.ids().has(id)) {
      this.ids.update((set) => {
        const next = new Set(set);
        next.delete(id);
        return next;
      });
    }
  }

  clear(): void {
    for (const s of this.cardSignals.values()) s.set(null);
    for (const s of this.serverSignals.values()) s.set(null);
    for (const s of this.hourSignals.values()) s.set({ cpu: [], mem: [] });
    for (const s of this.chartSignals.values()) s.set(emptyChart());
    this.rings.clear();
    this.ids.set(new Set());
  }

  private track(id: string): void {
    if (!this.ids().has(id)) {
      this.ids.update((set) => new Set(set).add(id));
    }
  }

  private hour(id: string): WritableSignal<LastHour> {
    let s = this.hourSignals.get(id);
    if (!s) {
      s = signal<LastHour>({ cpu: [], mem: [] });
      this.hourSignals.set(id, s);
    }
    return s;
  }

  private chart(id: string): WritableSignal<HourChart> {
    let s = this.chartSignals.get(id);
    if (!s) {
      const ring = this.rings.get(id);
      s = signal<HourChart>(ring ? ring.sampleChart(this.now()) : emptyChart());
      this.chartSignals.set(id, s);
    }
    return s;
  }

  private feedRing(card: CardDto): void {
    const nowS = this.now();
    let ring = this.rings.get(card.id);
    const hasSeries = Array.isArray(card.cpuLastHour) && card.cpuLastHour.length > 0;
    if (!ring) {
      ring = new HourRing();
      this.rings.set(card.id, ring);
      if (hasSeries) ring.seed(card.cpuLastHour, card.memLastHour ?? [], nowS);
    } else if (hasSeries && (!ring.seeded || (ring.lastT >= 0 && nowS - ring.lastT > RESEED_AFTER_S))) {
      ring.seed(card.cpuLastHour, card.memLastHour ?? [], nowS, !ring.seeded);
    }
    const up = card.status === 'up' && card.connected;
    ring.append(up ? card.cpu : null, up ? card.mem : null, nowS);
    this.publishRing(card.id, ring, nowS);
  }

  private appendRing(id: string, cpu: number | null, mem: number | null): void {
    const nowS = this.now();
    let ring = this.rings.get(id);
    if (!ring) {
      ring = new HourRing();
      this.rings.set(id, ring);
    }
    ring.append(cpu, mem, nowS);
    this.publishRing(id, ring, nowS);
  }

  private publishRing(id: string, ring: HourRing, nowS: number): void {
    this.hour(id).set(ring.sample(nowS));
    this.chartSignals.get(id)?.set(ring.sampleChart(nowS));
  }
}

function emptyChart(): HourChart {
  return { cpu: [], mem: [], from: 0, stepMs: CHART_STEP_MS };
}

/** Et kort uten tall, slik at oversikten kan vise serveren før første `Card`. */
export function cardFromStatus(s: ServerStatusDto): CardDto {
  return {
    id: s.id,
    name: s.name,
    hostname: s.hostname,
    tags: [],
    status: s.status,
    connected: s.connected,
    lastSeenAt: s.lastSeenAt,
    os: s.os ?? null,
    versionId: null,
    arch: s.arch ?? null,
    cores: s.cores ?? null,
    ramBytes: s.ramBytes ?? null,
    uptimeSec: null,
    cpu: null,
    mem: null,
    diskWorst: null,
    netRx: null,
    netTx: null,
    containersRunning: 0,
    containersTotal: 0,
    containersBad: 0,
    updates: null,
    securityUpdates: null,
    rebootRequired: null,
    failedServices: 0,
    activeAlerts: 0,
    cpuLastHour: [],
    memLastHour: [],
  };
}
