import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { Router } from '@angular/router';
import { I18nService } from '@core/i18n.service';
import { TPipe } from '@core/t.pipe';
import { SegmentComponent, SegmentOption } from '@shared/segment/segment.component';
import { TitleService } from '../../shell/title.service';
import { AlertSettingsComponent } from './alert-settings.component';

export const SETTINGS_TABS = ['account', 'alerts', 'servers', 'access', 'subscription', 'data'] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

/**
 * Innstillingsskallet (skjerm 9–13): fanesegmentet som ruller, og fanens innhold. Fase 7 fyller «Alerts» (steg 7.4);
 * de andre fanene kommer i fase 8 og viser til da bare en linje. `?server=` på Alerts gir per-server-visningen.
 */
@Component({
  selector: 'gp-settings-page',
  imports: [TPipe, SegmentComponent, AlertSettingsComponent],
  template: `
    <div class="page">
      <h1 class="title">{{ 'settings' | t }}</h1>
      <gp-segment [options]="tabOptions()" [value]="current()" (valueChange)="goTab($event)" [scroll]="true" [label]="'settings' | t" />
      @switch (current()) {
        @case ('alerts') {
          <gp-alert-settings [server]="server()" />
        }
        @default {
          <p class="soon" data-testid="settings-soon">{{ current() | t }} · {{ 'notYet' | t }}</p>
        }
      }
    </div>
  `,
  styles: `
    :host { display: block; }
    .page { max-width: var(--page-max); display: flex; flex-direction: column; gap: 14px; }
    .title { margin: 0; font-size: 20px; font-weight: 700; letter-spacing: -.025em; }
    .soon { margin: 0; padding: 24px 12px; font-size: 12px; color: var(--w-45); text-align: center; background: var(--s-4); border-radius: var(--radius-card); box-shadow: var(--hairline-card); }
    @media (max-width: 759.98px) { gp-segment { margin: 0 -12px; padding: 0 12px; } }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SettingsPage {
  /** Fra ruten `settings/:tab` og `?server=` (withComponentInputBinding). */
  readonly tab = input<string>('account');
  readonly server = input<string | undefined>();

  private readonly i18n = inject(I18nService);
  private readonly router = inject(Router);

  /** Ukjent fane → Account. Fanenavnene er også ordboksnøkler. */
  readonly current = computed<SettingsTab>(() => ((SETTINGS_TABS as readonly string[]).includes(this.tab()) ? (this.tab() as SettingsTab) : 'account'));
  readonly tabOptions = computed<SegmentOption<SettingsTab>[]>(() => {
    this.i18n.lang();
    return SETTINGS_TABS.map((t) => ({ value: t, label: this.i18n.t(t) }));
  });

  constructor() {
    inject(TitleService).setKey('settings');
  }

  goTab(tab: SettingsTab | null): void {
    if (tab && tab !== this.current()) void this.router.navigate(['/settings', tab]);
  }
}
