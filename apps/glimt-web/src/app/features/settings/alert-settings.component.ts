import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AlertsService } from '@core/alerts.service';
import { ClipboardService } from '@core/clipboard.service';
import { I18nKey, I18nService } from '@core/i18n.service';
import { AlertRuleId, AlertSettingsDto, RuleInfoDto, RuleSettingDto, ServerAlertSettingsDto } from '@core/live.types';
import { PushService } from '@core/push.service';
import { TPipe } from '@core/t.pipe';
import { BadgeComponent } from '@shared/badge/badge.component';
import { ButtonComponent } from '@shared/button/button.component';
import { InputComponent } from '@shared/input/input.component';
import { ToastService } from '@shared/toast/toast.service';
import { ToggleComponent } from '@shared/toggle/toggle.component';
import { AutofocusDirective } from '@shared/util/autofocus.directive';
import { orderRules, ruleDefaultText, ruleNameKey, severityColor, severityKey } from '../alerts/alerts.model';

/** Redigerbar kopi av én regel: bryter, terskel (prosent/antall) og minutter. */
export interface RuleDraft {
  id: AlertRuleId;
  enabled: boolean;
  threshold: number | null;
  minutes: number | null;
}

export interface ChannelsDraft {
  push: boolean;
  email: boolean;
  webhookUrl: string;
  digestEnabled: boolean;
  digestTime: string;
}

/** Endringer i `draft` mot `loaded` som hubens `rules`-kart: bare feltene som avviker fra det som er lagret. */
export function ruleChanges(loaded: RuleInfoDto[], draft: RuleDraft[]): Record<string, RuleSettingDto> {
  const out: Record<string, RuleSettingDto> = {};
  for (const rule of loaded) {
    const d = draft.find((x) => x.id === rule.id);
    if (!d) continue;
    const entry: RuleSettingDto = {};
    if (d.enabled !== rule.enabled) entry.enabled = d.enabled;
    if (rule.defaultThreshold !== null && d.threshold !== null && d.threshold !== rule.threshold) entry.threshold = d.threshold;
    const seconds = d.minutes === null ? null : Math.round(d.minutes * 60);
    if (rule.defaultDurationSec !== null && seconds !== null && seconds !== rule.durationSec) entry.durationSec = seconds;
    if (Object.keys(entry).length > 0) out[rule.id] = entry;
  }
  return out;
}

/** Alle feltene som avviker fra kontostandarden, for PUT /api/servers/{id}/alert-settings (hele overstyringen sendes). */
export function serverOverrides(loaded: RuleInfoDto[], draft: RuleDraft[]): Record<string, RuleSettingDto> {
  const out: Record<string, RuleSettingDto> = {};
  for (const rule of loaded) {
    const d = draft.find((x) => x.id === rule.id);
    if (!d) continue;
    const entry: RuleSettingDto = {};
    if (!d.enabled) entry.enabled = false;
    if (rule.defaultThreshold !== null && d.threshold !== null && d.threshold !== rule.defaultThreshold) entry.threshold = d.threshold;
    const seconds = d.minutes === null ? null : Math.round(d.minutes * 60);
    if (rule.defaultDurationSec !== null && seconds !== null && seconds !== rule.defaultDurationSec) entry.durationSec = seconds;
    if (Object.keys(entry).length > 0) out[rule.id] = entry;
  }
  return out;
}

export function toDraft(rules: RuleInfoDto[]): RuleDraft[] {
  return orderRules(rules).map((r) => ({ id: r.id, enabled: r.enabled, threshold: r.threshold, minutes: r.durationSec === null ? null : Math.round(r.durationSec / 60) }));
}

/**
 * Innstillinger › Varsler (steg 7.4, skjerm 10). Konto: «Default thresholds» (én rad per regel med prikk, navn, standard
 * som redigerbart tall ved klikk, bryter), Kanaler (Push med enheter, E-post «alltid på for server nede og disk full»,
 * Webhook med URL, hemmelighet med kopier og «Send test»), Daglig oppsummering (bryter + klokkeslett). «Save» kun ved
 * endring, toast ved lagret. Med `server`: «Alerts for web-02», «Use account defaults», per-regel overstyring i
 * `servers.alertOverrides` og «Mute all alerts for this server».
 */
@Component({
  selector: 'gp-alert-settings',
  imports: [FormsModule, TPipe, BadgeComponent, ButtonComponent, InputComponent, ToggleComponent, AutofocusDirective],
  templateUrl: './alert-settings.component.html',
  styleUrl: './alert-settings.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AlertSettingsComponent {
  /** Server-id fra `?server=` → per-server-visningen. */
  readonly server = input<string | undefined>();

  private readonly api = inject(AlertsService);
  private readonly i18n = inject(I18nService);
  private readonly toast = inject(ToastService);
  private readonly clipboard = inject(ClipboardService);
  private readonly router = inject(Router);
  readonly push = inject(PushService);

  readonly loaded = signal<AlertSettingsDto | null>(null);
  readonly serverLoaded = signal<ServerAlertSettingsDto | null>(null);
  readonly error = signal<I18nKey | null>(null);
  readonly rules = signal<RuleDraft[]>([]);
  readonly channels = signal<ChannelsDraft>({ push: true, email: true, webhookUrl: '', digestEnabled: true, digestTime: '08:00' });
  readonly useDefaults = signal(true);
  readonly muted = signal(false);
  readonly editing = signal<AlertRuleId | null>(null);
  readonly saving = signal(false);
  readonly testing = signal(false);
  readonly revealSecret = signal(false);

  private readonly texts = computed(() => {
    this.i18n.lang();
    return this.i18n;
  });

  readonly isServer = computed(() => !!this.server());
  readonly serverName = computed(() => this.serverLoaded()?.serverName ?? '');
  readonly baseRules = computed<RuleInfoDto[]>(() => (this.isServer() ? this.serverLoaded()?.rules : this.loaded()?.rules) ?? []);
  readonly rows = computed(() => {
    const t = this.texts();
    const base = this.baseRules();
    return this.rules().map((d) => {
      const info = base.find((r) => r.id === d.id);
      const preview: RuleInfoDto | null = info
        ? { ...info, enabled: d.enabled, threshold: d.threshold, durationSec: d.minutes === null ? null : d.minutes * 60 }
        : null;
      return {
        draft: d,
        nameKey: ruleNameKey(d.id),
        text: preview ? ruleDefaultText(preview, (k) => t.t(k), t.t('min')) : '',
        color: info ? severityColor(info.severity) : 'var(--color-info)',
        severityKey: info ? severityKey(info.severity) : ('info' as I18nKey),
        editable: !!info && (info.defaultThreshold !== null || info.defaultDurationSec !== null),
        hasThreshold: !!info && info.defaultThreshold !== null,
        thresholdUnit: info?.thresholdUnit ?? 'none',
        hasMinutes: !!info && info.defaultDurationSec !== null,
        overridden: this.isServer() && !!info && !!preview && serverOverrides([info], [d])[info.id] !== undefined,
      };
    });
  });

  readonly dirty = computed(() => {
    if (this.isServer()) {
      const s = this.serverLoaded();
      if (!s) return false;
      if (this.useDefaults() !== s.useAccountDefaults || this.muted() !== s.muted) return true;
      return !this.useDefaults() && JSON.stringify(serverOverrides(s.rules, this.rules())) !== JSON.stringify(serverOverrides(s.rules, toDraft(s.rules)));
    }
    const l = this.loaded();
    if (!l) return false;
    const c = this.channels();
    const channelsDirty = c.push !== l.channels.push || c.email !== l.channels.email || c.webhookUrl !== (l.channels.webhookUrl ?? '') || c.digestEnabled !== l.digest.enabled || c.digestTime !== l.digest.time;
    return channelsDirty || Object.keys(ruleChanges(l.rules, this.rules())).length > 0;
  });
  readonly timeValid = computed(() => /^([01]\d|2[0-3]):[0-5]\d$/.test(this.channels().digestTime));

  readonly deviceLine = computed(() => {
    const t = this.texts();
    const devices = this.loaded()?.pushDevices ?? [];
    if (devices.length === 0) return t.t('noDevices');
    const names = devices.map((d) => d.device || t.t('device')).slice(0, 3).join(', ');
    return `${devices.length} ${t.t(devices.length === 1 ? 'device' : 'devices')} · ${names}`;
  });
  readonly silencedUntil = computed(() => {
    const until = this.serverLoaded()?.silencedUntil;
    if (!until || Date.parse(until) < Date.now()) return null;
    return this.texts().formatWhen(Date.parse(until));
  });

  constructor() {
    effect(() => {
      const server = this.server();
      untracked(() => void this.load(server));
    });
  }

  private async load(server: string | undefined): Promise<void> {
    this.error.set(null);
    this.editing.set(null);
    try {
      if (server) {
        const s = await this.api.getServerSettings(server);
        this.applyServer(s);
      } else {
        const a = await this.api.getSettings();
        this.applyAccount(a);
      }
    } catch (err) {
      console.warn('[alert-settings] could not load', err);
      this.error.set('errorGeneric');
    }
  }

  private applyAccount(a: AlertSettingsDto): void {
    this.loaded.set(a);
    this.rules.set(toDraft(a.rules));
    this.channels.set({ push: a.channels.push, email: a.channels.email, webhookUrl: a.channels.webhookUrl ?? '', digestEnabled: a.digest.enabled, digestTime: a.digest.time });
  }

  private applyServer(s: ServerAlertSettingsDto): void {
    this.serverLoaded.set(s);
    this.rules.set(toDraft(s.rules));
    this.useDefaults.set(s.useAccountDefaults);
    this.muted.set(s.muted);
  }

  // ---- regler ------------------------------------------------------------------------------------

  toggleRule(id: AlertRuleId, enabled: boolean): void {
    this.rules.update((list) => list.map((r) => (r.id === id ? { ...r, enabled } : r)));
  }

  edit(id: AlertRuleId): void {
    this.editing.update((cur) => (cur === id ? null : id));
  }

  setThreshold(id: AlertRuleId, value: string): void {
    const n = Number(value);
    if (!Number.isFinite(n)) return;
    this.rules.update((list) => list.map((r) => (r.id === id ? { ...r, threshold: n } : r)));
  }

  setMinutes(id: AlertRuleId, value: string): void {
    const n = Number(value);
    if (!Number.isFinite(n)) return;
    this.rules.update((list) => list.map((r) => (r.id === id ? { ...r, minutes: n } : r)));
  }

  onEditKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter' || e.key === 'Escape') {
      e.preventDefault();
      this.editing.set(null);
    }
  }

  setUseDefaults(v: boolean): void {
    this.useDefaults.set(v);
    const s = this.serverLoaded();
    if (v && s) this.rules.set(toDraft(s.rules.map((r) => ({ ...r, enabled: true, threshold: r.defaultThreshold, durationSec: r.defaultDurationSec }))));
  }

  // ---- kanaler -----------------------------------------------------------------------------------

  setChannel<K extends keyof ChannelsDraft>(key: K, value: ChannelsDraft[K]): void {
    this.channels.update((c) => ({ ...c, [key]: value }));
  }

  async togglePushDevice(on: boolean): Promise<void> {
    if (on) {
      const status = await this.push.enable();
      if (status === 'on') {
        this.toast.show(this.i18n.t('pwaDone'));
        await this.load(undefined);
      } else if (status === 'denied') this.toast.show(this.i18n.t('pushDenied'));
      else if (status === 'unsupported') this.toast.show(this.i18n.t('pushNotSupported'));
      else if (status === 'error') this.toast.show(this.i18n.t('pushError'));
    } else {
      await this.push.disable();
      await this.load(undefined);
    }
  }

  copySecret(): void {
    const secret = this.loaded()?.channels.webhookSecret;
    if (secret) void this.clipboard.copy(secret);
  }

  async rotateSecret(): Promise<void> {
    try {
      this.applyAccount(await this.api.putChannels({ rotateWebhookSecret: true }));
      this.toast.show(this.i18n.t('saved'));
    } catch (err) {
      console.warn('[alert-settings] rotate failed', err);
      this.toast.show(this.i18n.t('errorGeneric'));
    }
  }

  async sendTest(): Promise<void> {
    if (this.testing()) return;
    this.testing.set(true);
    try {
      if (this.dirty()) await this.save();
      const res = await this.api.testWebhook();
      this.toast.show(this.i18n.t(res.ok ? 'testSent' : 'testFailed'));
    } catch (err) {
      console.warn('[alert-settings] webhook test failed', err);
      this.toast.show(this.i18n.t('testFailed'));
    } finally {
      this.testing.set(false);
    }
  }

  // ---- lagring -----------------------------------------------------------------------------------

  async save(): Promise<void> {
    if (!this.dirty() || this.saving() || (!this.isServer() && !this.timeValid())) return;
    this.saving.set(true);
    try {
      if (this.isServer()) {
        const s = this.serverLoaded();
        if (!s) return;
        const rules = this.useDefaults() ? undefined : serverOverrides(s.rules, this.rules());
        this.applyServer(await this.api.putServerSettings(s.serverId, { useAccountDefaults: this.useDefaults(), muted: this.muted(), rules }));
      } else {
        const l = this.loaded();
        if (!l) return;
        const c = this.channels();
        let result = l;
        const changes = ruleChanges(l.rules, this.rules());
        if (Object.keys(changes).length > 0) {
          const merged: Record<string, RuleSettingDto> = {};
          for (const rule of l.rules) {
            const entry: RuleSettingDto = {};
            const d = this.rules().find((x) => x.id === rule.id);
            if (d && !d.enabled) entry.enabled = false;
            if (d && rule.defaultThreshold !== null && d.threshold !== null && d.threshold !== rule.defaultThreshold) entry.threshold = d.threshold;
            if (d && rule.defaultDurationSec !== null && d.minutes !== null && Math.round(d.minutes * 60) !== rule.defaultDurationSec) entry.durationSec = Math.round(d.minutes * 60);
            if (Object.keys(entry).length > 0) merged[rule.id] = entry;
          }
          result = await this.api.putRules(merged);
        }
        result = await this.api.putChannels({ push: c.push, email: c.email, webhookUrl: c.webhookUrl, digest: { enabled: c.digestEnabled, time: c.digestTime } });
        this.applyAccount(result);
      }
      this.editing.set(null);
      this.toast.show(this.i18n.t('saved'));
    } catch (err) {
      console.warn('[alert-settings] save failed', err);
      this.toast.show(this.i18n.t('errorGeneric'));
    } finally {
      this.saving.set(false);
    }
  }

  async clearSilence(): Promise<void> {
    const s = this.serverLoaded();
    if (!s) return;
    try {
      this.applyServer(await this.api.putServerSettings(s.serverId, { clearSilence: true }));
      this.toast.show(this.i18n.t('saved'));
    } catch (err) {
      console.warn('[alert-settings] clear silence failed', err);
    }
  }

  backToServer(): void {
    const id = this.server();
    if (id) void this.router.navigate(['/servers', id]);
  }

  accountSettings(): void {
    void this.router.navigate(['/settings', 'alerts']);
  }
}
