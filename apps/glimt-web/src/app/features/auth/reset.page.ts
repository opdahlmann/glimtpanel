import { ChangeDetectionStrategy, Component } from '@angular/core';

/** Plassholder. Bygges i steg 3.6. */
@Component({
  selector: 'gp-reset-page',
  template: `<h1>Reset password</h1>`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ResetPage {}
