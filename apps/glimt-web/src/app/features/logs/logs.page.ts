import { ChangeDetectionStrategy, Component } from '@angular/core';

/** Plassholder. Bygges i steg 6.1. */
@Component({
  selector: 'gp-logs-page',
  template: `<h1>Logs</h1>`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LogsPage {}
