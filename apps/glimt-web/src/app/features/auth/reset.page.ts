import { afterNextRender, ChangeDetectionStrategy, Component, ElementRef, inject, input, signal } from '@angular/core';
import { FormGroup, ReactiveFormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { errorKey } from '@core/api.service';
import { I18nKey, I18nService } from '@core/i18n.service';
import { SessionService } from '@core/session.service';
import { TPipe } from '@core/t.pipe';
import { ButtonComponent } from '@shared/button/button.component';
import { InputComponent } from '@shared/input/input.component';
import { ToastService } from '@shared/toast/toast.service';
import { BreakpointService } from '@shared/util/breakpoint.service';
import { AuthFrameComponent } from './auth-frame.component';
import { fieldError, focusFirstField, passwordControl } from './auth-form';

/** `/reset?token=`: nytt passord → `POST /api/auth/reset` → innloggingsskjermen med toast. */
@Component({
  selector: 'gp-reset-page',
  imports: [ReactiveFormsModule, RouterLink, AuthFrameComponent, InputComponent, ButtonComponent, TPipe],
  template: `
    <gp-auth-frame [note]="false" [ariaLabel]="'resetPw' | t">
      <h2 class="title">{{ 'resetPw' | t }}</h2>
      <p class="note">{{ 'resetSub' | t }}</p>
      <form [formGroup]="form" (ngSubmit)="submit()" novalidate>
        <gp-input formControlName="password" type="password" name="new-password" autocomplete="new-password" [placeholder]="'newPassword' | t" [error]="passwordError()" />
        @if (error(); as key) {
          <div class="err" role="alert">{{ key | t }}</div>
        }
        <gp-button type="submit" variant="primary" size="lg" [block]="true" [loading]="busy()">{{ 'resetPw' | t }}</gp-button>
        <a routerLink="/login" class="forgot">{{ 'backToLogin' | t }}</a>
      </form>
    </gp-auth-frame>
  `,
  styleUrl: './auth.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ResetPage {
  private readonly session = inject(SessionService);
  private readonly router = inject(Router);
  private readonly i18n = inject(I18nService);
  private readonly toast = inject(ToastService);

  readonly token = input<string>();
  readonly form = new FormGroup({ password: passwordControl() });
  readonly submitted = signal(false);
  readonly busy = signal(false);
  readonly error = signal<I18nKey | null>(null);
  readonly passwordError = fieldError(this.form.controls.password, this.submitted, this.i18n);

  constructor() {
    const host = inject<ElementRef<HTMLElement>>(ElementRef);
    const breakpoint = inject(BreakpointService);
    afterNextRender(() => focusFirstField(host, breakpoint));
  }

  async submit(): Promise<void> {
    this.submitted.set(true);
    this.error.set(null);
    if (this.form.invalid || this.busy()) return;
    const token = this.token();
    if (!token) {
      this.error.set('invalidToken');
      return;
    }
    this.busy.set(true);
    try {
      await this.session.reset(token, this.form.controls.password.value);
    } catch (err) {
      this.error.set(errorKey(err));
      return;
    } finally {
      this.busy.set(false);
    }
    this.toast.show(this.i18n.t('passwordChanged'));
    await this.router.navigateByUrl('/login');
  }
}
