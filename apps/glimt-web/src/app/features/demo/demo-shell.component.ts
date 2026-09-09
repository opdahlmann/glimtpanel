import { ChangeDetectionStrategy, Component } from '@angular/core';

/** Plassholder. Bygges i steg 10.1. */
@Component({
  selector: 'gp-demo-shell',
  template: `<h1>Demo</h1>`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DemoShell {}
