import { computed, inject, Injectable, signal } from '@angular/core';
import { ApiService } from './api.service';
import { AlertDto, AlertEventDto, AlertListResponse } from './live.types';

/** Høyst så mange rader holdes i minnet (samme grense som `GET /api/alerts`). */
export const ALERT_LIMIT = 200;

/**
 * Varslene (steg 7.1 og 7.3): listen fra `GET /api/alerts?state=all` og de levende `Alert(event)`-meldingene som
 * LiveService gir videre. `activeCount` driver badgen i navigasjonen; `active`/`resolved` er utledet av listen,
 * nyeste først. `load()` kalles av skallet ved innlogging og av varselsiden.
 */
@Injectable({ providedIn: 'root' })
export class AlertStore {
  private readonly api = inject(ApiService);

  private readonly _alerts = signal<AlertDto[]>([]);
  private readonly _loaded = signal(false);
  private inflight: Promise<void> | null = null;

  readonly alerts = this._alerts.asReadonly();
  readonly loaded = this._loaded.asReadonly();
  readonly active = computed(() => this._alerts().filter((a) => a.state === 'firing'));
  readonly resolved = computed(() => this._alerts().filter((a) => a.state === 'resolved'));
  readonly activeCount = computed(() => this.active().length);
  readonly hasActive = computed(() => this.activeCount() > 0);

  /** Henter alle (én om gangen). Feil logges; listen beholdes. */
  load(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.inflight = this.api
      .get<AlertListResponse>('/alerts', { query: { state: 'all' } })
      .then((res) => {
        this._alerts.set(sortAlerts(res.alerts));
        this._loaded.set(true);
      })
      .catch((err: unknown) => console.warn('[alerts] could not load alerts', err))
      .finally(() => (this.inflight = null));
    return this.inflight;
  }

  /** `Alert(event)`: erstatter raden med samme id, ellers legges den til øverst. */
  applyEvent(event: AlertEventDto): void {
    if (!event?.alert?.id) return;
    this._alerts.update((list) => sortAlerts([event.alert, ...list.filter((a) => a.id !== event.alert.id)]).slice(0, ALERT_LIMIT));
  }

  /** Stille satt fra varselsiden: alle aktive rader for serveren får badgen med en gang. */
  markSilenced(serverId: string, silenced: boolean): void {
    this._alerts.update((list) => list.map((a) => (a.serverId === serverId && a.state === 'firing' ? { ...a, silenced } : a)));
  }

  /** Brukes ved utlogging og av testene. */
  clear(): void {
    this._alerts.set([]);
    this._loaded.set(false);
  }

  /** Beholdt for skallets stubb-grensesnitt fra fase 3 (testene setter tallet direkte). */
  setActiveCount(n: number): void {
    const count = Math.max(0, Math.floor(n));
    const fake: AlertDto[] = Array.from({ length: count }, (_, i) => ({
      id: `stub-${i}`,
      serverId: '',
      serverName: '',
      rule: 'server_down',
      key: '',
      severity: 'critical',
      state: 'firing',
      detail: '',
      firedAt: new Date(0).toISOString(),
      resolvedAt: null,
      lastReminderAt: null,
      silenced: false,
      notifiedVia: [],
    }));
    this._alerts.set(fake);
  }
}

/** Nyeste først: aktive på `firedAt`, løste på `resolvedAt`; id som stabil tiebreaker. */
export function sortAlerts(list: AlertDto[]): AlertDto[] {
  return [...list].sort((a, b) => {
    const at = Date.parse(a.state === 'resolved' && a.resolvedAt ? a.resolvedAt : a.firedAt);
    const bt = Date.parse(b.state === 'resolved' && b.resolvedAt ? b.resolvedAt : b.firedAt);
    return bt - at || a.id.localeCompare(b.id);
  });
}
