import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiError, ApiService, errorKey } from '@core/api.service';
import { FeatureFlags } from '@core/feature-flags';
import { I18nKey, I18nService } from '@core/i18n.service';
import { Lang } from '@core/prefs.service';
import { SessionService } from '@core/session.service';
import { TPipe } from '@core/t.pipe';
import { ButtonComponent } from '@shared/button/button.component';
import { InputComponent } from '@shared/input/input.component';
import { ModalComponent } from '@shared/modal/modal.component';
import { SegmentComponent, SegmentOption } from '@shared/segment/segment.component';
import { SelectComponent, SelectOption } from '@shared/select/select.component';
import { ToastService } from '@shared/toast/toast.service';
import { DeleteAccountDialogComponent } from './delete-account-dialog.component';

/** Tidssonene nettleseren kjenner, med nåværende offset i teksten («Europe/Oslo (UTC+02:00)»). */
function supportedTimeZones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  try {
    return intl.supportedValuesOf ? intl.supportedValuesOf('timeZone') : [];
  } catch {
    return [];
  }
}

export function timeZoneOptions(current: string | null, now = new Date()): SelectOption<string>[] {
  let zones = supportedTimeZones();
  if (current && !zones.includes(current)) zones = [current, ...zones];
  if (zones.length === 0) zones = ['UTC'];
  return zones.map((tz) => ({ value: tz, label: `${tz} (${offsetLabel(tz, now)})` }));
}

/** «UTC+02:00» for en sone akkurat nå; tom streng når nettleseren ikke kan. */
export function offsetLabel(tz: string, now = new Date()): string {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' }).formatToParts(now).find((p) => p.type === 'timeZoneName');
    return part?.value === 'GMT' ? 'UTC+00:00' : (part?.value ?? '').replace(/^GMT/, 'UTC');
  } catch {
    return '';
  }
}

/** Fra ApiError: feltfeil fra huben → ordboksnøkkel. */
function fieldError(err: unknown, field: string, key: I18nKey): I18nKey {
  if (err instanceof ApiError && err.errors && Object.keys(err.errors).some((k) => k.toLowerCase() === field.toLowerCase())) return key;
  return errorKey(err);
}

/**
 * Innstillinger › Konto (steg 8.2, skjerm 9): profil (navn, e-post med ny bekreftelse, tidssone med offset, språk som
 * bytter straks, Save), passord (dialog med gammelt og nytt), tofaktor bak flagg, og «Delete account».
 */
@Component({
  selector: 'gp-account-settings',
  imports: [FormsModule, TPipe, InputComponent, SelectComponent, SegmentComponent, ButtonComponent, ModalComponent, DeleteAccountDialogComponent],
  templateUrl: './account-settings.component.html',
  styleUrl: './settings.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AccountSettingsComponent {
  private readonly session = inject(SessionService);
  private readonly api = inject(ApiService);
  private readonly i18n = inject(I18nService);
  private readonly toast = inject(ToastService);
  readonly flags = inject(FeatureFlags);

  readonly user = this.session.user;
  /** Demoen (steg 10.1): profilen vises, ingenting kan lagres. Språket er et lokalt valg og virker fortsatt. */
  readonly readOnly = this.session.demoMode;
  readonly name = signal(this.user()?.name ?? '');
  readonly timezone = signal(this.user()?.timezone ?? 'UTC');
  readonly timezoneOptions = computed(() => timeZoneOptions(this.user()?.timezone ?? null));
  readonly langOptions = computed<SegmentOption<Lang>[]>(() => {
    this.i18n.lang();
    return [
      { value: 'en', label: 'English' },
      { value: 'no', label: 'Norsk' },
    ];
  });
  readonly lang = this.i18n.lang;
  readonly dirty = computed(() => this.name().trim() !== (this.user()?.name ?? '') || this.timezone() !== (this.user()?.timezone ?? ''));
  readonly saving = signal(false);
  readonly saved = signal(false);
  readonly error = signal<I18nKey | null>(null);

  // E-post
  readonly emailOpen = signal(false);
  readonly newEmail = signal('');
  readonly emailPassword = signal('');
  readonly emailBusy = signal(false);
  readonly emailError = signal<I18nKey | null>(null);
  readonly pendingEmail = signal<string | null>(null);

  // Passord
  readonly pwOpen = signal(false);
  readonly currentPassword = signal('');
  readonly newPassword = signal('');
  readonly pwBusy = signal(false);
  readonly pwError = signal<I18nKey | null>(null);

  readonly deleteOpen = signal(false);

  async save(): Promise<void> {
    if (!this.dirty() || this.saving()) return;
    const name = this.name().trim();
    if (!name) {
      this.error.set('nameRequired');
      return;
    }
    this.saving.set(true);
    this.error.set(null);
    try {
      await this.session.updateAccount({ name, timezone: this.timezone() });
      this.saved.set(true);
      setTimeout(() => this.saved.set(false), 2000);
      this.toast.show(this.i18n.t('saved'));
    } catch (err) {
      this.error.set(errorKey(err));
    } finally {
      this.saving.set(false);
    }
  }

  setLang(lang: Lang | null): void {
    if (lang) this.i18n.setLang(lang);
  }

  openEmail(): void {
    this.newEmail.set('');
    this.emailPassword.set('');
    this.emailError.set(null);
    this.emailOpen.set(true);
  }

  async changeEmail(): Promise<void> {
    if (this.emailBusy() || !this.newEmail().trim() || !this.emailPassword()) return;
    this.emailBusy.set(true);
    this.emailError.set(null);
    try {
      const res = await this.api.put<{ pendingEmail: string }>('/account/email', { email: this.newEmail().trim(), password: this.emailPassword() });
      this.pendingEmail.set(res.pendingEmail);
      this.emailOpen.set(false);
      this.toast.show(this.i18n.t('emailChangeSent'));
    } catch (err) {
      const key = fieldError(err, 'password', 'passwordWrong');
      this.emailError.set(key === 'errorGeneric' ? fieldError(err, 'email', 'invalidEmail') : key);
    } finally {
      this.emailBusy.set(false);
    }
  }

  openPassword(): void {
    this.currentPassword.set('');
    this.newPassword.set('');
    this.pwError.set(null);
    this.pwOpen.set(true);
  }

  async changePassword(): Promise<void> {
    if (this.pwBusy() || !this.currentPassword() || !this.newPassword()) return;
    if (this.newPassword().length < 10) {
      this.pwError.set('passwordTooShort');
      return;
    }
    this.pwBusy.set(true);
    this.pwError.set(null);
    try {
      await this.api.post<void>('/auth/password', { currentPassword: this.currentPassword(), newPassword: this.newPassword() });
      this.pwOpen.set(false);
      this.toast.show(this.i18n.t('passwordChanged'));
    } catch (err) {
      this.pwError.set(fieldError(err, 'currentPassword', 'passwordWrong'));
    } finally {
      this.pwBusy.set(false);
    }
  }
}
