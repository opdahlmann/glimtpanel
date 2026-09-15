import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { AlertStore } from '@core/alert.store';
import { ConfigService, DEFAULT_CONFIG } from '@core/config.service';
import { I18nService } from '@core/i18n.service';
import { SessionService } from '@core/session.service';
import { isServersActive, NavService, stripBase } from './nav.service';
import { initials } from './initials';

/** jsdom uten opprinnelse har ikke alltid localStorage; PrefsService tåler det, og testene skal ikke lekke valg. */
function clearStorage(): void {
  try {
    globalThis.localStorage?.clear();
  } catch {
    // ingen lagring
  }
}

describe('NavService', () => {
  let config: { config: ReturnType<typeof signal<typeof DEFAULT_CONFIG>> };
  let session: { demoMode: ReturnType<typeof signal<boolean>>; isAuthenticated: ReturnType<typeof signal<boolean>> };

  beforeEach(() => {
    clearStorage();
    config = { config: signal({ ...DEFAULT_CONFIG }) };
    session = { demoMode: signal(false), isAuthenticated: signal(false) };
    TestBed.configureTestingModule({
      providers: [provideRouter([{ path: '**', children: [] }]), { provide: ConfigService, useValue: config }, { provide: SessionService, useValue: session }],
    });
  });

  it('har fire elementer i MVP, fem med flagget containersPage', () => {
    const nav = TestBed.inject(NavService);
    expect(nav.items().map((i) => i.key)).toEqual(['servers', 'logs', 'alerts', 'settings']);
    expect(nav.count()).toBe(4);
    config.config.set({ ...DEFAULT_CONFIG, featureFlags: ['containersPage'] });
    expect(nav.items().map((i) => i.key)).toEqual(['servers', 'containers', 'logs', 'alerts', 'settings']);
    expect(nav.count()).toBe(5);
  });

  it('markerer Servers på server- og containersider, og følger navigasjonen', async () => {
    const nav = TestBed.inject(NavService);
    const router = TestBed.inject(Router);
    expect(nav.items()[0].active).toBe(true);
    await router.navigateByUrl('/servers/a/containers/b');
    expect(nav.items().find((i) => i.key === 'servers')?.active).toBe(true);
    await router.navigateByUrl('/alerts');
    expect(nav.items().find((i) => i.key === 'servers')?.active).toBe(false);
    expect(nav.items().find((i) => i.key === 'alerts')?.active).toBe(true);
  });

  it('badge fra AlertStore og etiketter fra ordboken', () => {
    const nav = TestBed.inject(NavService);
    TestBed.inject(AlertStore).setActiveCount(3);
    expect(nav.items().find((i) => i.key === 'alerts')?.badge).toBe(3);
    TestBed.inject(I18nService).setLang('no');
    expect(nav.items().map((i) => i.label)).toEqual(['Servere', 'Logger', 'Varsler', 'Innstillinger']);
  });

  it('demoen (steg 10.1): Servers, Logs og Settings under /demo, uten Alerts og Containers', async () => {
    const nav = TestBed.inject(NavService);
    const router = TestBed.inject(Router);
    config.config.set({ ...DEFAULT_CONFIG, featureFlags: ['containersPage'] });
    session.demoMode.set(true);
    expect(nav.items().map((i) => [i.key, i.path])).toEqual([
      ['servers', '/demo'],
      ['logs', '/demo/logs'],
      ['settings', '/demo/settings'],
    ]);
    expect(nav.count()).toBe(3);
    await router.navigateByUrl('/demo/servers/demo-web-02');
    expect(nav.items().find((i) => i.key === 'servers')?.active).toBe(true);
    await router.navigateByUrl('/demo/logs?server=demo-web-02');
    expect(nav.items().find((i) => i.key === 'logs')?.active).toBe(true);
    expect(nav.items().find((i) => i.key === 'servers')?.active).toBe(false);
    expect(stripBase('/demo', '/demo')).toBe('/');
    expect(stripBase('/demo?group=x', '/demo')).toBe('/?group=x');
    expect(stripBase('/demo/logs', '/demo')).toBe('/logs');
    expect(stripBase('/demonstration', '/demo')).toBe('/demonstration');
  });

  it('isServersActive og initials', () => {
    expect(isServersActive('/')).toBe(true);
    expect(isServersActive('/servers/x?tab=cpu')).toBe(true);
    expect(isServersActive('/settings/servers')).toBe(false);
    expect(initials('Ole Petter Dahlmann')).toBe('OD');
    expect(initials('Developer')).toBe('DE');
    expect(initials('', 'dev@glimtpanel.local')).toBe('D');
    expect(initials(null)).toBe('?');
  });
});
