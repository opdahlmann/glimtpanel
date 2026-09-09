import { DestroyRef, inject, Injectable, signal } from '@angular/core';

export type ActivityMode = 'active' | 'idle' | 'hidden';

/** Uten interaksjon så lenge → idle (SetInterval 5000). */
export const IDLE_AFTER_MS = 2 * 60_000;
const ACTIVITY_EVENTS = ['pointermove', 'pointerdown', 'keydown', 'touchstart', 'scroll', 'wheel'] as const;

/**
 * `mode`: `hidden` når fanen er skjult (`visibilitychange`), `idle` etter 2 min uten pointermove/keydown/touchstart/
 * scroll/wheel, ellers `active`. LiveService reagerer: hidden → alle abonnementer av, idle → SetInterval(5000),
 * active → SetInterval(1000).
 */
@Injectable({ providedIn: 'root' })
export class ActivityService {
  private readonly _mode = signal<ActivityMode>(initialMode());
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private lastActivity = Date.now();

  readonly mode = this._mode.asReadonly();

  constructor() {
    if (typeof document === 'undefined' || typeof window === 'undefined') return;
    const onActivity = () => this.touch();
    const onVisibility = () => this.visibility();
    for (const ev of ACTIVITY_EVENTS) window.addEventListener(ev, onActivity, { passive: true, capture: true });
    document.addEventListener('visibilitychange', onVisibility);
    this.armIdle();
    inject(DestroyRef).onDestroy(() => {
      for (const ev of ACTIVITY_EVENTS) window.removeEventListener(ev, onActivity, { capture: true });
      document.removeEventListener('visibilitychange', onVisibility);
      this.clearIdle();
    });
  }

  /** Registrerer interaksjon: hidden forblir hidden, ellers active og ny 2-minutters frist. */
  touch(): void {
    this.lastActivity = Date.now();
    if (this._mode() === 'hidden') return;
    if (this._mode() !== 'active') this._mode.set('active');
    this.armIdle();
  }

  private visibility(): void {
    if (document.visibilityState === 'hidden') {
      this.clearIdle();
      this._mode.set('hidden');
    } else {
      // Tilbake fra skjult: vi regner brukeren som aktiv (fanen ble nettopp åpnet).
      this._mode.set('active');
      this.lastActivity = Date.now();
      this.armIdle();
    }
  }

  private armIdle(): void {
    this.clearIdle();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this._mode() === 'active') this._mode.set('idle');
    }, IDLE_AFTER_MS);
  }

  private clearIdle(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}

function initialMode(): ActivityMode {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden' ? 'hidden' : 'active';
}
