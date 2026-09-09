import { ChangeDetectionStrategy, Component } from '@angular/core';

/** Plassholder. Bygges i steg 3.5. */
@Component({
  selector: 'gp-components-page',
  template: `<h1>Components</h1>`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ComponentsPage {}
