import { computed, DestroyRef, effect, inject, Injectable, signal, untracked } from '@angular/core';
import { LiveService } from './live.service';

/** Banneret vises først når forbindelsen har vært borte så lenge (korte gjenoppkoblinger blinker ikke). */
export const OFFLINE_AFTER_MS = 2000;

/**
 * `offline` når `LiveService.state !== 'connected'` i mer enn 2 s, eller `navigator.onLine === false`.
 * `frozenAt` er tidspunktet for siste melding (kortene beholder verdiene, banneret viser klokkeslettet).
 */
@Injectable({ providedIn: 'root' })
export class ConnectionService {
  private readonly live = inject(LiveService);
  private readonly _lostLongEnough = signal(false);
  private readonly _browserOnline = signal(typeof navigator === 'undefined' ? true : navigator.onLine !== false);
  private timer: ReturnType<typeof setTimeout> | null = null;

  readonly state = this.live.state;
  readonly browserOnline = this._browserOnline.asReadonly();
  readonly offline = computed(() => this._lostLongEnough() || !this._browserOnline());
  /** ms-tidspunkt for siste melding fra huben, eller null. */
  readonly frozenAt = this.live.lastMessageAt;

  constructor() {
    effect(() => {
      const connected = this.live.state() === 'connected';
      untracked(() => this.onState(connected));
    });
    if (typeof window !== 'undefined') {
      const online = () => this._browserOnline.set(true);
      const offline = () => this._browserOnline.set(false);
      window.addEventListener('online', online);
      window.addEventListener('offline', offline);
      inject(DestroyRef).onDestroy(() => {
        window.removeEventListener('online', online);
        window.removeEventListener('offline', offline);
        this.clear();
      });
    }
  }

  reconnect(): void {
    void this.live.reconnect();
  }

  private onState(connected: boolean): void {
    this.clear();
    if (connected) {
      this._lostLongEnough.set(false);
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.live.state() !== 'connected') this._lostLongEnough.set(true);
    }, OFFLINE_AFTER_MS);
  }

  private clear(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
