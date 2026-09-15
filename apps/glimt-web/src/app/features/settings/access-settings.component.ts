import { ChangeDetectionStrategy, Component, computed, inject, signal, TemplateRef, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { ColDef } from 'ag-grid-community';
import { ApiError, ApiService, errorKey } from '@core/api.service';
import { I18nKey, I18nService } from '@core/i18n.service';
import { GrantDto } from '@core/live.types';
import { ServerListService } from '@core/server-list.service';
import { TPipe } from '@core/t.pipe';
import { ButtonComponent } from '@shared/button/button.component';
import { escapeHtml, DataGridComponent } from '@shared/data-grid/data-grid.component';
import { GridRowContext } from '@shared/data-grid/grid-renderers';
import { InputComponent } from '@shared/input/input.component';
import { SelectComponent, SelectOption } from '@shared/select/select.component';
import { ToastService } from '@shared/toast/toast.service';

/** En tilgang som rad i gridet. */
export interface GrantRow {
  id: string;
  initials: string;
  email: string;
  scope: string;
  status: GrantDto['status'];
  pending: boolean;
}

export function grantRow(g: GrantDto, allServers: string): GrantRow {
  return { id: g.id, initials: g.initials, email: g.email, scope: g.scope === 'all' ? allServers : g.scope.join(', '), status: g.status, pending: g.status === 'pending' };
}

/**
 * Innstillinger › Tilganger (steg 8.4, skjerm 12): invitasjonskort (e-post, omfang All servers + tagger, «Invite» →
 * toast «Invitation sent») og gridet med initialer, e-post, badge «Reader», omfang, «invited · not accepted yet» i
 * oransje ved pending og «Remove access». Huben håndhever uansett; leseren ser aldri denne fanen med handlinger.
 */
@Component({
  selector: 'gp-access-settings',
  imports: [FormsModule, TPipe, InputComponent, SelectComponent, ButtonComponent, DataGridComponent],
  templateUrl: './access-settings.component.html',
  styleUrl: './settings.css',
  host: { '(click)': 'onGridClick($event)' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AccessSettingsComponent {
  private readonly api = inject(ApiService);
  private readonly i18n = inject(I18nService);
  private readonly toast = inject(ToastService);
  private readonly serverList = inject(ServerListService);

  readonly mobileTpl = viewChild<TemplateRef<GridRowContext<GrantRow>>>('mobileRow');

  readonly grants = signal<GrantDto[]>([]);
  readonly loaded = signal(false);
  readonly email = signal('');
  readonly scope = signal('all');
  readonly inviting = signal(false);
  readonly error = signal<I18nKey | null>(null);
  readonly removing = signal<string | null>(null);

  private readonly texts = computed(() => {
    this.i18n.lang();
    return this.i18n;
  });
  readonly scopeOptions = computed<SelectOption<string>[]>(() => {
    const t = this.texts();
    const tags = new Set<string>();
    for (const s of this.serverList.servers()) if (s.role === 'owner') for (const tag of s.tags) tags.add(tag);
    return [{ value: 'all', label: t.t('allServers') }, ...[...tags].sort().map((tag) => ({ value: tag, label: tag }))];
  });
  readonly rows = computed(() => this.grants().map((g) => grantRow(g, this.texts().t('allServers'))));
  readonly rowId = (r: GrantRow) => r.id;
  readonly columns = computed<ColDef<GrantRow>[]>(() => {
    const t = this.texts();
    return [
      {
        field: 'email',
        colId: 'email',
        headerName: t.t('email'),
        flex: 2,
        minWidth: 200,
        cellRenderer: (p: { data?: GrantRow }) => (p.data ? `<span class="gp-initials">${escapeHtml(p.data.initials)}</span><span class="gp-cell-strong">${escapeHtml(p.data.email)}</span> <span class="gp-badge-reader">${escapeHtml(t.t('reader'))}</span>` : ''),
      },
      { field: 'scope', colId: 'scope', headerName: t.t('scope'), flex: 1, minWidth: 120, cellStyle: { color: 'var(--w-70)', fontSize: '11px' } },
      {
        field: 'status',
        colId: 'status',
        headerName: t.t('status'),
        width: 190,
        cellRenderer: (p: { data?: GrantRow }) => (p.data ? (p.data.pending ? `<span class="gp-cell-warn">${escapeHtml(t.t('pendingInvite'))}</span>` : `<span class="gp-cell-ok">${escapeHtml(t.t('accepted'))}</span>`) : ''),
        valueFormatter: (p) => (p.data?.pending ? t.t('pendingInvite') : t.t('accepted')),
      },
      {
        colId: 'actions',
        headerName: t.t('actionsCol'),
        width: 150,
        sortable: false,
        cellRenderer: (p: { data?: GrantRow }) => (p.data ? `<button type="button" class="gp-cell-btn danger" data-action="remove" data-id="${escapeHtml(p.data.id)}">${escapeHtml(t.t('removeAccess'))}</button>` : ''),
        valueFormatter: () => '',
      },
    ];
  });

  constructor() {
    void this.load();
    if (!this.serverList.loaded()) void this.serverList.load().catch(() => undefined);
  }

  private async load(): Promise<void> {
    try {
      this.grants.set(await this.api.get<GrantDto[]>('/access'));
    } catch (err) {
      console.warn('[access] could not load grants', err);
    } finally {
      this.loaded.set(true);
    }
  }

  /** Klikk i gridet (desktop): knappene er HTML-renderere, så handlingen leses av `data-action`. */
  onGridClick(e: Event): void {
    const btn = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-action="remove"]');
    if (btn?.dataset['id']) void this.remove(btn.dataset['id']);
  }

  async invite(): Promise<void> {
    const email = this.email().trim();
    if (!email || this.inviting()) return;
    this.inviting.set(true);
    this.error.set(null);
    try {
      const scope = this.scope() === 'all' ? 'all' : [this.scope()];
      const grant = await this.api.post<GrantDto>('/access', { email, scope });
      this.grants.update((gs) => [grant, ...gs]);
      this.email.set('');
      this.toast.show(this.i18n.t('inviteSent'));
    } catch (err) {
      this.error.set(err instanceof ApiError && err.status === 409 ? 'emailTaken' : err instanceof ApiError && err.errors?.['email'] ? 'invalidEmail' : errorKey(err));
    } finally {
      this.inviting.set(false);
    }
  }

  async remove(id: string): Promise<void> {
    if (this.removing()) return;
    this.removing.set(id);
    try {
      await this.api.delete<void>(`/access/${encodeURIComponent(id)}`);
      this.grants.update((gs) => gs.filter((g) => g.id !== id));
    } catch (err) {
      console.warn('[access] remove failed', err);
      this.toast.show(this.i18n.t('errorGeneric'));
    } finally {
      this.removing.set(null);
    }
  }
}
