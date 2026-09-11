import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import type { ColDef } from 'ag-grid-community';
import { I18nService } from '@core/i18n.service';
import { ChipComponent } from '@shared/chip/chip.component';
import { DataGridComponent } from '@shared/data-grid/data-grid.component';
import { PortRow, SecurityView } from '../server-view';

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
}

/**
 * Sikkerhetspanelet (steg 5.11): porter i gp-data-grid (Port, Process, proto, «new»-badge), innloggede brukere,
 * feilede SSH-forsøk (to chips + tre siste i monospace) og brannmur (ufw, fail2ban). To kolonner på desktop, én på mobil.
 */
@Component({
  selector: 'gp-sec-panel',
  imports: [ChipComponent, DataGridComponent],
  template: `
    <div class="grid-2 data">
      <div class="col">
        <div class="sec-title">{{ i18n.t('ports') }}</div>
        <gp-data-grid [columns]="columns()" [rows]="view().ports" [getRowId]="portId" [breakpoint]="portsBreakpoint" [emptyText]="i18n.t('noPorts')" [label]="i18n.t('ports')" />
      </div>
      <div class="col">
        <div>
          <div class="sec-title">{{ i18n.t('loggedIn') }}</div>
          <div class="rows-tight">
            @for (u of view().users; track u) {
              <div class="user num">{{ u }}</div>
            } @empty {
              <div class="empty">{{ i18n.t('noLoggedIn') }}</div>
            }
          </div>
        </div>
        <div>
          <div class="sec-title">{{ i18n.t('sshFail') }}</div>
          <div class="chips-2">
            @for (c of view().sshChips; track c.label) {
              <gp-chip [label]="c.label" [value]="c.value" [tone]="c.tone" />
            }
          </div>
          @for (l of view().sshLast; track $index) {
            <div class="attempt mono num">{{ l }}</div>
          }
        </div>
        <div>
          <div class="sec-title">{{ i18n.t('firewall') }}</div>
          <div class="chips-2">
            @for (c of view().fwChips; track c.label) {
              <gp-chip [label]="c.label" [value]="c.value" [tone]="c.tone" />
            }
          </div>
        </div>
      </div>
    </div>
  `,
  styleUrls: ['./panels.css'],
  styles: `
    .user { background: var(--s-5); border-radius: var(--radius-row); padding: 8px 10px; box-shadow: var(--hairline-card); font-size: 11px; color: var(--w-90); }
    .attempt { font-size: 10.5px; color: var(--w-60); padding: 2px 4px; }
    .chips-2 { margin-bottom: 4px; }
  `,
  host: { '[class.dim]': 'dim()' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SecPanelComponent {
  readonly view = input.required<SecurityView>();
  readonly dim = input(false);
  readonly i18n = inject(I18nService);

  /** Portene står i en av to kolonner (min. 260 px): stablet først når kolonnen er smalere enn dette. */
  readonly portsBreakpoint = 300;
  readonly portId = (p: PortRow) => p.key;
  readonly columns = computed<ColDef<PortRow>[]>(() => {
    const cols: ColDef<PortRow>[] = [
    { field: 'port', colId: 'port', headerName: this.i18n.t('port'), width: 80, cellClass: 'num', cellStyle: { fontWeight: 600, color: 'var(--w-90)' } },
    {
      field: 'process',
      colId: 'process',
      headerName: this.i18n.t('process'),
      flex: 1,
      minWidth: 120,
      cellStyle: { color: 'var(--w-70)', fontSize: '11px' },
      cellRenderer: (p: { data?: PortRow }) => (p.data ? `${esc(p.data.process)}${p.data.isNew ? ` <span class="gp-badge-new">${esc(this.i18n.t('newBadge'))}</span>` : ''}` : ''),
      valueFormatter: (p) => `${p.data?.process ?? ''}${p.data?.isNew ? ` · ${this.i18n.t('newBadge')}` : ''}`,
    },
    { field: 'proto', colId: 'proto', headerName: 'Proto', width: 72, cellStyle: { color: 'var(--w-40)', fontSize: '10px' } },
    ];
    return cols;
  });
}
