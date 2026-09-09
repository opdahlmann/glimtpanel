import { computed, inject, Injectable, signal } from '@angular/core';
import { ApiService } from './api.service';
import { ServerListItem } from './live.types';
import { SessionService } from './session.service';

/** `GET /api/servers` (det som lagres: navn, tagger, rolle). Fyller rollekartet i SessionService. */
@Injectable({ providedIn: 'root' })
export class ServerListService {
  private readonly api = inject(ApiService);
  private readonly session = inject(SessionService);

  private readonly _servers = signal<ServerListItem[]>([]);
  private readonly _loaded = signal(false);
  private inflight: Promise<ServerListItem[]> | null = null;

  readonly servers = this._servers.asReadonly();
  readonly loaded = this._loaded.asReadonly();
  readonly byId = computed(() => new Map(this._servers().map((s) => [s.id, s])));

  /** Henter listen (én om gangen). */
  load(): Promise<ServerListItem[]> {
    if (this.inflight) return this.inflight;
    this.inflight = this.api
      .get<ServerListItem[]>('/servers')
      .then((list) => {
        this.set(list);
        return list;
      })
      .finally(() => (this.inflight = null));
    return this.inflight;
  }

  set(list: ServerListItem[]): void {
    this._servers.set(list);
    this._loaded.set(true);
    this.session.setServerRoles(list.map((s) => [s.id, s.role]));
  }

  clear(): void {
    this._servers.set([]);
    this._loaded.set(false);
  }
}
