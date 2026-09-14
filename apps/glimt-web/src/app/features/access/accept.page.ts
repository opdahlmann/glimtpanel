import { ChangeDetectionStrategy, Component, effect, inject, input, signal, untracked } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { ApiService } from '@core/api.service';
import { I18nService } from '@core/i18n.service';
import { ServerListItem } from '@core/live.types';
import { ServerListService } from '@core/server-list.service';
import { TPipe } from '@core/t.pipe';
import { ToastService } from '@shared/toast/toast.service';

/**
 * `/access/accept?token=` (steg 8.4): lenken i invitasjonsmailen. Ruten krever innlogging (authGuard sender til
 * `/login?next=…`, og registrering lander tilbake her), så `POST /api/access/accept` kjøres innlogget → toast «You now
 * have read access to 3 servers» → oversikten. Feil (ugyldig lenke, annen e-post) vises med en vei tilbake.
 */
@Component({
  selector: 'gp-accept-page',
  imports: [RouterLink, TPipe],
  template: `
    <div class="page">
      @if (error()) {
        <h1 class="title">{{ 'access' | t }}</h1>
        <p class="note" role="alert" data-testid="accept-error">{{ 'acceptFailed' | t }}</p>
        <a routerLink="/" class="link">{{ 'servers' | t }}</a>
      } @else {
        <p class="note" role="status">{{ 'acceptingAccess' | t }}</p>
      }
    </div>
  `,
  styles: `
    :host { display: block; }
    .page { max-width: var(--page-max); display: flex; flex-direction: column; gap: 12px; }
    .title { margin: 0; font-size: 20px; font-weight: 700; letter-spacing: -.025em; }
    .note { margin: 0; font-size: 12px; color: var(--w-60); }
    .link { display: inline-flex; align-items: center; min-height: 44px; color: var(--color-cpu); font-size: 12px; font-weight: 600; text-decoration: none; }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AcceptPage {
  readonly token = input<string>();

  private readonly api = inject(ApiService);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  private readonly i18n = inject(I18nService);
  private readonly serverList = inject(ServerListService);

  readonly error = signal(false);
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
      this.error.set(true);
      return;
    }
    try {
      await this.api.post<unknown>('/access/accept', { token });
    } catch (err) {
      console.warn('[access] accept failed', err);
      this.error.set(true);
      return;
    }
    const count = await this.serverList
      .load()
      .then((list) => list.filter((s: ServerListItem) => s.role === 'reader').length)
      .catch(() => 0);
    this.toast.show(`${this.i18n.t('accessAccepted')} ${count} ${this.i18n.t(count === 1 ? 'server' : 'servers').toLowerCase()}`);
    await this.router.navigateByUrl('/');
  }
}
