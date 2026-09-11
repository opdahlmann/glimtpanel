import { inject, Injectable } from '@angular/core';
import { ApiService } from './api.service';

export type HistoryRange = '1h' | '24h';

/** `GET /api/servers/{id}/history?metric=&range=` (hub: HistoryResult). Prosentmetrikker fyller `values`, `net:` fyller `rx`/`tx`. */
export interface HistoryResult {
  metric: string;
  range: HistoryRange;
  stepMs: number;
  /** Unix-ms for første bøtte. */
  from: number;
  to: number;
  values?: (number | null)[];
  rx?: (number | null)[];
  tx?: (number | null)[];
}

/** Svar mellomlagres så lenge per (server, metrikk, område) (steg 5.14). */
export const HISTORY_CACHE_MS = 60_000;

/**
 * Historikk fra hubens 24-timersbuffer (steg 5.3 og 5.14): `cpu`, `mem`, `swap`, `disk:<sti>`, `net:<grensesnitt>`,
 * `cont:<id>` (CPU) og `cont:<id>:mem`. Én forespørsel om gangen per nøkkel; svaret lever i 60 s.
 */
@Injectable({ providedIn: 'root' })
export class HistoryService {
  private readonly api = inject(ApiService);
  private readonly cache = new Map<string, { at: number; value: HistoryResult }>();
  private readonly inflight = new Map<string, Promise<HistoryResult>>();

  /** Klokke i ms; byttes ut i tester. */
  now: () => number = () => Date.now();

  get(serverId: string, metric: string, range: HistoryRange): Promise<HistoryResult> {
    const key = `${serverId}|${metric}|${range}`;
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < HISTORY_CACHE_MS) return Promise.resolve(hit.value);
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const req = this.api
      .get<HistoryResult>(`/servers/${encodeURIComponent(serverId)}/history`, { query: { metric, range } })
      .then((value) => {
        this.cache.set(key, { at: this.now(), value });
        return value;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, req);
    return req;
  }

  /** Glemmer mellomlagrede svar (alle, eller for én server). */
  clear(serverId?: string): void {
    if (!serverId) {
      this.cache.clear();
      return;
    }
    for (const key of [...this.cache.keys()]) if (key.startsWith(`${serverId}|`)) this.cache.delete(key);
  }
}
