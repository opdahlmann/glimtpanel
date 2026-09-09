import { ChangeDetectionStrategy, Component } from '@angular/core';

/** Plassholder. Bygges i steg 5.13. */
@Component({
  selector: 'gp-container-page',
  template: `<h1>Container</h1>`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ContainerPage {}
