import { computed, inject, Injectable, signal } from '@angular/core';
import { ApiService } from './api.service';
import { GroupDto } from './live.types';
import { SessionService } from './session.service';

/** Demokontoen får lese, ikke skrive (huben svarer 403). */
export const DEMO_EMAIL = 'demo@glimtpanel.com';

/**
 * Brukerens grupper (IMPLEMENTERINGSPLAN steg 13.2): `GET /api/groups` ved inngang til oversikten, oppdatert
 * lokalt etter hver endring (svaret fra huben erstatter gruppen). Gruppekortet regnes i nettleseren fra `Card`-ene,
 * så det finnes ingen SignalR-melding for grupper. Rekkefølgen er `order`; flytting bytter `order` mellom naboer.
 */
@Injectable({ providedIn: 'root' })
export class GroupsStore {
  private readonly api = inject(ApiService);
  private readonly session = inject(SessionService);

  private readonly _groups = signal<GroupDto[]>([]);
  private readonly _loaded = signal(false);
  private inflight: Promise<GroupDto[]> | null = null;

  readonly groups = computed(() => [...this._groups()].sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt)));
  readonly loaded = this._loaded.asReadonly();
  readonly byId = computed(() => new Map(this._groups().map((g) => [g.id, g])));
  readonly readOnly = computed(() => (this.session.user()?.email ?? '').toLowerCase() === DEMO_EMAIL);

  /** Gruppene en node står i. */
  groupsOf(serverId: string): GroupDto[] {
    return this.groups().filter((g) => g.memberIds.includes(serverId));
  }

  load(): Promise<GroupDto[]> {
    if (this.inflight) return this.inflight;
    this.inflight = this.api
      .get<GroupDto[]>('/groups')
      .then((list) => {
        this._groups.set(list);
        this._loaded.set(true);
        return list;
      })
      .finally(() => (this.inflight = null));
    return this.inflight;
  }

  async create(name: string, memberIds: string[] = []): Promise<GroupDto> {
    const group = await this.api.post<GroupDto>('/groups', { name, memberIds });
    this._groups.update((gs) => [...gs, group]);
    return group;
  }

  async rename(id: string, name: string): Promise<GroupDto> {
    return this.patch(id, { name });
  }

  async setMembers(id: string, memberIds: string[]): Promise<GroupDto> {
    return this.patch(id, { memberIds });
  }

  /** Legger noden i gruppen, eller tar den ut hvis den står der. */
  async toggleMember(id: string, serverId: string): Promise<GroupDto> {
    const group = this.byId().get(id);
    if (!group) throw new Error(`unknown group ${id}`);
    const members = group.memberIds.includes(serverId) ? group.memberIds.filter((m) => m !== serverId) : [...group.memberIds, serverId];
    return this.setMembers(id, members);
  }

  /** Flytter gruppen ett hakk opp (-1) eller ned (+1) ved å bytte `order` med naboen. */
  async move(id: string, dir: -1 | 1): Promise<void> {
    const list = this.groups();
    const i = list.findIndex((g) => g.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    const a = list[i];
    const b = list[j];
    // Like «order»-verdier (f.eks. to seedede grupper) tvinges til posisjonene sine først.
    const orderA = a.order === b.order ? j : b.order;
    const orderB = a.order === b.order ? i : a.order;
    await Promise.all([this.patch(a.id, { order: orderA }), this.patch(b.id, { order: orderB })]);
  }

  async remove(id: string): Promise<void> {
    await this.api.delete(`/groups/${encodeURIComponent(id)}`);
    this._groups.update((gs) => gs.filter((g) => g.id !== id));
  }

  /** Nullstilles ved utlogging (som ServerListService). */
  clear(): void {
    this._groups.set([]);
    this._loaded.set(false);
  }

  private async patch(id: string, body: Partial<Pick<GroupDto, 'name' | 'memberIds' | 'order'>>): Promise<GroupDto> {
    const group = await this.api.patch<GroupDto>(`/groups/${encodeURIComponent(id)}`, body);
    this._groups.update((gs) => gs.map((g) => (g.id === id ? group : g)));
    return group;
  }
}
