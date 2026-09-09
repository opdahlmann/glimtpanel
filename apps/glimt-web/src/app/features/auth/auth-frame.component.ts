import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { TPipe } from '@core/t.pipe';
import { LogoComponent } from '@shared/logo/logo.component';

/**
 * Rammen rundt auth-skjermene (skjerm 1–2): logo 36 + «Glimtpanel» + tagline, glasskort 360 px (`--color-glass`,
 * radius 14, `--shadow-window`, padding 16px 14px 14px), og under kortet grønn prikk + betaløftet (`authNote`).
 * På mobil fyller kortet bredden (skallet gir 12 px marg).
 */
@Component({
  selector: 'gp-auth-frame',
  imports: [LogoComponent, TPipe],
  template: `
    <div class="head">
      <gp-logo [size]="36" />
      <div>
        <h1 class="name">Glimtpanel</h1>
        <div class="tagline">{{ 'tagline' | t }}</div>
      </div>
    </div>
    <section class="card" [attr.aria-label]="ariaLabel()">
      <ng-content />
    </section>
    @if (note()) {
      <div class="note"><span class="dot" aria-hidden="true"></span>{{ 'authNote' | t }}</div>
    }
  `,
  styles: `
    :host { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 24px; width: 100%; min-height: calc(100dvh - 88px); padding: 24px 0; }
    .head { display: flex; align-items: center; gap: 10px; }
    .name { margin: 0; font-size: 16px; font-weight: 600; letter-spacing: -.01em; }
    .tagline { font-size: 11px; color: var(--w-65); }
    .card {
      width: 100%; max-width: 360px; display: flex; flex-direction: column; gap: 12px; padding: 16px 14px 14px;
      background: var(--color-glass); backdrop-filter: blur(40px) saturate(180%); -webkit-backdrop-filter: blur(40px) saturate(180%);
      border-radius: var(--radius-window); box-shadow: var(--shadow-window); animation: pdIn var(--t-panel) var(--ease-out-expo);
    }
    .note { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--w-40); text-align: center; padding: 0 16px; }
    .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--color-ram); flex: none; }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AuthFrameComponent {
  readonly note = input(true);
  readonly ariaLabel = input('');
}
