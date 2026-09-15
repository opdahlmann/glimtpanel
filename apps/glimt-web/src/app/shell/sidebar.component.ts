import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { SessionService } from '@core/session.service';
import { TPipe } from '@core/t.pipe';
import { LogoComponent } from '@shared/logo/logo.component';
import { LangSwitchComponent } from './lang-switch.component';
import { NavService } from './nav.service';
import { initials } from './initials';

/**
 * Sidepanelet på desktop (6.2): 220 px sticky, `--color-ink-2`, hårlinje til høyre, logo 28 + «Glimtpanel»/«by Kodetank»,
 * 44 px knapper med radius 10 (aktiv `--s-9` + hvit), rød varsel-badge, nederst språk, avatar med initialer og rolle.
 * I demoen (steg 10.1) står «Demo» som rolle og utloggingsknappen forlater demoen.
 */
@Component({
  selector: 'gp-sidebar',
  imports: [RouterLink, LogoComponent, LangSwitchComponent, TPipe],
  template: `
    <div class="brand">
      <gp-logo [size]="28" />
      <div>
        <div class="name">Glimtpanel</div>
        <div class="by">{{ 'byKodetank' | t }}</div>
      </div>
    </div>
    <nav>
      @for (n of nav.items(); track n.key) {
        <a [routerLink]="n.path" class="item" [class.on]="n.active" [attr.aria-current]="n.active ? 'page' : null">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path [attr.d]="n.icon" /></svg>
          <span class="label">{{ n.label }}</span>
          @if (n.badge > 0) {
            <span class="badge num">{{ n.badge }}</span>
          }
        </a>
      }
    </nav>
    <div class="spacer"></div>
    <div class="tools">
      <span class="tools-label">{{ 'language' | t }}</span>
      <gp-lang-switch />
    </div>
    <div class="user">
      <div class="avatar" aria-hidden="true">{{ initials() }}</div>
      <div class="who">
        <div class="uname">{{ session.user()?.name || session.user()?.email }}</div>
        <div class="role">{{ roleKey() | t }}</div>
      </div>
      <button type="button" class="out" (click)="signOut()" [attr.aria-label]="outKey() | t" [title]="outKey() | t">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9" /></svg>
      </button>
    </div>
  `,
  styles: `
    :host {
      width: var(--sidebar-w); flex: none; position: sticky; top: 0; align-self: flex-start; max-height: 100vh; min-height: 100vh;
      display: flex; flex-direction: column; gap: 8px; padding: 16px 12px; background: var(--color-ink-2);
      box-shadow: inset -.5px 0 0 var(--s-8); z-index: 2; overflow: hidden auto;
    }
    .brand { display: flex; align-items: center; gap: 10px; padding: 4px 8px 16px; }
    .name { font-size: 13px; font-weight: 600; letter-spacing: -.01em; }
    .by { font-size: 10px; color: var(--w-65); }
    nav { display: flex; flex-direction: column; gap: 2px; }
    .item {
      display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 0 10px; border-radius: var(--radius-card);
      font-size: 13px; font-weight: 600; color: var(--w-60); transition: background var(--t-hover), color var(--t-hover);
    }
    .item:hover { background: var(--s-9); color: var(--w-85); }
    .item.on { background: var(--s-9); color: var(--w-100); }
    .label { flex: 1; }
    .badge { font-size: 10px; font-weight: 600; background: var(--color-crit); color: #fff; border-radius: var(--radius-pill); padding: 2px 7px; }
    .spacer { flex: 1; }
    .tools { display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: 8px; }
    .tools-label { font-size: 11px; color: var(--w-60); }
    .user { display: flex; align-items: center; gap: 10px; padding: 8px; }
    .avatar { width: 32px; height: 32px; flex: none; border-radius: 50%; background: var(--s-8); display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 600; color: var(--w-85); }
    .who { min-width: 0; flex: 1; }
    .uname { font-size: 12px; font-weight: 600; color: var(--w-85); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .role { font-size: 10px; color: var(--w-45); }
    .out { width: 44px; height: 44px; margin: -6px -10px -6px 0; flex: none; border: 0; border-radius: var(--radius-card); background: transparent; color: var(--w-45); cursor: pointer; display: inline-flex; align-items: center; justify-content: center; }
    .out:hover { background: var(--s-9); color: var(--w-85); }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SidebarComponent {
  readonly nav = inject(NavService);
  readonly session = inject(SessionService);
  private readonly router = inject(Router);

  readonly initials = computed(() => initials(this.session.user()?.name, this.session.user()?.email));
  readonly roleKey = computed<'owner' | 'reader' | 'demo'>(() => (this.session.demoMode() ? 'demo' : this.session.ownsAnyServer() || !this.session.user()?.readerOf ? 'owner' : 'reader'));
  readonly outKey = computed<'signOut' | 'exitDemo'>(() => (this.session.demoMode() ? 'exitDemo' : 'signOut'));

  /** Innlogget: `POST /api/auth/logout`. I demoen: til innloggingen (guestGuard avslutter demoen). */
  signOut(): void {
    if (this.session.demoMode()) {
      void this.router.navigateByUrl('/login');
      return;
    }
    void this.session.logout();
  }
}
