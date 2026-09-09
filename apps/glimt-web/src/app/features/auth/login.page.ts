import { ChangeDetectionStrategy, Component } from '@angular/core';

/** Plassholder. Bygges i steg 3.6. */
@Component({
  selector: 'gp-login-page',
  template: `<h1>Sign in</h1>`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LoginPage {}
