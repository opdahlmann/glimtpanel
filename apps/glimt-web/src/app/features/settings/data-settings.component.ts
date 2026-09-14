import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { ApiService } from '@core/api.service';
import { I18nService } from '@core/i18n.service';
import { TPipe } from '@core/t.pipe';
import { ButtonComponent } from '@shared/button/button.component';
import { ToastService } from '@shared/toast/toast.service';
import { DeleteAccountDialogComponent } from './delete-account-dialog.component';

/** Filnavnet huben gir eksporten. */
export const EXPORT_FILENAME = 'glimtpanel-export.json';

/**
 * Innstillinger › Data (steg 8.6, skjerm 13): «Download everything» henter `GET /api/account/export` med `fetch` og
 * lagrer som `Blob` (virker også i PWA), «Delete everything» åpner samme dialog som Konto.
 */
@Component({
  selector: 'gp-data-settings',
  imports: [TPipe, ButtonComponent, DeleteAccountDialogComponent],
  template: `
    <div class="grid">
      <section class="card" aria-labelledby="export-title" data-testid="export-card">
        <h2 id="export-title" class="section">{{ 'exportAll' | t }}</h2>
        <p class="note">{{ 'exportSub' | t }}</p>
        <div class="row">
          <gp-button variant="primary" size="lg" [loading]="busy()" (click)="download()">{{ 'exportAll' | t }}</gp-button>
        </div>
      </section>
      <section class="card danger" aria-labelledby="delete-title">
        <h2 id="delete-title" class="section">{{ 'deleteAll' | t }}</h2>
        <p class="note">{{ 'deleteSub' | t }}</p>
        <div class="row">
          <gp-button variant="danger" size="lg" (click)="deleteOpen.set(true)">{{ 'deleteAll' | t }}</gp-button>
        </div>
      </section>
    </div>
    <gp-delete-account-dialog [(open)]="deleteOpen" />
  `,
  styleUrl: './settings.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DataSettingsComponent {
  private readonly api = inject(ApiService);
  private readonly i18n = inject(I18nService);
  private readonly toast = inject(ToastService);

  readonly busy = signal(false);
  readonly deleteOpen = signal(false);

  async download(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      const data = await this.api.get<unknown>('/account/export');
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = EXPORT_FILENAME;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      this.toast.show(this.i18n.t('exportStarted'));
    } catch (err) {
      console.warn('[data] export failed', err);
      this.toast.show(this.i18n.t('exportFailed'));
    } finally {
      this.busy.set(false);
    }
  }
}
