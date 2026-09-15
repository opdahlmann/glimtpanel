import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { Router } from '@angular/router';
import { I18nService } from '@core/i18n.service';
import { TPipe } from '@core/t.pipe';
import { SegmentComponent, SegmentOption } from '@shared/segment/segment.component';
import { TitleService } from '../../shell/title.service';
import { SessionService } from '@core/session.service';
import { AccessSettingsComponent } from './access-settings.component';
import { AccountSettingsComponent } from './account-settings.component';
import { AlertSettingsComponent } from './alert-settings.component';
import { DataSettingsComponent } from './data-settings.component';
import { ServersSettingsComponent } from './servers-settings.component';
import { SubscriptionSettingsComponent } from './subscription-settings.component';

export const SETTINGS_TABS = ['account', 'alerts', 'servers', 'access', 'subscription', 'data'] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

/**
 * Innstillingsskallet (steg 8.1, skjerm 9–13): fanesegmentet som ruller, og fanens innhold i grid (`auto-fit minmax(300px, 1fr)`,
 * én kolonne på mobil, `pdIn` ved fanebytte). Servers, Access og Subscription krever eier av minst én node; lesere
 * får en forklaring i stedet. `?server=` på Alerts gir per-server-visningen. I demoen (steg 10.1) finnes bare
 * kontofanen, i visningsmodus.
 */
@Component({
  selector: 'gp-settings-page',
  imports: [TPipe, SegmentComponent, AlertSettingsComponent, AccountSettingsComponent, ServersSettingsComponent, AccessSettingsComponent, SubscriptionSettingsComponent, DataSettingsComponent],
  template: `
    <div class="page">
      <h1 class="title">{{ 'settings' | t }}</h1>
      @if (!demo()) {
        <gp-segment [options]="tabOptions()" [value]="current()" (valueChange)="goTab($event)" [scroll]="true" [label]="'settings' | t" />
      }
      @switch (current()) {
        @case ('account') {
          <gp-account-settings />
        }
        @case ('alerts') {
          <gp-alert-settings [server]="server()" />
        }
        @case ('servers') {
          @if (ownerTabs()) {
            <gp-servers-settings />
          } @else {
            <p class="soon" data-testid="owners-only">{{ 'ownersOnly' | t }} · {{ 'readerTabHint' | t }}</p>
          }
        }
        @case ('access') {
          @if (ownerTabs()) {
            <gp-access-settings />
          } @else {
            <p class="soon" data-testid="owners-only">{{ 'ownersOnly' | t }} · {{ 'readerTabHint' | t }}</p>
          }
        }
        @case ('subscription') {
          @if (ownerTabs()) {
            <gp-subscription-settings />
          } @else {
            <p class="soon" data-testid="owners-only">{{ 'ownersOnly' | t }} · {{ 'readerTabHint' | t }}</p>
          }
        }
        @case ('data') {
          <gp-data-settings />
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
  private readonly session = inject(SessionService);

  /** Servers, Access og Subscription: eier av minst én node, eller en konto uten noder (som skal legge til sin første). */
  readonly ownerTabs = computed(() => this.session.ownsAnyServer() || !(this.session.user()?.readerOf ?? 0));

  readonly demo = this.session.demoMode;
  /** Ukjent fane → Account. Fanenavnene er også ordboksnøkler. Demoen har bare Account. */
  readonly current = computed<SettingsTab>(() => (!this.demo() && (SETTINGS_TABS as readonly string[]).includes(this.tab()) ? (this.tab() as SettingsTab) : 'account'));
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
