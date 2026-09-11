import { ChangeDetectionStrategy, Component, computed, inject, input, signal, TemplateRef, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { ColDef } from 'ag-grid-community';
import { I18nService } from '@core/i18n.service';
import { ChipComponent } from '@shared/chip/chip.component';
import { DataGridComponent } from '@shared/data-grid/data-grid.component';
import { GridRowContext } from '@shared/data-grid/grid-renderers';
import { InputComponent } from '@shared/input/input.component';
import { SegmentComponent, SegmentOption } from '@shared/segment/segment.component';
import { formatDurationClock } from '@shared/util/format';
import { memSize, ProcessRow, ProcView } from '../server-view';

export type ProcSort = 'cpu' | 'mem';

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
}

/** Første kolonne: navn 12 px 600 og «bruker · pid» 10 px under (6.6). */
export function processNameCell(p: ProcessRow | undefined): string {
  if (!p) return '';
  return `<div class="gp-grid-stack"><div class="gp-grid-name">${esc(p.name)}</div><div class="gp-grid-sub">${esc(p.user)} · <span class="num">${p.pid}</span></div></div>`;
}

/**
 * Prosesspanelet (steg 5.7): segment By CPU / By memory, filter på navn eller bruker, AG Grid med Process, CPU
 * (oransje over 50 %), Memory og Time; klikk (Enter/Space) viser kommandolinjen som full-bredde-rad. Stablet på mobil.
 */
@Component({
  selector: 'gp-proc-panel',
  imports: [FormsModule, SegmentComponent, InputComponent, ChipComponent, DataGridComponent],
  template: `
    @if (down()) {
      <div class="empty">{{ i18n.t('notAvailableDown') }}</div>
    } @else {
      <div class="toolbar">
        <gp-segment size="sm" [options]="sortOptions()" [(value)]="sort" [label]="i18n.t('sort')" />
        <gp-input class="filter" size="sm" name="procFilter" autocomplete="off" [placeholder]="i18n.t('filterProc')" [ngModel]="filter()" (ngModelChange)="filter.set($event)" />
      </div>
      <gp-data-grid
        [columns]="columns()"
        [rows]="view().rows"
        [getRowId]="rowId"
        [filterText]="filter()"
        [sortBy]="sort()"
        sortDir="desc"
        [mobileRenderer]="mobileTpl() ?? null"
        [expandedRowRenderer]="expandedTpl() ?? null"
        [emptyText]="i18n.t('noProcesses')"
        [label]="i18n.t('processes')"
      />
      <ng-template #mobile let-p>
        <div class="mrow">
          <div class="name">{{ p.name }} <span class="sub">{{ p.user }} · <span class="num">{{ p.pid }}</span></span></div>
          <div class="chips-3">
            <gp-chip [label]="i18n.t('cpu')" [value]="cpu(p)" [tone]="p.cpu > 50 ? 'warn' : 'default'" />
            <gp-chip [label]="i18n.t('memory')" [value]="mem(p)" />
            <gp-chip [label]="i18n.t('time')" [value]="time(p)" />
          </div>
        </div>
      </ng-template>
      <ng-template #expanded let-p>
        <div class="expanded"><code class="cmd">{{ p.cmd || '—' }}</code></div>
      </ng-template>
    }
  `,
  styleUrls: ['./panels.css'],
  styles: `
    .toolbar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    .filter { flex: 1; min-width: 160px; }
    .mrow { display: flex; flex-direction: column; gap: 6px; width: 100%; padding: 8px 0 4px; }
    .expanded { padding: 6px 0; width: 100%; }
    .cmd { display: block; width: 100%; padding: 8px 10px; border-radius: 6px; background: var(--color-ink); font-family: var(--font-mono); font-size: 11px; color: var(--w-70); word-break: break-all; white-space: pre-wrap; }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProcPanelComponent {
  readonly view = input.required<ProcView>();
  readonly down = input(false);
  readonly i18n = inject(I18nService);

  readonly sort = signal<ProcSort | null>('cpu');
  readonly filter = signal('');
  readonly mobileTpl = viewChild<TemplateRef<GridRowContext<ProcessRow>>>('mobile');
  readonly expandedTpl = viewChild<TemplateRef<GridRowContext<ProcessRow>>>('expanded');

  readonly rowId = (p: ProcessRow) => String(p.pid);
  readonly sortOptions = computed<SegmentOption<ProcSort>[]>(() => [
    { value: 'cpu', label: this.i18n.t('sortCpu') },
    { value: 'mem', label: this.i18n.t('sortMem') },
  ]);

  readonly columns = computed<ColDef<ProcessRow>[]>(() => {
    const cols: ColDef<ProcessRow>[] = [
    { field: 'name', colId: 'name', headerName: this.i18n.t('process'), flex: 1, minWidth: 140, cellRenderer: (p: { data?: ProcessRow }) => processNameCell(p.data), getQuickFilterText: (p) => `${p.data?.name ?? ''} ${p.data?.user ?? ''}` },
    { field: 'cpu', colId: 'cpu', headerName: this.i18n.t('cpu'), width: 72, cellClass: 'num', headerClass: 'num', valueFormatter: (p) => `${(p.value as number).toFixed(1)}%`, cellStyle: (p) => ({ color: (p.value as number) > 50 ? 'var(--color-warn)' : 'var(--w-85)', fontWeight: 600 }), getQuickFilterText: () => '' },
    { field: 'mem', colId: 'mem', headerName: this.i18n.t('memory'), width: 90, cellClass: 'num', headerClass: 'num', valueFormatter: (p) => memSize(p.value as number), cellStyle: { fontWeight: 600, color: 'var(--w-85)' }, getQuickFilterText: () => '' },
    { field: 'time', colId: 'time', headerName: this.i18n.t('time'), width: 94, cellClass: 'num', headerClass: 'num', valueFormatter: (p) => (p.value === null ? '—' : formatDurationClock(p.value as number)), cellStyle: { fontSize: '11px', color: 'var(--w-60)' }, getQuickFilterText: () => '' },
    ];
    return cols;
  });

  cpu(p: ProcessRow): string {
    return `${p.cpu.toFixed(1)}%`;
  }
  mem(p: ProcessRow): string {
    return memSize(p.mem);
  }
  time(p: ProcessRow): string {
    return p.time === null ? '—' : formatDurationClock(p.time);
  }
}
