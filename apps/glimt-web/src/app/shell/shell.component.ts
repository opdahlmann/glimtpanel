import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, NavigationEnd, Router, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs';
import { ConnectionService } from '@core/connection.service';
import { I18nService } from '@core/i18n.service';
import { LiveService } from '@core/live.service';
import { SessionService } from '@core/session.service';
import { TPipe } from '@core/t.pipe';
import { ButtonComponent } from '@shared/button/button.component';
import { ToastHostComponent } from '@shared/toast/toast-host.component';
import { BreakpointService } from '@shared/util/breakpoint.service';
import { BackdropComponent } from './backdrop.component';
import { BottomNavComponent } from './bottom-nav.component';
import { SidebarComponent } from './sidebar.component';
import { TopbarComponent } from './topbar.component';

/**
 * Layout-skallet (6.2, steg 3.3): bakgrunn, sidepanel på desktop, topplinje + bunnlinje på mobil (< 760 px målt på rot),
 * `<main>` med 24/28/40 px eller 12/12/24 px, frakoblet-banner og toast. Ruter med `data: { bottomNav: false }`
 * (`/welcome`) får ingen bunnlinje. Holder live-forbindelsen åpen så lenge man er innlogget.
 */
@Component({
  selector: 'gp-shell',
  imports: [RouterOutlet, BackdropComponent, SidebarComponent, TopbarComponent, BottomNavComponent, ToastHostComponent, ButtonComponent, TPipe],
  templateUrl: './shell.component.html',
  styleUrl: './shell.component.css',
  host: { '[class.mobile]': 'isMobile()' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ShellComponent {
  private readonly breakpoint = inject(BreakpointService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly session = inject(SessionService);
  private readonly live = inject(LiveService);
  readonly conn = inject(ConnectionService);
  readonly i18n = inject(I18nService);

  readonly isMobile = this.breakpoint.isMobile;
  private readonly bottomNav = signal(this.readBottomNav());
  readonly showBottomNav = computed(() => this.isMobile() && this.bottomNav());
  readonly frozenAt = computed(() => {
    const at = this.conn.frozenAt();
    return at ? this.i18n.formatClock(at) : '';
  });

  constructor() {
    this.router.events
      .pipe(
        filter((e) => e instanceof NavigationEnd),
        takeUntilDestroyed(),
      )
      .subscribe(() => this.bottomNav.set(this.readBottomNav()));
    effect(() => {
      const authed = this.session.isAuthenticated();
      untracked(() => {
        if (authed) this.live.start();
        else if (this.session.ready()) void this.router.navigate(['/login']);
      });
    });
  }

  reconnect(): void {
    this.conn.reconnect();
  }

  /** `data.bottomNav === false` på den dypeste aktive ruten skjuler bunnlinjen. */
  private readBottomNav(): boolean {
    let r: ActivatedRoute | null = this.route;
    let show = true;
    while (r) {
      if (r.snapshot?.data?.['bottomNav'] === false) show = false;
      r = r.firstChild;
    }
    return show;
  }
}
