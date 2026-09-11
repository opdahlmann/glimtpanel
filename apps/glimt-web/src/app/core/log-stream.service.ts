import { computed, DestroyRef, effect, inject, Injectable, signal, untracked } from '@angular/core';
import { LogLine } from '@shared/log-view/log-view.component';
import { ActivityService } from './activity.service';
import { LiveService } from './live.service';
import { LogLineDto, LogRequest } from './live.types';

/** Linjer i minnet per loggvisning (steg 6.1); eldre kastes. */
export const LOG_MAX_LINES = 300;
/** Farger per container fra prototypens CCOL (steg 6.3): blå, grønn, lilla, cyan, gul, oransje. */
export const CONTAINER_COLORS = ['var(--color-cpu)', 'var(--color-ram)', 'var(--color-net)', 'var(--color-disk)', 'var(--color-swap)', 'var(--color-warn)'];

export type StreamState = 'idle' | 'starting' | 'streaming' | 'ended';

export interface StreamStatus {
  key: string;
  request: LogRequest;
  state: StreamState;
  /** Hubens grunn når `ended`: `eof`, `unavailable`, `error`, `stopped`. */
  reason: string | null;
  message: string | null;
}

/** Hubens `priority` → loggboksens. */
export function toLogLine(l: LogLineDto): LogLine {
  const p = l.priority === 'err' || l.priority === 'warn' ? l.priority : 'info';
  return { ts: l.ts, unit: l.unit ?? undefined, container: l.container ?? undefined, priority: p, message: l.message };
}

/** Nøkkelen som skiller to forespørsler: bytte av kilde, server, enhet, container, prioritet eller tidsrom gir ny strøm. */
export function requestKey(r: LogRequest): string {
  return [r.serverId, r.source, r.unit ?? '', r.container ?? '', r.priority ?? '', r.sinceMs ?? '', r.tail ?? ''].join('|');
}

interface Stream {
  key: string;
  request: LogRequest;
  streamId: string | null;
  /** `StartLog` er sendt og venter på svar. */
  pending: boolean;
  /** Nyeste mottatte tidsstempel; gjenstart bruker `sinceMs` = dette + 1 så ingenting mangler. */
  lastTs: number | null;
  seq: number;
}

/**
 * Strømmenes livssyklus for én loggvisning (steg 6.2): `configure(requests)` holder nøyaktig disse strømmene åpne
 * (bytte = StopLog + StartLog), maks 300 linjer nyeste først, pause med buffer og teller, «n lines dropped»-markører,
 * stopp ved skjult fane og frakobling og gjenstart ved synlig/tilkoblet med `sinceMs` = siste mottatte linje.
 * Opprettes per side (`providers: [LogStreamService]`); alt stoppes når siden forlates.
 */
@Injectable()
export class LogStreamService {
  private readonly live = inject(LiveService);
  private readonly activity = inject(ActivityService);

  private readonly streams = new Map<string, Stream>();
  private wanted: LogRequest[] = [];

  private readonly _lines = signal<LogLine[]>([]);
  private readonly _pending = signal<LogLine[]>([]);
  private readonly _paused = signal(false);
  private readonly _statuses = signal<StreamStatus[]>([]);
  private readonly _dropped = signal(0);

  /** Nyeste først, høyst 300. */
  readonly lines = this._lines.asReadonly();
  readonly paused = this._paused.asReadonly();
  /** Linjer som venter mens pausen står (høyst 300). */
  readonly pendingCount = computed(() => this._pending().length);
  readonly statuses = this._statuses.asReadonly();
  /** Linjer agenten har kastet fordi nettleseren hang etter (summen av `dropped`). */
  readonly dropped = this._dropped.asReadonly();
  /** Vi kan strømme: fanen synlig og forbindelsen oppe. */
  readonly online = computed(() => this.activity.mode() !== 'hidden' && this.live.state() === 'connected');
  /** Minst én strøm leverer. */
  readonly streaming = computed(() => this.online() && this._statuses().some((s) => s.state === 'streaming' || s.state === 'starting'));
  /** Alle strømmene er avsluttet av huben eller agenten (eof, unavailable, error). */
  readonly allEnded = computed(() => this._statuses().length > 0 && this._statuses().every((s) => s.state === 'ended'));

  constructor() {
    effect(() => {
      const online = this.online();
      untracked(() => (online ? this.reconcile() : this.suspend()));
    });
    inject(DestroyRef).onDestroy(() => this.stopAll());
  }

  /** Ønskede strømmer (høyst 4). Like nøkler beholdes, nye startes, borte stoppes. Linjene tømmes når settet endres. */
  configure(requests: LogRequest[]): void {
    const next = requests.slice(0, 4);
    const nextKeys = new Set(next.map(requestKey));
    const changed = next.length !== this.wanted.length || this.wanted.some((r) => !nextKeys.has(requestKey(r)));
    this.wanted = next;
    if (changed) {
      this._lines.set([]);
      this._pending.set([]);
      this._dropped.set(0);
    }
    this.reconcile();
  }

  pause(): void {
    this._paused.set(true);
  }

  /** Flytter bufferen inn i visningen. */
  resume(): void {
    const pending = this._pending();
    this._pending.set([]);
    if (pending.length) this._lines.update((prev) => [...pending, ...prev].slice(0, LOG_MAX_LINES));
    this._paused.set(false);
  }

  togglePause(): void {
    if (this._paused()) this.resume();
    else this.pause();
  }

  /** Tømmer linjene (f.eks. når tekstfilteret skal startes på nytt). */
  clear(): void {
    this._lines.set([]);
    this._pending.set([]);
    this._dropped.set(0);
  }

  // ---- internt ---------------------------------------------------------------------------------

  /** Starter det som mangler og stopper det som ikke lenger er ønsket. */
  private reconcile(): void {
    const wantedKeys = new Set(this.wanted.map(requestKey));
    for (const [key, stream] of [...this.streams]) {
      if (!wantedKeys.has(key)) {
        this.stopStream(stream);
        this.streams.delete(key);
      }
    }
    this.publishStatuses();
    if (!this.online()) return;
    for (const request of this.wanted) {
      const key = requestKey(request);
      let stream = this.streams.get(key);
      if (!stream) {
        stream = { key, request, streamId: null, pending: false, lastTs: null, seq: 0 };
        this.streams.set(key, stream);
      }
      if (!stream.streamId && !stream.pending) void this.startStream(stream);
    }
  }

  /** Skjult fane eller frakoblet: LiveService avslutter strømmene selv; vi glemmer stream-id-ene og venter. */
  private suspend(): void {
    for (const stream of this.streams.values()) {
      stream.seq++;
      stream.streamId = null;
      stream.pending = false;
    }
    this.publishStatuses();
  }

  private async startStream(stream: Stream): Promise<void> {
    const seq = ++stream.seq;
    stream.pending = true;
    this.setStatus(stream, 'starting', null, null);
    const request: LogRequest = stream.lastTs !== null ? { ...stream.request, sinceMs: stream.lastTs + 1, tail: null } : stream.request;
    try {
      const streamId = await this.live.startLog(request, {
        lines: (lines, dropped) => this.receive(stream, seq, lines, dropped),
        ended: (reason, message) => this.ended(stream, seq, reason, message),
      });
      if (seq !== stream.seq) {
        void this.live.stopLog(streamId);
        return;
      }
      stream.streamId = streamId;
      if (this.stateByKey.get(stream.key)?.state === 'starting') this.setStatus(stream, 'streaming', null, null);
    } catch (err) {
      if (seq === stream.seq) {
        console.warn('[log-stream] could not start', stream.request, err);
        this.setStatus(stream, 'ended', 'error', err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (seq === stream.seq) stream.pending = false;
    }
  }

  private stopStream(stream: Stream): void {
    stream.seq++;
    const id = stream.streamId;
    stream.streamId = null;
    stream.pending = false;
    if (id) void this.live.stopLog(id);
  }

  private stopAll(): void {
    for (const stream of this.streams.values()) this.stopStream(stream);
    this.streams.clear();
    this.wanted = [];
  }

  private receive(stream: Stream, seq: number, dtos: LogLineDto[], dropped: number | null): void {
    if (seq !== stream.seq) return;
    const lines = dtos.map(toLogLine);
    for (const l of lines) if (stream.lastTs === null || l.ts > stream.lastTs) stream.lastTs = l.ts;
    if (dropped && dropped > 0) {
      this._dropped.update((n) => n + dropped);
      // Grå markør «n lines dropped» der hullet er (foran de nye linjene).
      lines.unshift({ ts: lines[0]?.ts ?? Date.now(), message: '', dropped });
    }
    if (this._paused()) this._pending.update((prev) => [...lines, ...prev].slice(0, LOG_MAX_LINES));
    else this._lines.update((prev) => [...lines, ...prev].slice(0, LOG_MAX_LINES));
  }

  private ended(stream: Stream, seq: number, reason: string, message: string | null): void {
    if (seq !== stream.seq) return;
    stream.streamId = null;
    // Klientsidige avbrudd (skjult fane, gjenoppkobling) gjenopprettes av effekten; hubens avslutning står.
    if (reason === 'hidden' || reason === 'reconnecting' || reason === 'disconnected') {
      this.setStatus(stream, 'idle', reason, null);
      return;
    }
    this.setStatus(stream, 'ended', reason, message);
  }

  private readonly stateByKey = new Map<string, StreamStatus>();

  private setStatus(stream: Stream, state: StreamState, reason: string | null, message: string | null): void {
    this.stateByKey.set(stream.key, { key: stream.key, request: stream.request, state, reason, message });
    this.publishStatuses();
  }

  private publishStatuses(): void {
    for (const key of [...this.stateByKey.keys()]) if (!this.streams.has(key)) this.stateByKey.delete(key);
    this._statuses.set(this.wanted.map((r) => this.stateByKey.get(requestKey(r)) ?? { key: requestKey(r), request: r, state: 'idle' as StreamState, reason: null, message: null }));
  }
}
