import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Router } from '@angular/router';
import { ConnectionService } from '@core/connection.service';
import { SessionService } from '@core/session.service';
import { TPipe } from '@core/t.pipe';
import { LiveDotComponent } from '@shared/live-dot/live-dot.component';
import { LogoComponent } from '@shared/logo/logo.component';
import { LangSwitchComponent } from './lang-switch.component';
import { TitleService } from './title.service';

/** Topplinjen på mobil (6.2): sticky 44 px, `#0f1013e6` + blur 20, logo 24, sidetittel 12 px 600, språk og live-prikk til høyre. */
@Component({
  selector: 'gp-topbar',
  imports: [LogoComponent, LiveDotComponent, LangSwitchComponent, TPipe],
  template: `
    <div class="left">
      <gp-logo [size]="24" />
      <span class="title">{{ title.title() }}</span>
    </div>
    <div class="right">
      <gp-lang-switch />
      <span class="live" [class.off]="conn.offline()">
        <span>{{ (conn.offline() ? 'offline' : 'liveLabel') | t }}</span>
        <gp-live-dot [state]="dot()" />
      </span>
      <button type="button" class="out" (click)="signOut()" [attr.aria-label]="outKey() | t">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9" /></svg>
      </button>
    </div>
  `,
  styles: `
    :host {
      display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 44px; padding: 0 2px 0 12px;
      position: sticky; top: 0; z-index: 6; background: #0f1013e6; backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
      box-shadow: inset 0 -.5px 0 var(--s-8);
    }
    .left, .right { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .title { font-size: 12px; font-weight: 600; color: var(--w-85); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .live { display: inline-flex; align-items: center; gap: 5px; font-size: 10px; color: var(--w-45); white-space: nowrap; }
    .live.off { color: var(--color-crit); }
    .out { width: 44px; height: 44px; flex: none; border: 0; background: transparent; color: var(--w-45); cursor: pointer; display: inline-flex; align-items: center; justify-content: center; border-radius: var(--radius-card); }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TopbarComponent {
  readonly title = inject(TitleService);
  readonly conn = inject(ConnectionService);
  private readonly session = inject(SessionService);
  private readonly router = inject(Router);

  readonly dot = computed(() => (this.conn.offline() ? 'down' : this.conn.state() === 'connected' ? 'up' : 'connecting'));
  readonly outKey = computed<'signOut' | 'exitDemo'>(() => (this.session.demoMode() ? 'exitDemo' : 'signOut'));

  signOut(): void {
    if (this.session.demoMode()) {
      void this.router.navigateByUrl('/login');
      return;
    }
    void this.session.logout();
  }
}
