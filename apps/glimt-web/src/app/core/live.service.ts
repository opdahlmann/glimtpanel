import { effect, inject, Injectable, signal, untracked } from '@angular/core';
import { HubConnection, HubConnectionBuilder, HubConnectionState, LogLevel } from '@microsoft/signalr';
import { ActivityMode, ActivityService } from './activity.service';
import { AlertStore } from './alert.store';
import { ConfigService } from './config.service';
import { LiveStore } from './live.store';
import { AlertEventDto, CardDto, LiveState, LogLineDto, LogRequest, ServerDto, ServerStatusDto } from './live.types';
import { SessionService } from './session.service';

/** Forsinkelser for automatisk gjenoppkobling (IMPLEMENTERINGSPLAN 3.4). */
export const RECONNECT_DELAYS_MS = [0, 2000, 5000, 10000, 30000];
/** Ny full tilkobling etter at gjenoppkoblingen har gitt opp, eller når første tilkobling feiler. */
export const RETRY_DELAY_MS = 5000;
export const INTERVAL_ACTIVE_MS = 1000;
export const INTERVAL_IDLE_MS = 5000;

export interface LogHandlers {
  lines(lines: LogLineDto[], dropped: number | null): void;
  ended(reason: string, message: string | null): void;
}

type Unsubscribe = () => void;

/**
 * SignalR-forbindelsen mot /hub/live (steg 3.4). JSON-protokoll (MessagePack sender PascalCase-navn), token fra
 * SessionService, `withAutomaticReconnect([0, 2000, 5000, 10000, 30000])`, `state`-signal, alle klientmetodene,
 * refcount per abonnement (flere komponenter deler ett hub-abonnement, gjenopprettes etter gjenoppkobling),
 * adaptivt intervall fra ActivityService (skjult → alt av, idle → 5 s, aktiv → 1 s), alt stoppes ved utlogging.
 */
@Injectable({ providedIn: 'root' })
export class LiveService {
  private readonly configService = inject(ConfigService);
  private readonly session = inject(SessionService);
  private readonly store = inject(LiveStore);
  private readonly alerts = inject(AlertStore);
  private readonly activity = inject(ActivityService);

  private connection: HubConnection | null = null;
  /** Brukeren forbindelsen ble åpnet for. */
  private connectedAs: string | null = null;
  private stopped = true;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  private overviewCount = 0;
  private readonly serverCounts = new Map<string, number>();
  /** Det huben faktisk har fått `Subscribe*` for akkurat nå. */
  private hubOverview = false;
  private readonly hubServers = new Set<string>();
  private suspended = false;
  private intervalMs = INTERVAL_ACTIVE_MS;
  private hubIntervalMs: number | null = null;

  private readonly logHandlers = new Map<string, LogHandlers>();
  /** Log/LogEnded som kommer før `StartLog`-svaret (etterslepet sendes straks): holdes til mottakeren er registrert. */
  private readonly earlyLogs = new Map<string, { lines: { lines: LogLineDto[]; dropped: number | null }[]; ended: { reason: string; message: string | null } | null }>();
  private readonly addedCallbacks = new Set<(card: CardDto) => void>();
  private readonly removedCallbacks = new Set<(id: string) => void>();

  private readonly _state = signal<LiveState>('disconnected');
  private readonly _lastMessageAt = signal<number | null>(null);

  readonly state = this._state.asReadonly();
  /** Tidspunkt (ms) for siste melding fra huben. ConnectionService viser det som «frosset kl.». */
  readonly lastMessageAt = this._lastMessageAt.asReadonly();

  constructor() {
    effect(() => {
      const mode = this.activity.mode();
      untracked(() => this.onMode(mode));
    });
    effect(() => {
      const authed = this.session.isAuthenticated();
      untracked(() => {
        if (!authed && this.connection) void this.stop();
      });
    });
    // Ny identitet mens forbindelsen står (inn i eller ut av demoen, steg 10.1): huben kjenner bare den gamle, så alt startes på nytt.
    effect(() => {
      const userId = this.session.user()?.id ?? null;
      untracked(() => {
        if (this.connection && userId && this.connectedAs && userId !== this.connectedAs) void this.restartForNewUser();
      });
    });
  }

  // ---- abonnementer ------------------------------------------------------------------------------

  /** Oversikten (Card/ServerStatus for alle synlige servere). Returnerer avmeldingsfunksjonen. */
  subscribeOverview(): Unsubscribe {
    this.overviewCount++;
    this.start();
    if (this.overviewCount === 1) void this.syncOverview();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.overviewCount = Math.max(0, this.overviewCount - 1);
      if (this.overviewCount === 0) void this.syncOverview();
    };
  }

  /** Full projeksjon for én server. Returnerer avmeldingsfunksjonen. */
  subscribeServer(id: string): Unsubscribe {
    const n = (this.serverCounts.get(id) ?? 0) + 1;
    this.serverCounts.set(id, n);
    this.start();
    if (n === 1) void this.syncServer(id);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const left = Math.max(0, (this.serverCounts.get(id) ?? 1) - 1);
      if (left === 0) this.serverCounts.delete(id);
      else this.serverCounts.set(id, left);
      if (left === 0) void this.syncServer(id);
    };
  }

  /** 1000 aktiv, 5000 idle. Sendes straks når vi er tilkoblet, ellers etter neste tilkobling. */
  setInterval(ms: number): void {
    this.intervalMs = ms;
    void this.syncInterval();
  }

  async startLog(req: LogRequest, handlers: LogHandlers): Promise<string> {
    this.start();
    const conn = await this.whenConnected();
    const streamId = await conn.invoke<string>('StartLog', req);
    const early = this.earlyLogs.get(streamId);
    this.earlyLogs.delete(streamId);
    if (early?.ended) {
      handlers.ended(early.ended.reason, early.ended.message);
      return streamId;
    }
    this.logHandlers.set(streamId, handlers);
    for (const batch of early?.lines ?? []) handlers.lines(batch.lines, batch.dropped);
    return streamId;
  }

  async stopLog(streamId: string): Promise<void> {
    this.logHandlers.delete(streamId);
    this.earlyLogs.delete(streamId);
    if (this.isConnected()) {
      try {
        await this.connection?.invoke('StopLog', streamId);
      } catch (err) {
        console.warn('[live] StopLog failed', err);
      }
    }
  }

  onServerAdded(cb: (card: CardDto) => void): Unsubscribe {
    this.addedCallbacks.add(cb);
    return () => this.addedCallbacks.delete(cb);
  }

  onServerRemoved(cb: (id: string) => void): Unsubscribe {
    this.removedCallbacks.add(cb);
    return () => this.removedCallbacks.delete(cb);
  }

  // ---- forbindelsen ------------------------------------------------------------------------------

  /** Lukker og åpner forbindelsen på nytt (knappen «Reconnect» i banneret). */
  async reconnect(): Promise<void> {
    await this.stop();
    this.start();
  }

  /** Ny bruker (demo inn/ut): alt fra den forrige identiteten glemmes før forbindelsen åpnes igjen. */
  private async restartForNewUser(): Promise<void> {
    await this.stop();
    this.store.clear();
    this.start();
  }

  /** Kobler fra, avslutter loggstrømmer og glemmer hva huben har fått. Refcountene beholdes. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.clearRetry();
    const connection = this.connection;
    this.connection = null;
    this.hubOverview = false;
    this.hubServers.clear();
    this.hubIntervalMs = null;
    this.endAllLogs('disconnected');
    if (connection) {
      try {
        await connection.stop();
      } catch (err) {
        console.warn('[live] error while stopping hub connection', err);
      }
    }
    this._state.set('disconnected');
  }

  /** Åpner forbindelsen når vi er innlogget. Trygg å kalle flere ganger; skallet kaller den ved oppstart. */
  start(): void {
    if (this.connection || !this.session.isAuthenticated()) return;
    this.stopped = false;
    this.connectedAs = this.session.user()?.id ?? null;
    const connection = new HubConnectionBuilder()
      .withUrl(this.configService.config().hubUrl, { accessTokenFactory: () => this.session.accessToken() ?? '' })
      .withAutomaticReconnect(RECONNECT_DELAYS_MS)
      .configureLogging(LogLevel.Warning)
      .build();

    connection.on('ServerStatus', (dto: ServerStatusDto) => {
      this.touch();
      this.store.applyStatus(dto);
    });
    connection.on('Card', (dto: CardDto) => {
      this.touch();
      this.store.applyCard(dto);
    });
    connection.on('Server', (dto: ServerDto) => {
      this.touch();
      this.store.applyServer(dto);
    });
    connection.on('Log', (streamId: string, lines: LogLineDto[], dropped: number | null) => {
      this.touch();
      const h = this.logHandlers.get(streamId);
      if (h) h.lines(lines ?? [], dropped ?? null);
      else this.early(streamId).lines.push({ lines: lines ?? [], dropped: dropped ?? null });
    });
    connection.on('LogEnded', (streamId: string, reason: string, message: string | null) => {
      this.touch();
      const h = this.logHandlers.get(streamId);
      this.logHandlers.delete(streamId);
      if (h) h.ended(reason, message ?? null);
      else if (this.earlyLogs.has(streamId)) this.early(streamId).ended = { reason, message: message ?? null };
    });
    connection.on('ServerAdded', (dto: CardDto) => {
      this.touch();
      this.store.applyCard(dto);
      for (const cb of this.addedCallbacks) cb(dto);
    });
    connection.on('ServerRemoved', (id: string) => {
      this.touch();
      this.store.remove(id);
      for (const cb of this.removedCallbacks) cb(id);
    });
    connection.on('Alert', (event: AlertEventDto) => {
      this.touch();
      this.alerts.applyEvent(event);
      this.store.applyAlertCount(event.alert.serverId, event.activeOnServer, event.worstSeverity);
    });
    connection.onreconnecting(() => {
      this._state.set('reconnecting');
      this.hubOverview = false;
      this.hubServers.clear();
      this.hubIntervalMs = null;
      this.endAllLogs('reconnecting');
    });
    connection.onreconnected(() => {
      this._state.set('connected');
      void this.resync();
    });
    connection.onclose(() => {
      this._state.set('disconnected');
      this.hubOverview = false;
      this.hubServers.clear();
      this.hubIntervalMs = null;
      this.endAllLogs('disconnected');
      this.scheduleRetry();
    });

    this.connection = connection;
    void this.connect();
  }

  private async connect(): Promise<void> {
    const connection = this.connection;
    if (!connection || this.stopped) return;
    this._state.set('connecting');
    try {
      await connection.start();
      if (this.connection !== connection) return;
      this._state.set('connected');
      await this.resync();
    } catch (err) {
      if (!this.stopped) console.warn('[live] could not connect to hub, retrying', err);
      this._state.set('disconnected');
      this.scheduleRetry();
    }
  }

  private isConnected(): boolean {
    return this.connection?.state === HubConnectionState.Connected;
  }

  private whenConnected(): Promise<HubConnection> {
    return new Promise((resolve, reject) => {
      const tick = () => {
        if (this.stopped || !this.connection) return reject(new Error('live: not started'));
        if (this.isConnected()) return resolve(this.connection);
        setTimeout(tick, 200);
      };
      tick();
    });
  }

  /** Etter tilkobling/gjenoppkobling og når fanen blir synlig: gjenopprett alt med refcount > 0. */
  private async resync(): Promise<void> {
    await this.syncInterval();
    await this.syncOverview();
    for (const id of new Set([...this.serverCounts.keys(), ...this.hubServers])) await this.syncServer(id);
  }

  private async syncOverview(): Promise<void> {
    if (!this.isConnected()) return;
    const want = this.overviewCount > 0 && !this.suspended;
    if (want === this.hubOverview) return;
    this.hubOverview = want;
    await this.invoke(want ? 'SubscribeOverview' : 'UnsubscribeOverview');
  }

  private async syncServer(id: string): Promise<void> {
    if (!this.isConnected()) return;
    const want = (this.serverCounts.get(id) ?? 0) > 0 && !this.suspended;
    if (want === this.hubServers.has(id)) return;
    if (want) this.hubServers.add(id);
    else this.hubServers.delete(id);
    await this.invoke(want ? 'SubscribeServer' : 'UnsubscribeServer', id);
  }

  private async syncInterval(): Promise<void> {
    if (!this.isConnected() || this.hubIntervalMs === this.intervalMs) return;
    this.hubIntervalMs = this.intervalMs;
    await this.invoke('SetInterval', this.intervalMs);
  }

  private async invoke(method: string, ...args: unknown[]): Promise<void> {
    try {
      await this.connection?.invoke(method, ...args);
    } catch (err) {
      // Avbrutt fordi vi selv lukket forbindelsen (utlogging, skjult fane): ikke verdt en advarsel.
      if (!this.stopped) console.warn(`[live] ${method} failed`, err);
    }
  }

  private onMode(mode: ActivityMode): void {
    if (mode === 'hidden') {
      this.suspended = true;
      void this.syncOverview();
      for (const id of [...this.hubServers]) void this.syncServer(id);
      for (const id of [...this.logHandlers.keys()]) {
        const h = this.logHandlers.get(id);
        void this.stopLog(id);
        h?.ended('hidden', null);
      }
      return;
    }
    const wasSuspended = this.suspended;
    this.suspended = false;
    this.intervalMs = mode === 'idle' ? INTERVAL_IDLE_MS : INTERVAL_ACTIVE_MS;
    if (wasSuspended) void this.resync();
    else void this.syncInterval();
  }

  private endAllLogs(reason: string): void {
    const handlers = [...this.logHandlers.values()];
    this.logHandlers.clear();
    this.earlyLogs.clear();
    for (const h of handlers) h.ended(reason, null);
  }

  /** Bøtte for meldinger til en strøm uten mottaker ennå (høyst 20 strømmer; de eldste glemmes). */
  private early(streamId: string): { lines: { lines: LogLineDto[]; dropped: number | null }[]; ended: { reason: string; message: string | null } | null } {
    let e = this.earlyLogs.get(streamId);
    if (!e) {
      e = { lines: [], ended: null };
      this.earlyLogs.set(streamId, e);
      if (this.earlyLogs.size > 20) this.earlyLogs.delete(this.earlyLogs.keys().next().value as string);
    }
    return e;
  }

  private touch(): void {
    this._lastMessageAt.set(Date.now());
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer !== null) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, RETRY_DELAY_MS);
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }
}
