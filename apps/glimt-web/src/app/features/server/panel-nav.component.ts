import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

export interface PanelNavItem {
  key: string;
  label: string;
  /** CSS-farge på prikken. */
  color: string;
}

/**
 * Sticky panelnavigasjon (steg 5.2, D 10.2): piller med fargeprikk, `top: 0` på desktop og `top: 44px` under
 * topplinjen på mobil, bakgrunn `#0f1013e6` med blur, ruller horisontalt og kuttes aldri.
 */
@Component({
  selector: 'gp-panel-nav',
  template: `
    <nav class="nav" [attr.aria-label]="label()">
      @for (p of items(); track p.key) {
        <button type="button" class="pill" (click)="selected.emit(p.key)">
          <span class="dot" [style.background]="p.color" aria-hidden="true"></span>{{ p.label }}
        </button>
      }
    </nav>
  `,
  styles: `
    :host {
      display: block; position: sticky; top: var(--panel-nav-top, 0); z-index: 5; margin: 0 -12px; padding: 8px 12px;
      background: #0f1013e6; backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
    }
    .nav { display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none; -webkit-overflow-scrolling: touch; }
    .nav::-webkit-scrollbar { display: none; }
    .pill {
      flex: none; display: inline-flex; align-items: center; gap: 6px; min-height: 36px; padding: 0 12px; border-radius: var(--radius-pill);
      background: var(--s-6); border: 1px solid var(--s-8); color: var(--w-85); font-size: 11px; font-weight: 600; white-space: nowrap; cursor: pointer;
      transition: background var(--t-hover);
    }
    .pill:hover { background: var(--s-9); }
    .dot { width: 6px; height: 6px; border-radius: 50%; flex: none; }
    @media (pointer: coarse) { .pill { min-height: 44px; } }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PanelNavComponent {
  readonly items = input<PanelNavItem[]>([]);
  readonly label = input('');
  readonly selected = output<string>();
}
