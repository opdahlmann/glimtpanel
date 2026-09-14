import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ToastService } from './toast.service';

/** Pille sentrert 80 px fra bunnen (6.2): `#282a30`, grønn hake, `aria-live="polite"`. Legges én gang i skallet. */
@Component({
  selector: 'gp-toast-host',
  template: `
    <div class="host" aria-live="polite" role="status">
      @if (toast.current(); as t) {
        <div class="pill">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M5 12l5 5L20 7" />
          </svg>
          <span>{{ t.message }}</span>
          @if (t.action; as a) {
            <button type="button" class="act" (click)="run(a)">{{ a.label }}</button>
          }
        </div>
      }
    </div>
  `,
  styles: `
    .host { position: fixed; left: 0; right: 0; bottom: 80px; z-index: 30; display: flex; justify-content: center; pointer-events: none; padding: 0 12px; }
    .pill {
      display: flex; align-items: center; gap: 8px; max-width: 100%; padding: 10px 16px; border-radius: var(--radius-pill);
      background: #282a30; color: var(--w-90); font-size: 12px; font-weight: 600;
      box-shadow: inset 0 0 0 .5px var(--s-14), 0 12px 40px #00000080; animation: pdIn var(--t-panel);
    }
    svg { color: var(--color-ram); flex: none; }
    .pill:has(.act) { pointer-events: auto; }
    .act { min-height: 32px; padding: 0 10px; border: 0; border-radius: var(--radius-pill); background: var(--w-100); color: var(--color-ink); font: inherit; font-weight: 600; cursor: pointer; }
    @media (pointer: coarse) { .act { min-height: 44px; } }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ToastHostComponent {
  readonly toast = inject(ToastService);

  run(action: { run: () => void }): void {
    this.toast.dismiss();
    action.run();
  }
}
