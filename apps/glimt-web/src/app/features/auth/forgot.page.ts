import { afterNextRender, ChangeDetectionStrategy, Component, ElementRef, inject, signal } from '@angular/core';
import { FormGroup, ReactiveFormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { errorKey } from '@core/api.service';
import { I18nKey, I18nService } from '@core/i18n.service';
import { SessionService } from '@core/session.service';
import { TPipe } from '@core/t.pipe';
import { ButtonComponent } from '@shared/button/button.component';
import { InputComponent } from '@shared/input/input.component';
import { BreakpointService } from '@shared/util/breakpoint.service';
import { AuthFrameComponent } from './auth-frame.component';
import { emailControl, fieldError, focusFirstField } from './auth-form';

/** `/forgot`: e-post → `POST /api/auth/forgot` (alltid 204) → «sjekk e-posten din». */
@Component({
  selector: 'gp-forgot-page',
  imports: [ReactiveFormsModule, RouterLink, AuthFrameComponent, InputComponent, ButtonComponent, TPipe],
  template: `
    <gp-auth-frame [note]="false" [ariaLabel]="'resetPw' | t">
      @if (sent()) {
        <div class="stack" role="status">
          <h2 class="title">{{ 'checkEmail' | t }}</h2>
          <p class="note">{{ 'resetEmailSub' | t }}</p>
          <a routerLink="/login" class="forgot">{{ 'backToLogin' | t }}</a>
        </div>
      } @else {
        <h2 class="title">{{ 'resetPw' | t }}</h2>
        <p class="note">{{ 'forgotSub' | t }}</p>
        <form [formGroup]="form" (ngSubmit)="submit()" novalidate>
          <gp-input formControlName="email" type="email" name="email" autocomplete="email" [placeholder]="'email' | t" [error]="emailError()" />
          @if (error(); as key) {
            <div class="err" role="alert">{{ key | t }}</div>
          }
          <gp-button type="submit" variant="primary" size="lg" [block]="true" [loading]="busy()">{{ 'sendLink' | t }}</gp-button>
          <a routerLink="/login" class="forgot">{{ 'backToLogin' | t }}</a>
        </form>
      }
    </gp-auth-frame>
  `,
  styleUrl: './auth.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ForgotPage {
  private readonly session = inject(SessionService);
  private readonly i18n = inject(I18nService);

  readonly form = new FormGroup({ email: emailControl() });
  readonly submitted = signal(false);
  readonly busy = signal(false);
  readonly sent = signal(false);
  readonly error = signal<I18nKey | null>(null);
  readonly emailError = fieldError(this.form.controls.email, this.submitted, this.i18n);

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
    try {
      await this.session.forgot(this.form.controls.email.value.trim());
      this.sent.set(true);
    } catch (err) {
      this.error.set(errorKey(err));
    } finally {
      this.busy.set(false);
    }
  }
}
