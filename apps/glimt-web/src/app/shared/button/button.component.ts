import { ChangeDetectionStrategy, Component, input } from '@angular/core';

export type ButtonVariant = 'primary' | 'ghost' | 'danger';
export type ButtonSize = 'lg' | 'md' | 'sm';

/**
 * Knapper (6.3): primær hvit pille med `--glow-primary` og hover-løft, ghost med kant `--s-14`, destruktiv i `--color-crit`.
 * `size` gir min-height 44/40/32. `icon` er en SVG-path (`d`) tegnet 16 px med strek 2,2. Klikk bobler til verten.
 */
@Component({
  selector: 'gp-button',
  templateUrl: './button.component.html',
  styleUrl: './button.component.css',
  host: { '[class]': 'variant() + " " + size()', '[class.block]': 'block()' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ButtonComponent {
  readonly variant = input<ButtonVariant>('ghost');
  readonly size = input<ButtonSize>('md');
  readonly icon = input<string | null>(null);
  readonly type = input<'button' | 'submit' | 'reset'>('button');
  readonly disabled = input(false);
  readonly loading = input(false);
  readonly block = input(false);
  readonly label = input('');
}
