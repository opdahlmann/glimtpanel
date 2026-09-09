import { afterNextRender, ChangeDetectionStrategy, Component, ElementRef, inject, signal } from '@angular/core';
import { FormGroup, ReactiveFormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { errorKey } from '@core/api.service';
import { I18nKey, I18nService } from '@core/i18n.service';
import { SessionService } from '@core/session.service';
import { TPipe } from '@core/t.pipe';
import { ButtonComponent } from '@shared/button/button.component';
import { InputComponent } from '@shared/input/input.component';
import { SegmentComponent } from '@shared/segment/segment.component';
import { ToastService } from '@shared/toast/toast.service';
import { BreakpointService } from '@shared/util/breakpoint.service';
import { AuthFrameComponent } from './auth-frame.component';
import { emailControl, fieldError, focusFirstField, nameControl, passwordControl } from './auth-form';
import { authSegment } from './auth-segment';

/** Skjerm 2: registrering. Etter `POST /api/auth/register` vises «sjekk e-posten din» med «Send again». */
@Component({
  selector: 'gp-register-page',
  imports: [ReactiveFormsModule, RouterLink, AuthFrameComponent, SegmentComponent, InputComponent, ButtonComponent, TPipe],
  templateUrl: './register.page.html',
  styleUrl: './auth.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RegisterPage {
  private readonly session = inject(SessionService);
  private readonly i18n = inject(I18nService);
  private readonly toast = inject(ToastService);

  readonly form = new FormGroup({ name: nameControl(), email: emailControl(), password: passwordControl() });
  readonly submitted = signal(false);
  readonly busy = signal(false);
  readonly error = signal<I18nKey | null>(null);
  /** E-posten kontoen ble opprettet med; null = skjemaet vises. */
  readonly sentTo = signal<string | null>(null);
  readonly nameError = fieldError(this.form.controls.name, this.submitted, this.i18n);
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
    if (this.form.invalid || this.busy()) return;
    this.busy.set(true);
    const { name, email, password } = this.form.getRawValue();
    try {
      await this.session.register(email.trim(), password, name.trim());
      this.sentTo.set(email.trim());
    } catch (err) {
      this.error.set(errorKey(err));
    } finally {
      this.busy.set(false);
    }
  }

  async resend(): Promise<void> {
    const email = this.sentTo();
    if (!email) return;
    try {
      await this.session.resendConfirmation(email);
      this.toast.show(this.i18n.t('sent'));
    } catch (err) {
      this.error.set(errorKey(err));
    }
  }
}
