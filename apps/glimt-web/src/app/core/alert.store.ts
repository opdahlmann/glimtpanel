import { computed, Injectable, signal } from '@angular/core';

/** Stubb til fase 7: antall aktive varsler for badgen i navigasjonen. `Alert(event)` fyller den i steg 7.1. */
@Injectable({ providedIn: 'root' })
export class AlertStore {
  private readonly _activeCount = signal(0);

  readonly activeCount = this._activeCount.asReadonly();
  readonly hasActive = computed(() => this._activeCount() > 0);

  setActiveCount(n: number): void {
    this._activeCount.set(Math.max(0, Math.floor(n)));
  }
}
