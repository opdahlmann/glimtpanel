import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';

/** Plassholder til steg 3.3: sidepanel på desktop, topplinje + bunnlinje på mobil, bannere og toast. */
@Component({
  selector: 'gp-shell',
  imports: [RouterOutlet],
  template: `<router-outlet />`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ShellComponent {}
