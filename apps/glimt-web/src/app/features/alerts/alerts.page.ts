import { ChangeDetectionStrategy, Component } from '@angular/core';

/** Plassholder. Bygges i steg 7.3. */
@Component({
  selector: 'gp-alerts-page',
  template: `<h1>Alerts</h1>`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AlertsPage {}
