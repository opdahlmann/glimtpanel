import { DestroyRef, inject, Injectable, signal } from '@angular/core';

/** Sekundklokken starter først når noen leser den (ingen tikk på sider uten klokke). */
export const CLOCK_SECOND_MS = 1000;
export const CLOCK_MINUTE_MS = 60_000;

/**
 * Én klokke for hele appen (steg 9.2): komponenter som viser tid eller henter historikk med jevne mellomrom leser
 * `second`/`minute` i stedet for å ha egne `setInterval`. Ett tikk per sekund uansett hvor mange som lytter, og
 * ingenting tikker før første leser.
 */
@Injectable({ providedIn: 'root' })
export class ClockService {
  private readonly _second = signal(Date.now());
  private readonly _minute = signal(Date.now());
  private secondTimer: ReturnType<typeof setInterval> | null = null;
  private minuteTimer: ReturnType<typeof setInterval> | null = null;

  /** ms nå, oppdatert hvert sekund. */
  readonly second = () => {
    this.armSecond();
    return this._second();
  };

  /** ms nå, oppdatert hvert minutt (historikk-oppfrisking). */
  readonly minute = () => {
    this.armMinute();
    return this._minute();
  };

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      if (this.secondTimer) clearInterval(this.secondTimer);
      if (this.minuteTimer) clearInterval(this.minuteTimer);
    });
  }

  private armSecond(): void {
    if (this.secondTimer || typeof setInterval !== 'function') return;
    this.secondTimer = setInterval(() => this._second.set(Date.now()), CLOCK_SECOND_MS);
  }

  private armMinute(): void {
    if (this.minuteTimer || typeof setInterval !== 'function') return;
    this.minuteTimer = setInterval(() => this._minute.set(Date.now()), CLOCK_MINUTE_MS);
  }
}
