import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TPipe } from '@core/t.pipe';
import { TitleService } from './title.service';

/** Ukjent adresse innlogget (steg 9.5): kort forklaring og vei til oversikten, i skallet. */
@Component({
  selector: 'gp-not-found-page',
  imports: [RouterLink, TPipe],
  template: `
    <div class="page" data-testid="not-found">
      <h1 class="title">404</h1>
      <p class="note">{{ 'pageNotFound' | t }}</p>
      <a routerLink="/" class="link">{{ 'goHome' | t }}</a>
    </div>
  `,
  styles: `
    :host { display: block; }
    .page { max-width: var(--page-max); display: flex; flex-direction: column; gap: 8px; }
    .title { margin: 0; font-size: 20px; font-weight: 700; letter-spacing: -.025em; }
    .note { margin: 0; font-size: 12px; color: var(--w-60); }
    .link { display: inline-flex; align-items: center; min-height: 44px; color: var(--color-cpu); font-size: 12px; font-weight: 600; text-decoration: none; }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NotFoundPage {
  constructor() {
    inject(TitleService).setKey('notFound');
  }
}
