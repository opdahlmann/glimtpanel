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

  /** Fyller ringen fra 30 s-punktene (nyeste sist, dekker den siste timen fram til `nowS`). */
  seed(cpu: (number | null)[], mem: (number | null)[], nowS: number): void {
    this.cpu.fill(NaN);
    this.mem.fill(NaN);
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
        this.cpu[slot] = c === null || c === undefined ? NaN : c;
        this.mem[slot] = m === null || m === undefined ? NaN : m;
      }
    }
    this.lastT = nowS;
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
}

function num(v: number | null | undefined): number {
  return v === null || v === undefined || !Number.isFinite(v) ? NaN : v;
}

function mod(t: number, n: number): number {
  return ((t % n) + n) % n;
}

function downsample(ring: Float32Array, nowS: number, points: number): number[] {
  const out = new Array<number>(points);
  const step = RING_SLOTS / points;
  for (let i = 0; i < points; i++) {
    const from = nowS - RING_SLOTS + 1 + i * step;
    let max = NaN;
    for (let t = from; t < from + step; t++) {
      const v = ring[mod(t, RING_SLOTS)];
      if (Number.isNaN(v)) continue;
      if (Number.isNaN(max) || v > max) max = v;
    }
    out[i] = Number.isNaN(max) ? 0 : Math.round(max * 10) / 10;
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

  applyCard(card: CardDto): void {
    if (!card || typeof card.id !== 'string' || !card.id) return;
    this.card(card.id).set(card);
    this.track(card.id);
    this.feedRing(card);
  }

  applyServer(server: ServerDto): void {
    if (!server || typeof server.id !== 'string' || !server.id) return;
    this.server(server.id).set(server);
    this.track(server.id);
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

  private feedRing(card: CardDto): void {
    const nowS = this.now();
    let ring = this.rings.get(card.id);
    const hasSeries = Array.isArray(card.cpuLastHour) && card.cpuLastHour.length > 0;
    if (!ring) {
      ring = new HourRing();
      this.rings.set(card.id, ring);
      if (hasSeries) ring.seed(card.cpuLastHour, card.memLastHour ?? [], nowS);
    } else if (hasSeries && ring.lastT >= 0 && nowS - ring.lastT > RESEED_AFTER_S) {
      ring.seed(card.cpuLastHour, card.memLastHour ?? [], nowS);
    }
    const up = card.status === 'up' && card.connected;
    ring.append(up ? card.cpu : null, up ? card.mem : null, nowS);
    this.hour(card.id).set(ring.sample(nowS));
  }
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
