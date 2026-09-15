import { computed, inject, Injectable, signal } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { filter } from 'rxjs';
import { AlertStore } from '@core/alert.store';
import { FeatureFlags } from '@core/feature-flags';
import { DEMO_BASE } from '@core/guards';
import { I18nKey, I18nService } from '@core/i18n.service';
import { SessionService } from '@core/session.service';
import { NAV_ICONS, NavIconKey } from '@i18n/nav-icons';

export interface NavItem {
  key: NavIconKey;
  labelKey: I18nKey;
  label: string;
  path: string;
  icon: string;
  badge: number;
  active: boolean;
}

/**
 * Navigasjonen (6.2, steg 3.3): Servers, (Containers bak flagget `containersPage`), Logs, Alerts, Settings.
 * Server- og containersider markerer «Servers». Varsel-badgen kommer fra AlertStore. I demoen (steg 10.1) ligger
 * stiene under `/demo`, og Alerts er borte (varsler og deling er skjult, FB 15.1).
 */
@Injectable({ providedIn: 'root' })
export class NavService {
  private readonly router = inject(Router);
  private readonly i18n = inject(I18nService);
  private readonly flags = inject(FeatureFlags);
  private readonly alerts = inject(AlertStore);
  private readonly session = inject(SessionService);

  private readonly url = signal(this.router.url);

  readonly items = computed<NavItem[]>(() => {
    const demo = this.session.demoMode();
    const base = demo ? DEMO_BASE : '';
    const url = demo ? stripBase(this.url(), DEMO_BASE) : this.url();
    const t = (k: I18nKey) => this.i18n.t(k);
    const items: NavItem[] = [
      { key: 'servers', labelKey: 'servers', label: t('servers'), path: base || '/', icon: NAV_ICONS.servers, badge: 0, active: isServersActive(url) },
    ];
    if (this.flags.containersPage() && !demo) {
      items.push({ key: 'containers', labelKey: 'containers', label: t('containers'), path: '/containers', icon: NAV_ICONS.containers, badge: 0, active: url.startsWith('/containers') });
    }
    items.push({ key: 'logs', labelKey: 'logs', label: t('logs'), path: `${base}/logs`, icon: NAV_ICONS.logs, badge: 0, active: url.startsWith('/logs') });
    if (!demo) {
      items.push({ key: 'alerts', labelKey: 'alerts', label: t('alerts'), path: '/alerts', icon: NAV_ICONS.alerts, badge: this.alerts.activeCount(), active: url.startsWith('/alerts') });
    }
    items.push({ key: 'settings', labelKey: 'settings', label: t('settings'), path: `${base}/settings`, icon: NAV_ICONS.settings, badge: 0, active: url.startsWith('/settings') });
    return items;
  });

  /** `--nav-count` for bunnlinjen: fire i MVP, fem med Containers. */
  readonly count = computed(() => this.items().length);

  constructor() {
    this.router.events
      .pipe(
        filter((e): e is NavigationEnd => e instanceof NavigationEnd),
        takeUntilDestroyed(),
      )
      .subscribe((e) => this.url.set(e.urlAfterRedirects));
  }
}

/** `/demo/servers/x` → `/servers/x`, `/demo` → `/`. */
export function stripBase(url: string, base: string): string {
  if (url === base || url.startsWith(`${base}?`)) return '/' + url.slice(base.length);
  return url.startsWith(`${base}/`) ? url.slice(base.length) : url;
}

/** `/`, `/servers/:id` og `/servers/:id/containers/:cid` markerer «Servers». */
export function isServersActive(url: string): boolean {
  const path = url.split('?')[0];
  return path === '/' || path === '' || path.startsWith('/servers');
}
