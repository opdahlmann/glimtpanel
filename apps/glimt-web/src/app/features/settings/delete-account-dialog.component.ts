import { ChangeDetectionStrategy, Component, inject, model, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { ApiError, ApiService, errorKey } from '@core/api.service';
import { I18nKey } from '@core/i18n.service';
import { SessionService } from '@core/session.service';
import { TPipe } from '@core/t.pipe';
import { ButtonComponent } from '@shared/button/button.component';
import { InputComponent } from '@shared/input/input.component';
import { ModalComponent } from '@shared/modal/modal.component';

/**
 * «Delete account» (steg 8.2 og 8.6): dialog med passord og teksten «Deletes servers, keys, access, alerts and push
 * devices. Agents stop connecting. Cannot be undone.» → `DELETE /api/account` → utlogget → `/login`.
 */
@Component({
  selector: 'gp-delete-account-dialog',
  imports: [ModalComponent, InputComponent, ButtonComponent, FormsModule, TPipe],
  template: `
    <gp-modal [(open)]="open" [title]="'deleteAcc' | t" [maxWidth]="440" [closeLabel]="'close' | t">
      @if (open()) {
        <p class="warn" role="alert">{{ 'deleteAccountWarning' | t }}</p>
        <gp-input type="password" [label]="'confirmDelete' | t" [ngModel]="password()" (ngModelChange)="password.set($event)" name="deletePassword" autocomplete="current-password" (keydown.enter)="confirm()" />
        @if (error(); as e) {
          <div class="error" role="alert">{{ e | t }}</div>
        }
        <div class="foot">
          <gp-button variant="ghost" size="lg" (click)="open.set(false)">{{ 'cancel' | t }}</gp-button>
          <gp-button variant="danger" size="lg" [loading]="busy()" [disabled]="!password()" (click)="confirm()">{{ 'deleteAcc' | t }}</gp-button>
        </div>
      }
    </gp-modal>
  `,
  styles: `
    .warn { margin: 0; font-size: 12px; color: var(--w-85); line-height: 1.5; padding: 10px 12px; border-radius: var(--radius-card); background: color-mix(in srgb, var(--color-crit) 10%, transparent); }
    .error { font-size: 11px; color: var(--color-crit); }
    .foot { display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DeleteAccountDialogComponent {
  readonly open = model(false);

  private readonly api = inject(ApiService);
  private readonly session = inject(SessionService);
  private readonly router = inject(Router);

  readonly password = signal('');
  readonly busy = signal(false);
  readonly error = signal<I18nKey | null>(null);

  async confirm(): Promise<void> {
    if (!this.password() || this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.api.delete<void>('/account', { password: this.password() });
      this.open.set(false);
      await this.session.logout();
      await this.router.navigateByUrl('/login');
    } catch (err) {
      this.error.set(err instanceof ApiError && err.errors?.['password'] ? 'passwordWrong' : errorKey(err));
    } finally {
      this.busy.set(false);
    }
  }
}
