import { ChangeDetectionStrategy, Component, input } from '@angular/core';

export type BadgeTone = 'default' | 'new' | 'warn' | 'crit' | 'ok';

/** Tagger, filsystem, «new», «needs restart», EOL, «Reader», «resolved» (6.3): 9 px 600 versaler, radius 4. */
@Component({
  selector: 'gp-badge',
  template: `<ng-content />`,
  host: { '[class]': '"tone-" + tone()' },
  styles: `
    :host {
      display: inline-block; padding: 2px 5px; border-radius: var(--radius-badge);
      font-size: 9px; font-weight: 600; letter-spacing: .03em; text-transform: uppercase; line-height: 1.3; white-space: nowrap;
      background: var(--s-8); color: var(--w-50);
    }
    :host(.tone-new) { color: var(--color-disk); background: color-mix(in srgb, var(--color-disk) 12%, transparent); }
    :host(.tone-warn) { color: var(--color-warn); background: color-mix(in srgb, var(--color-warn) 12%, transparent); }
    :host(.tone-crit) { color: var(--color-crit); background: color-mix(in srgb, var(--color-crit) 12%, transparent); }
    :host(.tone-ok) { color: var(--color-ram); background: color-mix(in srgb, var(--color-ram) 12%, transparent); }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BadgeComponent {
  readonly tone = input<BadgeTone>('default');
}
