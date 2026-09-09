import { ChangeDetectionStrategy, Component, input } from '@angular/core';

export type ChipTone = 'default' | 'warn' | 'crit' | 'swap' | 'ok' | 'muted';

/** Chips-raden i serverkortet og belastningschips (6.3): `--s-4`, radius 8, etikett 9,5 px over verdi 12 px 600. */
@Component({
  selector: 'gp-chip',
  template: `
    <span class="label">{{ label() }}</span>
    <span class="value num" [class]="'value num tone-' + tone()">
      @if (dot(); as d) {
        <span class="dot" [style.background]="d" aria-hidden="true"></span>
      }
      {{ value() }}<ng-content />
    </span>
  `,
  styles: `
    :host {
      display: flex; flex-direction: column; align-items: center; gap: 3px; min-width: 0;
      padding: 8px 4px; background: var(--s-4); border-radius: var(--radius-chip);
    }
    .label { font-size: 9.5px; color: var(--w-45); white-space: nowrap; }
    .value { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 600; color: var(--w-85); white-space: nowrap; }
    .tone-warn { color: var(--color-warn); }
    .tone-crit { color: var(--color-crit); }
    .tone-swap { color: var(--color-swap); }
    .tone-ok { color: var(--color-ram); }
    .tone-muted { color: var(--w-50); }
    .dot { width: 6px; height: 6px; border-radius: 50%; flex: none; }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChipComponent {
  readonly label = input('');
  readonly value = input<string | number>('');
  readonly tone = input<ChipTone>('default');
  readonly dot = input<string | null>(null);
}
