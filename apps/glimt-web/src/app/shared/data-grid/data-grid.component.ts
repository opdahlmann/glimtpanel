import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  TemplateRef,
  Type,
  ViewEncapsulation,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { AgGridAngular, ICellRendererAngularComp } from 'ag-grid-angular';
import {
  AllCommunityModule,
  ColDef,
  GetQuickFilterTextParams,
  GetRowIdParams,
  GridOptions,
  IsFullWidthRowParams,
  ModuleRegistry,
  RowClickedEvent,
  themeQuartz,
} from 'ag-grid-community';
import { MOBILE_BREAKPOINT, observeWidth } from '../util/breakpoint.service';
import { ExpandedRow, GridContext, GridExpandedCellComponent, GridRowContext, GridStackedCellComponent, GridTemplateCellComponent, isExpandedRow } from './grid-renderers';

ModuleRegistry.registerModules([AllCommunityModule]);

/** Temaet fra IMPLEMENTERINGSPLAN 6.6, ordrett, pluss `autoHeightMinBodyHeight` så et tomt grid ikke reserverer 150 px. */
export const GP_GRID_THEME = themeQuartz.withParams({
  backgroundColor: 'transparent',
  foregroundColor: '#ffffffe6',
  headerBackgroundColor: 'transparent',
  headerTextColor: '#ffffff66',
  headerFontSize: 9.5,
  fontFamily: 'Inter',
  fontSize: 12,
  rowHeight: 44,
  headerHeight: 28,
  borderColor: 'transparent',
  rowHoverColor: '#ffffff17',
  selectedRowBackgroundColor: '#ffffff17',
  wrapperBorder: false,
  columnBorder: false,
  rowBorder: false,
  cellHorizontalPadding: 10,
  accentColor: '#0a84ff',
  autoHeightMinBodyHeight: 64,
});

/** Mellomrommet mellom radene (tegnes som gjennomsiktig nedre kant på raden). */
export const GRID_ROW_GAP = 4;

export type RowRenderer<T> = Type<ICellRendererAngularComp> | TemplateRef<GridRowContext<T>>;
export type GridRow<T> = T | ExpandedRow<T>;

/** Hurtigfilterteksten for én rad: kolonnenes `getQuickFilterText`, ellers feltverdien. */
function quickFilterText<T>(columns: ColDef<T>[], p: GetQuickFilterTextParams<GridRow<T>>): string {
  const data = (isExpandedRow<T>(p.data) ? p.data.row : p.data) as T;
  return columns
    .map((c) => {
      const value = c.field ? (data as Record<string, unknown>)[c.field] : undefined;
      if (typeof c.getQuickFilterText === 'function') return c.getQuickFilterText({ ...p, data, colDef: c, value } as unknown as GetQuickFilterTextParams<T>);
      return value === null || value === undefined ? '' : String(value);
    })
    .join(' ');
}

/** Kolonnesettet for mobil: én kolonne med `flex: 1`, `autoHeight`, `wrapText` og stablet renderer (6.6). Hurtigfilteret ser de opprinnelige kolonnene. */
export function mobileColumnDefs<T>(columns: ColDef<T>[], renderer: RowRenderer<T> | null): ColDef<GridRow<T>>[] {
  const isTpl = renderer instanceof TemplateRef;
  return [
    {
      colId: '__gpMobile',
      headerName: '',
      flex: 1,
      autoHeight: true,
      wrapText: true,
      sortable: false,
      resizable: false,
      suppressMovable: true,
      getQuickFilterText: (p) => quickFilterText(columns, p),
      cellClass: 'gp-grid-mobile-cell',
      cellRenderer: renderer && !isTpl ? renderer : isTpl ? GridTemplateCellComponent : GridStackedCellComponent,
      cellRendererParams: isTpl ? { template: renderer } : { columns },
    },
  ];
}

/** Kolonnesettet for desktop med eventuell startsortering. `sort: null` på de andre, ellers beholder AG Grid forrige sortering som sekundær. */
export function desktopColumnDefs<T>(columns: ColDef<T>[], sortBy: string | null, sortDir: 'asc' | 'desc'): ColDef<GridRow<T>>[] {
  return columns.map((c) => {
    const id = c.colId ?? c.field;
    const sort = sortBy && id === sortBy ? sortDir : null;
    return { resizable: false, suppressMovable: true, ...c, ...(sortBy ? { sort } : {}) } as ColDef<GridRow<T>>;
  });
}

/**
 * AG Grid Community-innpakning (6.6). `domLayout: autoHeight`, ingen horisontal scroll, rader som `gp-row`.
 * Under `breakpoint` (760 px, målt på verten) byttes kolonnene til én stablet kolonne uten hode; `sortBy`/`sortDir` sorterer da radene.
 * `expandedRowRenderer` tegnes som en full-bredde-rad under raden som klikkes.
 */
@Component({
  selector: 'gp-data-grid',
  imports: [AgGridAngular],
  templateUrl: './data-grid.component.html',
  styleUrl: './data-grid.component.css',
  encapsulation: ViewEncapsulation.None,
  host: { class: 'gp-data-grid', '[class.mobile]': 'mobile()' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DataGridComponent<T> {
  readonly columns = input<ColDef<T>[]>([]);
  readonly rows = input<T[]>([]);
  readonly getRowId = input.required<(row: T) => string>();
  readonly mobileRenderer = input<RowRenderer<T> | null>(null);
  readonly filterText = input('');
  readonly sortBy = input<string | null>(null);
  readonly sortDir = input<'asc' | 'desc'>('desc');
  readonly expandedRowRenderer = input<RowRenderer<T> | null>(null);
  readonly emptyText = input('No rows');
  readonly label = input('');
  readonly rowPressed = output<T>();

  readonly theme = GP_GRID_THEME;
  /** Bredden (på verten) der gridet bytter til stablet modus. 760 som skallet; smalere for tabeller i en kolonne av to (portene i sikkerhetspanelet). */
  readonly breakpoint = input(MOBILE_BREAKPOINT);
  readonly expandedId = signal<string | null>(null);
  private readonly width = observeWidth(inject<ElementRef<HTMLElement>>(ElementRef).nativeElement, inject(DestroyRef));
  readonly mobile = computed(() => this.width() < this.breakpoint());

  readonly columnDefs = computed<ColDef<GridRow<T>>[]>(() =>
    this.mobile() ? mobileColumnDefs(this.columns(), this.mobileRenderer()) : desktopColumnDefs(this.columns(), this.sortBy(), this.sortDir()),
  );

  readonly rowData = computed<GridRow<T>[]>(() => {
    let rows = this.rows();
    const by = this.sortBy();
    if (this.mobile() && by) {
      const dir = this.sortDir() === 'asc' ? 1 : -1;
      const col = this.columns().find((c) => (c.colId ?? c.field) === by);
      const field = col?.field ?? by;
      rows = [...rows].sort((a, b) => {
        const va = (a as Record<string, unknown>)[field] as string | number;
        const vb = (b as Record<string, unknown>)[field] as string | number;
        return (va < vb ? -1 : va > vb ? 1 : 0) * dir;
      });
    }
    const exp = this.expandedId();
    if (!exp || !this.expandedRowRenderer()) return rows;
    const id = this.getRowId();
    const out: GridRow<T>[] = [];
    for (const r of rows) {
      out.push(r);
      if (id(r) === exp) out.push({ ...r, __gpExpanded: true, __gpId: `${exp}::expanded`, row: r });
    }
    return out;
  });

  readonly emptyHtml = computed(() => `<span class="gp-grid-empty">${escapeHtml(this.emptyText())}</span>`);

  readonly gridOptions: GridOptions<GridRow<T>> = {
    domLayout: 'autoHeight',
    suppressHorizontalScroll: true,
    rowHeight: 44 + GRID_ROW_GAP,
    animateRows: false,
    rowClass: 'gp-grid-row',
    loadThemeGoogleFonts: false,
    suppressDragLeaveHidesColumns: true,
    defaultColDef: { sortable: true, resizable: false, suppressMovable: true },
    getRowId: (p: GetRowIdParams<GridRow<T>>) => (isExpandedRow<T>(p.data) ? p.data.__gpId : this.getRowId()(p.data)),
    isFullWidthRow: (p: IsFullWidthRowParams<GridRow<T>>) => isExpandedRow(p.rowNode.data),
    fullWidthCellRenderer: GridExpandedCellComponent,
    context: { expandedRenderer: () => this.expandedRowRenderer() } satisfies GridContext<T>,
    onRowClicked: (e: RowClickedEvent<GridRow<T>>) => this.onRowClicked(e),
  };

  onRowClicked(e: RowClickedEvent<GridRow<T>>): void {
    const d = e.data;
    if (!d) return;
    if (isExpandedRow<T>(d)) {
      this.expandedId.set(null);
      return;
    }
    this.rowPressed.emit(d);
    if (!this.expandedRowRenderer()) return;
    const id = this.getRowId()(d);
    this.expandedId.set(this.expandedId() === id ? null : id);
  }
}

/** HTML-renderere (innstillingsgridene, steg 8.3–8.4) bygger streng-HTML; alt fra data escapes. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}
