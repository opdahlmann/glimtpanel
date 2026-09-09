import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { NavService } from './nav.service';

/**
 * Bunnlinjen på mobil (6.2): sticky, `repeat(var(--nav-count), 1fr)`, 48 px faner med ikon 20 over 10 px tekst,
 * badge over varselfanen, `padding-bottom: calc(6px + env(safe-area-inset-bottom))`, `#16171bf2`.
 */
@Component({
  selector: 'gp-bottom-nav',
  imports: [RouterLink],
  template: `
    @for (n of nav.items(); track n.key) {
      <a [routerLink]="n.path" class="tab" [class.on]="n.active" [attr.aria-current]="n.active ? 'page' : null">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path [attr.d]="n.icon" /></svg>
        <span>{{ n.label }}</span>
        @if (n.badge > 0) {
          <span class="badge num">{{ n.badge }}</span>
        }
      </a>
    }
  `,
  host: { '[style.--nav-count]': 'nav.count()', role: 'navigation' },
  styles: `
    :host {
      position: sticky; bottom: 0; z-index: 6; display: grid; grid-template-columns: repeat(var(--nav-count, 4), 1fr);
      background: #16171bf2; backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); box-shadow: inset 0 .5px 0 var(--s-8);
      padding: 6px 4px calc(6px + env(safe-area-inset-bottom));
    }
    .tab {
      position: relative; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px; min-height: 48px;
      border-radius: var(--radius-card); color: var(--w-60); font-size: 10px; font-weight: 600;
    }
    .tab.on { color: var(--w-100); }
    .badge { position: absolute; top: 4px; right: calc(50% - 18px); font-size: 9px; font-weight: 600; background: var(--color-crit); color: #fff; border-radius: var(--radius-pill); padding: 1px 5px; }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BottomNavComponent {
  readonly nav = inject(NavService);
}
