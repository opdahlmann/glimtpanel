import { ChangeDetectionStrategy, Component } from '@angular/core';

/** Plassholder. Bygges i steg 5.1. */
@Component({
  selector: 'gp-server-page',
  template: `<h1>Server</h1>`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ServerPage {}
