import { Component, viewChild } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ColDef } from 'ag-grid-community';
import { DataGridComponent, desktopColumnDefs, mobileColumnDefs } from './data-grid.component';
import { GridStackedCellComponent, GridTemplateCellComponent } from './grid-renderers';

interface Row {
  id: string;
  name: string;
  cpu: number;
}

const columns: ColDef<Row>[] = [
  { field: 'name', headerName: 'Process', flex: 1 },
  { field: 'cpu', headerName: 'CPU', width: 60 },
];

/** ResizeObserver-mock som lar testen utløse en bredde. */
class RO {
  static byElement = new Map<Element, RO>();
  constructor(private readonly cb: ResizeObserverCallback) {}
  observe(el: Element): void {
    RO.byElement.set(el, this);
  }
  disconnect(): void {
    /* noop */
  }
  unobserve(): void {
    /* noop */
  }
  fire(width: number): void {
    this.cb([{ contentRect: { width } } as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
}

@Component({
  imports: [DataGridComponent],
  template: `
    <gp-data-grid [columns]="columns" [rows]="rows" [getRowId]="id" sortBy="cpu" sortDir="asc" [mobileRenderer]="tpl" />
    <ng-template #tpl let-r><span class="m">{{ r.name }}</span></ng-template>
  `,
})
class HostComponent {
  readonly columns = columns;
  readonly rows: Row[] = [
    { id: 'a', name: 'node', cpu: 38 },
    { id: 'b', name: 'nginx', cpu: 3 },
  ];
  readonly id = (r: Row) => r.id;
  readonly grid = viewChild.required(DataGridComponent<Row>);
}

describe('gp-data-grid', () => {
  const original = globalThis.ResizeObserver;
  beforeEach(() => {
    RO.byElement.clear();
    (globalThis as { ResizeObserver: unknown }).ResizeObserver = RO;
  });
  afterEach(() => {
    (globalThis as { ResizeObserver: unknown }).ResizeObserver = original;
  });

  it('builds the mobile column set as one flex/autoHeight/wrapText column with the given renderer', () => {
    const tplCols = mobileColumnDefs(columns, null);
    expect(tplCols.length).toBe(1);
    expect(tplCols[0]).toMatchObject({ flex: 1, autoHeight: true, wrapText: true, sortable: false });
    expect(tplCols[0].cellRenderer).toBe(GridStackedCellComponent);
    expect(mobileColumnDefs(columns, null)[0].cellRendererParams).toEqual({ columns });
    expect(mobileColumnDefs(columns, GridTemplateCellComponent)[0].cellRenderer).toBe(GridTemplateCellComponent);
    const desk = desktopColumnDefs(columns, 'cpu', 'desc');
    expect(desk.length).toBe(2);
    expect(desk[1].sort).toBe('desc');
    expect(desk[0].sort).toBeUndefined();
  });

  it('switches to the mobile column set and sorted rows when the host element is narrower than 760', async () => {
    const fixture = TestBed.createComponent(HostComponent);
    await fixture.whenStable();
    const grid = fixture.componentInstance.grid();
    const host = fixture.nativeElement.querySelector('gp-data-grid') as HTMLElement;
    const ro = RO.byElement.get(host);
    expect(ro).toBeDefined();
    if (!ro) return;

    ro.fire(1200);
    await fixture.whenStable();
    expect(grid.mobile()).toBe(false);
    expect(grid.columnDefs().length).toBe(2);
    expect(grid.rowData().map((r) => (r as Row).id)).toEqual(['a', 'b']);

    ro.fire(500);
    await fixture.whenStable();
    expect(grid.mobile()).toBe(true);
    expect(host.classList.contains('mobile')).toBe(true);
    const cols = grid.columnDefs();
    expect(cols.length).toBe(1);
    expect(cols[0]).toMatchObject({ flex: 1, autoHeight: true, wrapText: true });
    expect(cols[0].cellRenderer).toBe(GridTemplateCellComponent);
    expect(grid.rowData().map((r) => (r as Row).id)).toEqual(['b', 'a']);
    expect(grid.emptyHtml()).toContain('No rows');
  });
});
