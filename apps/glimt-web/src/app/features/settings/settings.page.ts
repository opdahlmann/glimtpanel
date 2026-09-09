import { ChangeDetectionStrategy, Component } from '@angular/core';

/** Plassholder. Bygges i steg 8.1. */
@Component({
  selector: 'gp-settings-page',
  template: `<h1>Settings</h1>`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SettingsPage {}
