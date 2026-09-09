import { computed, inject, Injectable, signal } from '@angular/core';
import { HubConnection, HubConnectionBuilder, LogLevel } from '@microsoft/signalr';
import { ConfigService } from './config.service';
import { applyServerStatus, ServerMap, sortServers } from './live.reducer';
import { LiveState, ServerStatusDto } from './live.types';

/** Forsinkelser for automatisk gjenoppkobling (IMPLEMENTERINGSPLAN 3.4). */
export const RECONNECT_DELAYS_MS = [0, 2000, 5000, 10000, 30000];
/** Ny full tilkobling etter at gjenoppkoblingen har gitt opp, eller når første tilkobling feiler. */
export const RETRY_DELAY_MS = 5000;

/**
 * SignalR-forbindelsen mot /hub/live. Skjelettversjon: kun `ServerStatus` og `SubscribeOverview`.
 * Refcount per server, adaptivt intervall osv. kommer i fase 3.
 */
@Injectable({ providedIn: 'root' })
export class LiveService {
  private readonly configService = inject(ConfigService);
  private connection: HubConnection | null = null;
  private stopped = true;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly _state = signal<LiveState>('disconnected');
  private readonly serverMap = signal<ServerMap>(new Map());

  readonly state = this._state.asReadonly();
  /** Alle servere vi har fått `ServerStatus` for, sortert på navn. */
  readonly servers = computed(() => sortServers(this.serverMap()));

  /** Kobler til huben og abonnerer på oversikten. Trygg å kalle flere ganger. */
  async start(): Promise<void> {
    if (this.connection) {
      return;
    }
    this.stopped = false;
    const connection = new HubConnectionBuilder()
      .withUrl(this.configService.config().hubUrl)
      .withAutomaticReconnect(RECONNECT_DELAYS_MS)
      .configureLogging(LogLevel.Warning)
      .build();

    connection.on('ServerStatus', (dto: ServerStatusDto) => {
      this.serverMap.update((servers) => applyServerStatus(servers, dto));
    });
    connection.onreconnecting(() => this._state.set('reconnecting'));
    connection.onreconnected(() => {
      this._state.set('connected');
      void this.subscribeOverview();
    });
    connection.onclose(() => {
      this._state.set('disconnected');
      this.scheduleRetry();
    });

    this.connection = connection;
    await this.connect();
  }

  /** Kobler fra og stopper alle nye forsøk. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.clearRetry();
    const connection = this.connection;
    this.connection = null;
    if (connection) {
      try {
        await connection.stop();
      } catch (err) {
        console.warn('[live] error while stopping hub connection', err);
      }
    }
    this._state.set('disconnected');
  }

  private async connect(): Promise<void> {
    const connection = this.connection;
    if (!connection || this.stopped) {
      return;
    }
    this._state.set('connecting');
    try {
      await connection.start();
      this._state.set('connected');
      await this.subscribeOverview();
    } catch (err) {
      if (!this.stopped) {
        console.warn('[live] could not connect to hub, retrying', err);
      }
      this._state.set('disconnected');
      this.scheduleRetry();
    }
  }

  private async subscribeOverview(): Promise<void> {
    try {
      await this.connection?.invoke('SubscribeOverview');
    } catch (err) {
      console.warn('[live] SubscribeOverview failed', err);
    }
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer !== null) {
      return;
    }
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
