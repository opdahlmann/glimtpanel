import { computed, DestroyRef, ElementRef, inject, signal, Signal } from '@angular/core';
import { AbstractControl, FormControl, ValidationErrors, ValidatorFn } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { I18nKey, I18nService } from '@core/i18n.service';
import { BreakpointService } from '@shared/util/breakpoint.service';

/** Passord ≥ 10 tegn (huben krever det samme og avviser vanlige passord). */
export const PASSWORD_MIN = 10;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const emailValidator: ValidatorFn = (c: AbstractControl): ValidationErrors | null => {
  const v = String(c.value ?? '').trim();
  return v && EMAIL_RE.test(v) ? null : { invalidEmail: true };
};

export const passwordValidator: ValidatorFn = (c: AbstractControl): ValidationErrors | null =>
  String(c.value ?? '').length >= PASSWORD_MIN ? null : { passwordTooShort: true };

export const nameValidator: ValidatorFn = (c: AbstractControl): ValidationErrors | null =>
  String(c.value ?? '').trim().length > 0 ? null : { nameRequired: true };

export function emailControl(): FormControl<string> {
  return new FormControl('', { nonNullable: true, validators: [emailValidator] });
}

export function passwordControl(): FormControl<string> {
  return new FormControl('', { nonNullable: true, validators: [passwordValidator] });
}

export function nameControl(): FormControl<string> {
  return new FormControl('', { nonNullable: true, validators: [nameValidator] });
}

/** Første feilnøkkel i kontrollen som ordboksnøkkel (validatorene bruker ordboksnøkler som feilnavn; tomt felt gir samme melding). */
export function controlErrorKey(c: AbstractControl): I18nKey | null {
  const errors = c.errors;
  if (!errors) return null;
  if (errors['invalidEmail']) return 'invalidEmail';
  if (errors['passwordTooShort']) return 'passwordTooShort';
  if (errors['nameRequired']) return 'nameRequired';
  return 'required';
}

/**
 * Feilmelding for et felt: vises først etter at feltet er rørt eller skjemaet er sendt. `submitted` er en signal
 * som siden setter ved innsending; `touched` speiles fra kontrollen via `statusChanges`.
 */
export function fieldError(control: FormControl<string>, submitted: Signal<boolean>, i18n: I18nService): Signal<string> {
  const version = signal(0);
  const destroyRef = inject(DestroyRef);
  control.events.pipe(takeUntilDestroyed(destroyRef)).subscribe(() => version.update((v) => v + 1));
  return computed(() => {
    version();
    if (!submitted() && !control.touched) return '';
    const key = controlErrorKey(control);
    return key ? i18n.t(key) : '';
  });
}

/** Autofokus i første felt kun på desktop (tastaturet skal ikke sprette opp på mobil). */
export function focusFirstField(host: ElementRef<HTMLElement>, breakpoint: BreakpointService): void {
  if (breakpoint.isMobile()) return;
  const el = host.nativeElement.querySelector<HTMLInputElement>('input:not([type="hidden"])');
  el?.focus({ preventScroll: true });
}
