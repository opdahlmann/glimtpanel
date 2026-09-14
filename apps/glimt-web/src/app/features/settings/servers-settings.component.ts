import { ChangeDetectionStrategy, Component, computed, inject, signal, TemplateRef, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { ColDef } from 'ag-grid-community';
import { ApiService, errorKey } from '@core/api.service';
import { ClipboardService } from '@core/clipboard.service';
import { FeatureFlags } from '@core/feature-flags';
import { I18nKey, I18nService } from '@core/i18n.service';
import { LiveStore } from '@core/live.store';
import { DeleteServerResponse, RotateKeyResponse, ServerListItem, SubscriptionDto } from '@core/live.types';
import { ServerListService } from '@core/server-list.service';
import { TPipe } from '@core/t.pipe';
import { ButtonComponent } from '@shared/button/button.component';
import { DataGridComponent } from '@shared/data-grid/data-grid.component';
import { GridRowContext } from '@shared/data-grid/grid-renderers';
import { InputComponent } from '@shared/input/input.component';
import { ModalComponent } from '@shared/modal/modal.component';
import { AutofocusDirective } from '@shared/util/autofocus.directive';
import { ToastService } from '@shared/toast/toast.service';
import { MAX_TAGS, normalizeTag } from '../overview/add-server/add-server-dialog.component';
import { esc } from './grid-cells';

/** En node som rad i gridet. */
export interface NodeRow {
  id: string;
  name: string;
  kind: 'server' | 'container';
  tags: string[];
  tagText: string;
  status: string;
  statusText: string;
  dot: 'up' | 'down' | 'paused';
}

/**
 * Innstillinger › Servere (steg 8.3, skjerm 11): plasslinjen «18 slots in use · 2 free forever · 16 beta» (noder av
 * begge typer), gridet med Node, Type, Tags (rad-dialog), Status og handlingene «Rotate key» (bekreftelse; for
 * containernoder vises det nye tokenet én gang) og «Remove» (dialog med avinstalleringskommando eller compose-hint;
 * plassen frigjøres straks). Pause bare bak flagg. Bare eierens noder står her.
 */
@Component({
  selector: 'gp-servers-settings',
  imports: [FormsModule, TPipe, ButtonComponent, DataGridComponent, ModalComponent, InputComponent, AutofocusDirective],
  templateUrl: './servers-settings.component.html',
  styleUrl: './settings.css',
  host: { '(click)': 'onGridClick($event)' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ServersSettingsComponent {
  private readonly api = inject(ApiService);
  private readonly i18n = inject(I18nService);
  private readonly toast = inject(ToastService);
  private readonly serverList = inject(ServerListService);
  private readonly live = inject(LiveStore);
  private readonly clipboard = inject(ClipboardService);
  readonly flags = inject(FeatureFlags);

  readonly mobileTpl = viewChild<TemplateRef<GridRowContext<NodeRow>>>('mobileRow');

  readonly sub = signal<SubscriptionDto | null>(null);
  readonly loaded = this.serverList.loaded;
  private readonly texts = computed(() => {
    this.i18n.lang();
    this.i18n.timeZone();
    return this.i18n;
  });
  readonly owned = computed(() => this.serverList.servers().filter((s) => s.role === 'owner'));
  readonly rows = computed<NodeRow[]>(() => {
    const t = this.texts();
    return this.owned().map((s) => {
      const card = this.live.card(s.id)();
      const status = card?.status ?? s.status;
      const lastSeen = card?.lastSeenAt ?? s.lastSeenAt;
      const statusText = status === 'up' ? t.t('liveLabel') : status === 'sleeping' ? t.t('sleeping') : status === 'paused' ? t.t('paused') : lastSeen ? `${t.t('lastSeen')} ${t.formatWhen(Date.parse(lastSeen))}` : t.t('down');
      return {
        id: s.id,
        name: s.name,
        kind: s.kind ?? 'server',
        tags: s.tags,
        tagText: s.tags.join(', ') || '—',
        status,
        statusText,
        dot: status === 'up' ? 'up' : status === 'down' ? 'down' : 'paused',
      };
    });
  });
  readonly slotsLine = computed(() => {
    const s = this.sub();
    const t = this.texts();
    if (!s) return '';
    return `${s.slotsUsed} ${t.t('slots')} ${t.t('slotsUsed')} · ${s.slotsFree} ${t.t('slotsFree')} · ${s.slotsBeta} ${t.t('slotsBeta')}`;
  });
  readonly rowId = (r: NodeRow) => r.id;
  readonly columns = computed<ColDef<NodeRow>[]>(() => {
    const t = this.texts();
    const pause = this.flags.pause();
    return [
      {
        field: 'name',
        colId: 'name',
        headerName: t.t('nodeCol'),
        flex: 2,
        minWidth: 160,
        cellRenderer: (p: { data?: NodeRow }) => (p.data ? `<span class="gp-dot ${p.data.dot}"></span><span class="gp-cell-strong">${esc(p.data.name)}</span>` : ''),
      },
      { field: 'kind', colId: 'kind', headerName: t.t('typeCol'), width: 110, valueFormatter: (p) => (p.data?.kind === 'container' ? t.t('containerLabel') : t.t('serverLabel')), cellStyle: { color: 'var(--w-60)', fontSize: '11px' } },
      {
        field: 'tagText',
        colId: 'tags',
        headerName: t.t('tagsCol'),
        flex: 1,
        minWidth: 120,
        cellRenderer: (p: { data?: NodeRow }) => (p.data ? `<button type="button" class="gp-cell-btn" data-action="tags" data-id="${esc(p.data.id)}" aria-label="${esc(t.t('editTags'))} ${esc(p.data.name)}">${esc(p.data.tagText)}</button>` : ''),
      },
      { field: 'statusText', colId: 'status', headerName: t.t('statusCol'), width: 150, cellStyle: { color: 'var(--w-60)', fontSize: '11px' } },
      {
        colId: 'actions',
        headerName: t.t('actionsCol'),
        width: pause ? 300 : 220,
        sortable: false,
        cellRenderer: (p: { data?: NodeRow }) =>
          p.data
            ? `<button type="button" class="gp-cell-btn" data-action="rotate" data-id="${esc(p.data.id)}">${esc(t.t('rotateKey'))}</button>` +
              (pause ? `<button type="button" class="gp-cell-btn" data-action="pause" data-id="${esc(p.data.id)}">${esc(t.t('pause'))}</button>` : '') +
              `<button type="button" class="gp-cell-btn danger" data-action="remove" data-id="${esc(p.data.id)}">${esc(t.t('removeNode'))}</button>`
            : '',
        valueFormatter: () => '',
      },
    ];
  });

  // ---- dialoger ----------------------------------------------------------------------------------
  readonly target = signal<ServerListItem | null>(null);
  readonly tagsOpen = signal(false);
  readonly rotateOpen = signal(false);
  readonly removeOpen = signal(false);
  readonly busy = signal(false);
  readonly error = signal<I18nKey | null>(null);
  /** Rotasjon av en containernode: tokenet vises én gang. */
  readonly newToken = signal<string | null>(null);
  /** Etter «Remove»: avinstalleringskommandoen (server) eller hintet (container). */
  readonly removed = signal<DeleteServerResponse | null>(null);
  readonly copied = signal(false);

  readonly tags = signal<string[]>([]);
  readonly addingTag = signal(false);
  readonly newTag = signal('');
  readonly tagError = signal<I18nKey | null>(null);
  readonly allTags = computed(() => {
    const seen = new Set<string>(this.tags());
    for (const s of this.owned()) for (const tag of s.tags) seen.add(tag);
    return [...seen];
  });
  readonly canAddTag = computed(() => this.tags().length < MAX_TAGS);

  constructor() {
    if (!this.serverList.loaded()) void this.serverList.load().catch(() => undefined);
    void this.loadSubscription();
  }

  private async loadSubscription(): Promise<void> {
    try {
      this.sub.set(await this.api.get<SubscriptionDto>('/subscription'));
    } catch (err) {
      console.warn('[servers] could not load the subscription', err);
    }
  }

  /** Knappene i gridet er HTML-renderere: handlingen leses av `data-action`. */
  onGridClick(e: Event): void {
    const btn = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-action]');
    const id = btn?.dataset['id'];
    if (!btn || !id) return;
    const action = btn.dataset['action'];
    if (action === 'tags') this.openTags(id);
    else if (action === 'rotate') this.openRotate(id);
    else if (action === 'remove') this.openRemove(id);
  }

  private find(id: string): ServerListItem | null {
    return this.owned().find((s) => s.id === id) ?? null;
  }

  openTags(id: string): void {
    const s = this.find(id);
    if (!s) return;
    this.target.set(s);
    this.tags.set([...s.tags]);
    this.addingTag.set(false);
    this.tagError.set(null);
    this.error.set(null);
    this.tagsOpen.set(true);
  }

  hasTag(tag: string): boolean {
    return this.tags().includes(tag);
  }

  toggleTag(tag: string): void {
    this.tags.update((tags) => (tags.includes(tag) ? tags.filter((t) => t !== tag) : tags.length < MAX_TAGS ? [...tags, tag] : tags));
  }

  startTag(): void {
    this.newTag.set('');
    this.tagError.set(null);
    this.addingTag.set(true);
  }

  onTagInput(e: Event): void {
    this.newTag.set((e.target as HTMLInputElement).value);
    this.tagError.set(null);
  }

  onTagKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      this.commitTag();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.addingTag.set(false);
    }
  }

  commitTag(): void {
    const raw = this.newTag();
    if (!raw.trim()) {
      this.addingTag.set(false);
      return;
    }
    const tag = normalizeTag(raw);
    if (!tag) {
      this.tagError.set('invalidTag');
      return;
    }
    if (!this.tags().includes(tag) && this.tags().length < MAX_TAGS) this.tags.update((t) => [...t, tag]);
    this.addingTag.set(false);
  }

  async saveTags(): Promise<void> {
    const s = this.target();
    if (!s || this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.api.patch<ServerListItem>(`/servers/${encodeURIComponent(s.id)}`, { tags: this.tags() });
      await this.serverList.load();
      this.tagsOpen.set(false);
      this.toast.show(this.i18n.t('saved'));
    } catch (err) {
      this.error.set(errorKey(err));
    } finally {
      this.busy.set(false);
    }
  }

  openRotate(id: string): void {
    const s = this.find(id);
    if (!s) return;
    this.target.set(s);
    this.newToken.set(null);
    this.error.set(null);
    this.copied.set(false);
    this.rotateOpen.set(true);
  }

  async rotate(): Promise<void> {
    const s = this.target();
    if (!s || this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const res = await this.api.post<RotateKeyResponse | undefined>(`/servers/${encodeURIComponent(s.id)}/rotate-key`);
      if (s.kind === 'container' && res?.token) {
        this.newToken.set(res.token);
      } else {
        this.rotateOpen.set(false);
        this.toast.show(this.i18n.t('rotateDone'));
      }
    } catch (err) {
      this.error.set(errorKey(err));
    } finally {
      this.busy.set(false);
    }
  }

  openRemove(id: string): void {
    const s = this.find(id);
    if (!s) return;
    this.target.set(s);
    this.removed.set(null);
    this.error.set(null);
    this.copied.set(false);
    this.removeOpen.set(true);
  }

  async remove(): Promise<void> {
    const s = this.target();
    if (!s || this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const res = await this.api.delete<DeleteServerResponse>(`/servers/${encodeURIComponent(s.id)}`);
      this.removed.set(res);
      await Promise.all([this.serverList.load(), this.loadSubscription()]);
      this.toast.show(this.i18n.t('removeDone'));
    } catch (err) {
      this.error.set(errorKey(err));
    } finally {
      this.busy.set(false);
    }
  }

  async copy(text: string): Promise<void> {
    this.copied.set(await this.clipboard.copy(text));
    setTimeout(() => this.copied.set(false), 1500);
  }
}
