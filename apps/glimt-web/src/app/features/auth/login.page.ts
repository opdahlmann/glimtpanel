import { afterNextRender, ChangeDetectionStrategy, Component, ElementRef, inject, input, signal } from '@angular/core';
import { FormGroup, ReactiveFormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { ApiError, errorKey } from '@core/api.service';
import { safeNext } from '@core/guards';
import { I18nKey, I18nService } from '@core/i18n.service';
import { SessionService } from '@core/session.service';
import { TPipe } from '@core/t.pipe';
import { ButtonComponent } from '@shared/button/button.component';
import { InputComponent } from '@shared/input/input.component';
import { SegmentComponent } from '@shared/segment/segment.component';
import { ToastService } from '@shared/toast/toast.service';
import { BreakpointService } from '@shared/util/breakpoint.service';
import { AuthFrameComponent } from './auth-frame.component';
import { emailControl, fieldError, focusFirstField, passwordControl } from './auth-form';
import { authSegment } from './auth-segment';

/** Skjerm 1: innlogging. Enter sender skjemaet, autofokus kun på desktop, `?next=` respekteres. */
@Component({
  selector: 'gp-login-page',
  imports: [ReactiveFormsModule, RouterLink, AuthFrameComponent, SegmentComponent, InputComponent, ButtonComponent, TPipe],
  templateUrl: './login.page.html',
  styleUrl: './auth.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LoginPage {
  private readonly session = inject(SessionService);
  private readonly router = inject(Router);
  private readonly i18n = inject(I18nService);
  private readonly toast = inject(ToastService);

  /** Fra `?next=` (withComponentInputBinding). */
  readonly next = input<string>();

  readonly form = new FormGroup({ email: emailControl(), password: passwordControl() });
  readonly submitted = signal(false);
  readonly busy = signal(false);
  readonly error = signal<I18nKey | null>(null);
  readonly unconfirmed = signal(false);
  readonly emailError = fieldError(this.form.controls.email, this.submitted, this.i18n);
  readonly passwordError = fieldError(this.form.controls.password, this.submitted, this.i18n);
  readonly seg = authSegment();

  constructor() {
    const host = inject<ElementRef<HTMLElement>>(ElementRef);
    const breakpoint = inject(BreakpointService);
    afterNextRender(() => focusFirstField(host, breakpoint));
  }

  async submit(): Promise<void> {
    this.submitted.set(true);
    this.error.set(null);
    this.unconfirmed.set(false);
    if (this.form.invalid || this.busy()) return;
    this.busy.set(true);
    const { email, password } = this.form.getRawValue();
    try {
      await this.session.login(email.trim(), password);
    } catch (err) {
      this.error.set(errorKey(err));
      this.unconfirmed.set(err instanceof ApiError && err.code === 'emailNotConfirmed');
      this.busy.set(false);
      return;
    }
    // Navigasjonsfeil er ikke innloggingsfeil: de går til Angulars feilhåndterer (konsollen), ikke under skjemaet.
    await this.router.navigateByUrl(safeNext(this.next()));
    this.busy.set(false);
  }

  async resend(): Promise<void> {
    try {
      await this.session.resendConfirmation(this.form.controls.email.value.trim());
      this.toast.show(this.i18n.t('sent'));
    } catch (err) {
      this.error.set(errorKey(err));
    }
  }
}
