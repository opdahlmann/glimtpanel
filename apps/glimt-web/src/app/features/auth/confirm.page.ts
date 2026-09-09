import { ChangeDetectionStrategy, Component, effect, inject, input, signal, untracked } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { errorKey } from '@core/api.service';
import { I18nKey } from '@core/i18n.service';
import { SessionService } from '@core/session.service';
import { TPipe } from '@core/t.pipe';
import { AuthFrameComponent } from './auth-frame.component';

/** `/confirm?token=` → `POST /api/auth/confirm` → innlogget → `/` (som viser onboarding i fase 4). */
@Component({
  selector: 'gp-confirm-page',
  imports: [RouterLink, AuthFrameComponent, TPipe],
  template: `
    <gp-auth-frame [note]="false">
      @if (error(); as key) {
        <div class="stack" role="alert">
          <h2 class="title">{{ key | t }}</h2>
          <a routerLink="/login" class="forgot">{{ 'backToLogin' | t }}</a>
        </div>
      } @else {
        <p class="note" role="status">{{ 'confirming' | t }}</p>
      }
    </gp-auth-frame>
  `,
  styleUrl: './auth.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConfirmPage {
  private readonly session = inject(SessionService);
  private readonly router = inject(Router);

  readonly token = input<string>();
  readonly error = signal<I18nKey | null>(null);
  private started = false;

  constructor() {
    effect(() => {
      const token = this.token();
      untracked(() => void this.run(token));
    });
  }

  private async run(token: string | undefined): Promise<void> {
    if (this.started) return;
    this.started = true;
    if (!token) {
      this.error.set('invalidToken');
      return;
    }
    try {
      await this.session.confirm(token);
    } catch (err) {
      this.error.set(errorKey(err));
      return;
    }
    await this.router.navigateByUrl('/');
  }
}
