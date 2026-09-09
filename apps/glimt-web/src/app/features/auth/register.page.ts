import { ChangeDetectionStrategy, Component } from '@angular/core';

/** Plassholder. Bygges i steg 3.6. */
@Component({
  selector: 'gp-register-page',
  template: `<h1>Create account</h1>`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RegisterPage {}
