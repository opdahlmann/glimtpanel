import { ChangeDetectionStrategy, Component } from '@angular/core';

/** Plassholder. Bygges i steg 3.6. */
@Component({
  selector: 'gp-forgot-page',
  template: `<h1>Forgot password</h1>`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ForgotPage {}
