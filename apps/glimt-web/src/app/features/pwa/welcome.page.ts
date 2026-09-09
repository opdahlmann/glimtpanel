import { ChangeDetectionStrategy, Component } from '@angular/core';

/** Plassholder. Bygges i steg 7.5. */
@Component({
  selector: 'gp-welcome-page',
  template: `<h1>Get alerts on your phone</h1>`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WelcomePage {}
