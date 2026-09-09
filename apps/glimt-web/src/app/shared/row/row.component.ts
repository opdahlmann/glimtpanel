import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

/**
 * Rad for disk, container, tjeneste, varsel, port, invitasjon (6.3): `--s-5`, radius 9, `padding 9px 10px`,
 * hårlinje, min. 44 px, `flex-wrap: wrap`. `interactive` gjør raden til en knapp som sender `pressed`.
 */
@Component({
  selector: 'gp-row',
  imports: [NgTemplateOutlet],
  templateUrl: './row.component.html',
  styleUrl: './row.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RowComponent {
  readonly clickable = input(false);
  readonly interactive = input(false);
  /** Farge på en 3 px stripe til venstre (f.eks. feilet tjeneste). */
  readonly stripe = input<string | null>(null);
  readonly pressed = output<void>();
}
