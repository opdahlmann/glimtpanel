import { computed, inject, Injectable, signal } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { filter } from 'rxjs';
import { AlertStore } from '@core/alert.store';
import { FeatureFlags } from '@core/feature-flags';
import { I18nKey, I18nService } from '@core/i18n.service';
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
 * Server- og containersider markerer «Servers». Varsel-badgen kommer fra AlertStore.
 */
@Injectable({ providedIn: 'root' })
export class NavService {
  private readonly router = inject(Router);
  private readonly i18n = inject(I18nService);
  private readonly flags = inject(FeatureFlags);
  private readonly alerts = inject(AlertStore);

  private readonly url = signal(this.router.url);

  readonly items = computed<NavItem[]>(() => {
    const url = this.url();
    const t = (k: I18nKey) => this.i18n.t(k);
    const items: NavItem[] = [
      { key: 'servers', labelKey: 'servers', label: t('servers'), path: '/', icon: NAV_ICONS.servers, badge: 0, active: isServersActive(url) },
    ];
    if (this.flags.containersPage()) {
      items.push({ key: 'containers', labelKey: 'containers', label: t('containers'), path: '/containers', icon: NAV_ICONS.containers, badge: 0, active: url.startsWith('/containers') });
    }
    items.push(
      { key: 'logs', labelKey: 'logs', label: t('logs'), path: '/logs', icon: NAV_ICONS.logs, badge: 0, active: url.startsWith('/logs') },
      { key: 'alerts', labelKey: 'alerts', label: t('alerts'), path: '/alerts', icon: NAV_ICONS.alerts, badge: this.alerts.activeCount(), active: url.startsWith('/alerts') },
      { key: 'settings', labelKey: 'settings', label: t('settings'), path: '/settings', icon: NAV_ICONS.settings, badge: 0, active: url.startsWith('/settings') },
    );
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

/** `/`, `/servers/:id` og `/servers/:id/containers/:cid` markerer «Servers». */
export function isServersActive(url: string): boolean {
  const path = url.split('?')[0];
  return path === '/' || path === '' || path.startsWith('/servers');
}
