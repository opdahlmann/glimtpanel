import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { AlertStore } from '@core/alert.store';
import { AlertsService } from '@core/alerts.service';
import { I18nKey, I18nService } from '@core/i18n.service';
import { AlertDto, AlertSettingsDto, RuleInfoDto, SilenceChoice } from '@core/live.types';
import { ServerListService } from '@core/server-list.service';
import { SessionService } from '@core/session.service';
import { TPipe } from '@core/t.pipe';
import { BadgeComponent } from '@shared/badge/badge.component';
import { ButtonComponent } from '@shared/button/button.component';
import { SegmentComponent, SegmentOption } from '@shared/segment/segment.component';
import { ToastService } from '@shared/toast/toast.service';
import { TitleService } from '../../shell/title.service';
import { ALERT_FILTERS, AlertFilter, alertColor, alertLink, filterAlerts, orderRules, ruleDefaultText, ruleNameKey, severityColor, severityKey } from './alerts.model';

/** Én rad ferdig utledet for malen. */
export interface AlertRow {
  alert: AlertDto;
  color: string;
  ruleKey: I18nKey;
  /** «08:11», «yesterday 23:10», «Sep 7 14:20» i brukerens tidssone. */
  when: string;
  resolvedAt: string | null;
  canSilence: boolean;
}

/**
 * Varselsiden (steg 7.3, skjerm 8 og 17): sammendrag «5 active · 3 resolved», segment Active / Resolved / All, rader
 * med prikk, server (lenke), regel + detalj (lenke til panelet eller loggene), badges «silenced»/«Resolved 02:15»,
 * tidspunkt, og «Silence» for eiere med tre valg som glir inn under raden. Tom-tilstanden er grønn. Under står de sju
 * reglene med navn, standard (fra `GET /api/alert-settings`, så justerte terskler vises) og alvor. Levende via AlertStore.
 */
@Component({
  selector: 'gp-alerts-page',
  imports: [TPipe, BadgeComponent, ButtonComponent, SegmentComponent],
  templateUrl: './alerts.page.html',
  styleUrl: './alerts.page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AlertsPage {
  readonly store = inject(AlertStore);
  private readonly alertsApi = inject(AlertsService);
  private readonly i18n = inject(I18nService);
  private readonly session = inject(SessionService);
  private readonly serverList = inject(ServerListService);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);

  readonly filter = signal<AlertFilter>('active');
  /** Raden hvis stille-valg er åpne. */
  readonly silencing = signal<string | null>(null);
  readonly busy = signal<string | null>(null);
  private readonly settings = signal<AlertSettingsDto | null>(null);

  private readonly texts = computed(() => {
    this.i18n.lang();
    this.i18n.timeZone();
    return this.i18n;
  });

  readonly filterOptions = computed<SegmentOption<AlertFilter>[]>(() => ALERT_FILTERS.map((f) => ({ value: f, label: this.texts().t(f === 'active' ? 'activeAlerts' : f === 'resolved' ? 'resolved' : 'all') })));
  readonly summary = computed(() => {
    const t = this.texts();
    return `${this.store.activeCount()} ${t.t('active')} · ${this.store.resolved().length} ${t.t('resolved').toLowerCase()}`;
  });
  readonly rows = computed<AlertRow[]>(() => {
    const t = this.texts();
    const now = Date.now();
    return filterAlerts(this.store.alerts(), this.filter()).map((alert) => ({
      alert,
      color: alertColor(alert),
      ruleKey: ruleNameKey(alert.rule),
      when: t.formatWhen(Date.parse(alert.firedAt), now),
      resolvedAt: alert.resolvedAt ? t.formatTimeShort(Date.parse(alert.resolvedAt)) : null,
      canSilence: alert.state === 'firing' && !alert.silenced && this.session.isOwnerOf(alert.serverId),
    }));
  });
  readonly noActive = computed(() => this.store.loaded() && this.store.activeCount() === 0);
  readonly emptyList = computed(() => this.store.loaded() && this.rows().length === 0);

  readonly rules = computed(() => {
    const t = this.texts();
    const list = this.settings()?.rules ?? [];
    return orderRules(list).map((rule: RuleInfoDto) => ({
      id: rule.id,
      nameKey: ruleNameKey(rule.id),
      text: ruleDefaultText(rule, (k) => t.t(k), t.t('min')),
      severityKey: severityKey(rule.severity),
      color: severityColor(rule.severity),
      enabled: rule.enabled,
    }));
  });
  readonly digestText = computed(() => {
    const t = this.texts();
    const time = this.settings()?.digest.time ?? '08:00';
    return `${t.t('digestPre')} ${time}`;
  });
  readonly digestOff = computed(() => this.settings()?.digest.enabled === false);

  readonly silenceChoices: { value: SilenceChoice; key: I18nKey }[] = [
    { value: '1h', key: 'oneHour' },
    { value: 'tomorrow', key: 'tomorrow' },
    { value: 'monday', key: 'monday' },
  ];

  constructor() {
    inject(TitleService).setKey('alerts');
    void this.store.load();
    // Rollekartet (eier → «Silence») fylles av GET /api/servers; siden kan være første stopp etter innlogging.
    if (!this.serverList.loaded()) void this.serverList.load().catch((err: unknown) => console.warn('[alerts] could not load the server list', err));
    void this.alertsApi
      .getSettings()
      .then((s) => this.settings.set(s))
      .catch((err: unknown) => console.warn('[alerts] could not load alert settings', err));
  }

  setFilter(v: AlertFilter | null): void {
    if (v) this.filter.set(v);
  }

  openServer(alert: AlertDto): void {
    void this.router.navigate(['/servers', alert.serverId]);
  }

  openRule(alert: AlertDto): void {
    const link = alertLink(alert);
    void this.router.navigate(link.path, { queryParams: link.query, fragment: link.fragment });
  }

  toggleSilence(alert: AlertDto): void {
    this.silencing.update((id) => (id === alert.id ? null : alert.id));
  }

  async silence(alert: AlertDto, until: SilenceChoice): Promise<void> {
    if (this.busy()) return;
    this.busy.set(alert.id);
    try {
      await this.alertsApi.silence(alert.serverId, until);
      this.silencing.set(null);
      this.toast.show(`${alert.serverName} · ${this.i18n.t('silenced')}`);
    } catch (err) {
      console.warn('[alerts] silence failed', err);
      this.toast.show(this.i18n.t('errorGeneric'));
    } finally {
      this.busy.set(null);
    }
  }
}
