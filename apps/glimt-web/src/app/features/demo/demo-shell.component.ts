import { ChangeDetectionStrategy, Component, computed, inject, OnDestroy, signal } from '@angular/core';
import { RouterLink, RouterOutlet } from '@angular/router';
import { AlertStore } from '@core/alert.store';
import { ConnectionService } from '@core/connection.service';
import { GroupsStore } from '@core/groups.store';
import { HistoryService } from '@core/history.service';
import { I18nService } from '@core/i18n.service';
import { LiveService } from '@core/live.service';
import { ServerListService } from '@core/server-list.service';
import { SessionService } from '@core/session.service';
import { TPipe } from '@core/t.pipe';
import { ButtonComponent } from '@shared/button/button.component';
import { ToastHostComponent } from '@shared/toast/toast-host.component';
import { BreakpointService } from '@shared/util/breakpoint.service';
import { BackdropComponent } from '../../shell/backdrop.component';
import { BottomNavComponent } from '../../shell/bottom-nav.component';
import { SidebarComponent } from '../../shell/sidebar.component';
import { TopbarComponent } from '../../shell/topbar.component';

/**
 * Demoen (steg 10.1, FB 15.1): hele dashbordet uten innlogging. Henter et demotoken fra `POST /api/demo/session` via
 * `SessionService.startDemo()`, viser banneret «Demo · fake servers · Create a free account» og ellers samme skall som
 * innlogget: sidepanel/topplinje, frakoblet-banner, bunnlinje og toast. Rollen er leser; varsler og deling finnes ikke
 * (NavService dropper Alerts, sidene skjuler eierknapper). Absolutte lenker fra sidene sendes tilbake under `/demo`
 * av authGuard. Når huben ikke kjører i demomodus (404) vises en forklaring med vei til innloggingen. Ved utgang gis
 * en eventuell ekte sesjon tilbake urørt.
 */
@Component({
  selector: 'gp-demo-shell',
  imports: [RouterOutlet, RouterLink, BackdropComponent, SidebarComponent, TopbarComponent, BottomNavComponent, ToastHostComponent, ButtonComponent, TPipe],
  template: `
    <a class="skip" href="#main" (click)="skip($event)">{{ 'skipToContent' | t }}</a>
    <gp-backdrop />
    @if (ready() && !isMobile()) {
      <gp-sidebar />
    }
    <div class="content">
      @if (ready() && isMobile()) {
        <gp-topbar />
      }
      <div class="demo" role="note" data-testid="demo-banner">
        <span class="tag">{{ 'demo' | t }}</span>
        <span class="sub">{{ 'fakeServers' | t }}</span>
        <a routerLink="/register" class="cta" data-testid="demo-create-account">{{ 'createFreeAccount' | t }} →</a>
      </div>
      @if (conn.offline()) {
        <div class="offline" role="status" aria-live="polite">
          <span class="dot" aria-hidden="true"></span>
          <span class="strong">{{ 'offline' | t }}</span>
          <span class="sub">{{ 'offlineSub' | t }} <span class="num">{{ frozenAt() }}</span> · {{ 'reconnect' | t }}</span>
          <gp-button class="btn" variant="ghost" size="sm" (click)="reconnect()">{{ 'reconnectBtn' | t }}</gp-button>
        </div>
      }
      <main id="main" tabindex="-1">
        @switch (state()) {
          @case ('ready') {
            <router-outlet />
          }
          @case ('unavailable') {
            <div class="unavailable" data-testid="demo-unavailable">
              <h1 class="title">{{ 'demo' | t }}</h1>
              <p class="note">{{ 'demoUnavailable' | t }}</p>
              <a routerLink="/login" class="link">{{ 'signIn' | t }}</a>
            </div>
          }
          @default {
            <p class="visually-hidden" role="status">{{ 'loading' | t }}</p>
          }
        }
      </main>
      @if (ready() && isMobile()) {
        <gp-bottom-nav />
      }
    </div>
    <gp-toast-host />
  `,
  styles: `
    :host { display: flex; min-height: 100dvh; position: relative; }
    .skip { position: absolute; left: 12px; top: -80px; z-index: 40; display: inline-flex; align-items: center; min-height: 44px; padding: 0 14px; border-radius: var(--radius-card); background: var(--w-100); color: var(--color-ink); font-size: 12px; font-weight: 600; text-decoration: none; transition: top var(--t-hover); }
    .skip:focus-visible { top: 12px; }
    main:focus { outline: none; }
    .content { flex: 1; min-width: 0; display: flex; flex-direction: column; z-index: 1; }
    main { flex: 1; padding: 24px 28px 40px; max-width: 100%; min-width: 0; }
    :host(.mobile) main { padding: 12px 12px 24px; }

    /* Det smale demobanneret: én linje, lenken får 44 px klikkflate uten å gjøre banneret høyt. */
    .demo {
      display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 12px 12px 0; padding: 0 12px; min-height: 36px;
      border-radius: var(--radius-card); background: color-mix(in srgb, var(--color-cpu) 10%, transparent);
      box-shadow: inset 0 0 0 .5px color-mix(in srgb, var(--color-cpu) 30%, transparent); font-size: 12px;
    }
    :host(:not(.mobile)) .demo { margin: 16px 28px 0; }
    .tag { font-weight: 700; color: var(--w-100); letter-spacing: .02em; text-transform: uppercase; font-size: 10px; }
    .sub { color: var(--w-60); }
    .cta { margin-left: auto; display: inline-flex; align-items: center; min-height: 44px; color: var(--color-cpu); font-weight: 600; text-decoration: none; white-space: nowrap; }
    .cta:hover { text-decoration: underline; }

    .offline {
      display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 12px 12px 0; padding: 10px 12px;
      border-radius: var(--radius-card); background: color-mix(in srgb, var(--color-crit) 8%, transparent);
      box-shadow: inset 0 0 0 .5px color-mix(in srgb, var(--color-crit) 25%, transparent); font-size: 12px;
      animation: pdIn var(--t-panel) var(--ease-out-expo);
    }
    :host(:not(.mobile)) .offline { margin: 16px 28px 0; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--color-crit); animation: blink 1.2s infinite; }
    .strong { font-weight: 600; color: var(--w-85); }
    .btn { margin-left: auto; }

    .unavailable { max-width: var(--page-max); display: flex; flex-direction: column; gap: 8px; }
    .title { margin: 0; font-size: 20px; font-weight: 700; letter-spacing: -.025em; }
    .note { margin: 0; font-size: 12px; color: var(--w-60); }
    .link { display: inline-flex; align-items: center; min-height: 44px; color: var(--color-cpu); font-size: 12px; font-weight: 600; text-decoration: none; }
  `,
  host: { '[class.mobile]': 'isMobile()' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DemoShell implements OnDestroy {
  private readonly session = inject(SessionService);
  private readonly live = inject(LiveService);
  private readonly serverList = inject(ServerListService);
  private readonly groups = inject(GroupsStore);
  private readonly alerts = inject(AlertStore);
  private readonly history = inject(HistoryService);
  private readonly i18n = inject(I18nService);
  readonly conn = inject(ConnectionService);

  readonly isMobile = inject(BreakpointService).isMobile;
  readonly state = signal<'loading' | 'ready' | 'unavailable'>('loading');
  readonly ready = computed(() => this.state() === 'ready');
  readonly frozenAt = computed(() => {
    const at = this.conn.frozenAt();
    return at ? this.i18n.formatClock(at) : '';
  });

  constructor() {
    void this.enter();
  }

  ngOnDestroy(): void {
    this.session.endDemo();
    this.forget();
  }

  /** Skip-lenken: fokuser innholdet uten å endre adressen. */
  skip(e: Event): void {
    e.preventDefault();
    document.getElementById('main')?.focus();
  }

  reconnect(): void {
    this.conn.reconnect();
  }

  /** Venter på oppstartens oppfriskning (så en ekte sesjon ikke kappes med demoen), henter demotokenet og åpner live-forbindelsen. */
  private async enter(): Promise<void> {
    await this.session.whenReady();
    try {
      await this.session.startDemo();
    } catch (err) {
      console.warn('[demo] no demo session', err);
      this.state.set('unavailable');
      return;
    }
    this.forget();
    this.live.start();
    this.state.set('ready');
  }

  /** Det som er lastet for en annen identitet (ekte bruker før demoen, demoen etterpå). */
  private forget(): void {
    this.serverList.clear();
    this.groups.clear();
    this.alerts.clear();
    this.history.clear();
  }
}
