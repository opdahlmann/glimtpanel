import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, TemplateRef, Type, ViewContainerRef, inject, signal } from '@angular/core';
import type { ICellRendererAngularComp } from 'ag-grid-angular';
import type { ColDef, ICellRendererParams, ValueFormatterParams } from 'ag-grid-community';
import { ChipComponent } from '../chip/chip.component';

/** Syntetisk rad som legges under den valgte raden og tegnes i full bredde (Community `isFullWidthRow`). */
/** Bærer også forelderens felter slik at kolonnesortering og hurtigfilter holder den rett under forelderen. */
export type ExpandedRow<T> = T & {
  __gpExpanded: true;
  __gpId: string;
  row: T;
};

export function isExpandedRow<T>(data: unknown): data is ExpandedRow<T> {
  return !!data && typeof data === 'object' && (data as ExpandedRow<T>).__gpExpanded === true;
}

/** Kontekst for mal-baserte renderere: `let-row` er raddataene, `expanded` om raden er utvidet. */
export interface GridRowContext<T> {
  $implicit: T;
  expanded: boolean;
}

export interface GridTemplateParams<T> extends ICellRendererParams<T | ExpandedRow<T>> {
  template: TemplateRef<GridRowContext<T>>;
  expanded?: boolean;
}

/** Tegner en `ng-template` med raden som `$implicit`. Brukes for `mobileRenderer` og `expandedRowRenderer` gitt som TemplateRef. */
@Component({
  selector: 'gp-grid-template-cell',
  imports: [NgTemplateOutlet],
  template: `<ng-container *ngTemplateOutlet="tpl(); context: ctx()" />`,
  styles: `:host { display: block; min-width: 0; width: 100%; }`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GridTemplateCellComponent<T> implements ICellRendererAngularComp {
  readonly tpl = signal<TemplateRef<GridRowContext<T>> | null>(null);
  readonly ctx = signal<GridRowContext<T> | null>(null);

  agInit(params: GridTemplateParams<T>): void {
    this.tpl.set(params.template);
    const d = params.data;
    const row = isExpandedRow<T>(d) ? d.row : (d as T);
    this.ctx.set({ $implicit: row, expanded: !!params.expanded });
  }
  refresh(params: GridTemplateParams<T>): boolean {
    this.agInit(params);
    return true;
  }
}

export interface GridStackedParams<T> extends ICellRendererParams<T> {
  columns: ColDef<T>[];
}

interface StackedChip {
  label: string;
  value: string;
}

/**
 * Standard mobilrenderer (6.6): første kolonne som navn øverst, resten som `gp-chip` under.
 * Bruker `field`/`valueGetter` og `valueFormatter` fra kolonnedefinisjonene.
 */
@Component({
  selector: 'gp-grid-stacked-cell',
  imports: [ChipComponent],
  template: `
    <div class="name">{{ name() }}</div>
    @if (chips().length) {
      <div class="chips">
        @for (c of chips(); track c.label) {
          <gp-chip [label]="c.label" [value]="c.value" />
        }
      </div>
    }
  `,
  styles: `
    :host { display: flex; flex-direction: column; gap: 6px; width: 100%; min-width: 0; padding: 8px 0; line-height: 1.3; }
    .name { font-size: 12px; font-weight: 600; color: var(--w-90); white-space: normal; overflow-wrap: anywhere; }
    .chips { display: grid; grid-template-columns: repeat(auto-fill, minmax(72px, 1fr)); gap: 4px; }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GridStackedCellComponent<T> implements ICellRendererAngularComp {
  readonly name = signal('');
  readonly chips = signal<StackedChip[]>([]);

  agInit(params: GridStackedParams<T>): void {
    const cols = params.columns ?? [];
    const data = params.data as T | undefined;
    const values = cols.map((c) => ({ label: String(c.headerName ?? c.field ?? ''), value: cellText(c, data, params) }));
    this.name.set(values[0]?.value ?? '');
    this.chips.set(values.slice(1));
  }
  refresh(params: GridStackedParams<T>): boolean {
    this.agInit(params);
    return true;
  }
}

function cellText<T>(col: ColDef<T>, data: T | undefined, params: ICellRendererParams<T>): string {
  let value: unknown = undefined;
  if (data) {
    if (typeof col.valueGetter === 'function') {
      value = col.valueGetter({ ...params, data, colDef: col, getValue: () => undefined } as never);
    } else if (col.field) {
      value = (data as Record<string, unknown>)[col.field];
    }
  }
  if (typeof col.valueFormatter === 'function') {
    return String(col.valueFormatter({ ...params, data, colDef: col, value } as unknown as ValueFormatterParams<T>) ?? '');
  }
  return value === null || value === undefined ? '' : String(value);
}

/** Det gridet legger i `context` slik at full-bredde-rendereren finner `expandedRowRenderer` uten å binde parametre. */
export interface GridContext<T> {
  expandedRenderer: () => Type<ICellRendererAngularComp> | TemplateRef<GridRowContext<T>> | null;
}

/**
 * Full-bredde-rad (utvidet kommandolinje o.l.). Tegner `expandedRowRenderer` fra `params.context`,
 * enten som mal (`ng-template`) eller som komponent (`agInit` kalles med de samme parametrene).
 */
@Component({
  selector: 'gp-grid-expanded-cell',
  imports: [NgTemplateOutlet],
  template: `@if (tpl(); as t) {<ng-container *ngTemplateOutlet="t; context: ctx()" />}`,
  styles: `:host { display: block; min-width: 0; width: 100%; }`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GridExpandedCellComponent<T> implements ICellRendererAngularComp {
  private readonly vcr = inject(ViewContainerRef);
  readonly tpl = signal<TemplateRef<GridRowContext<T>> | null>(null);
  readonly ctx = signal<GridRowContext<T> | null>(null);
  private child: ICellRendererAngularComp | null = null;

  agInit(params: ICellRendererParams<ExpandedRow<T>, unknown, GridContext<T>>): void {
    const r = params.context?.expandedRenderer?.() ?? null;
    const row = params.data?.row as T;
    if (r instanceof TemplateRef) {
      this.tpl.set(r);
      this.ctx.set({ $implicit: row, expanded: true });
      return;
    }
    this.tpl.set(null);
    if (r) {
      this.vcr.clear();
      this.child = this.vcr.createComponent(r).instance;
      this.child.agInit(params);
    }
  }
  refresh(params: ICellRendererParams<ExpandedRow<T>, unknown, GridContext<T>>): boolean {
    if (this.child) return this.child.refresh(params);
    this.agInit(params);
    return true;
  }
}
