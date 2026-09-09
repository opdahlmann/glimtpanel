import { ChangeDetectionStrategy, Component } from '@angular/core';

/** Plassholder. Bygges i steg 3.6. */
@Component({
  selector: 'gp-confirm-page',
  template: `<h1>Confirming…</h1>`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConfirmPage {}
