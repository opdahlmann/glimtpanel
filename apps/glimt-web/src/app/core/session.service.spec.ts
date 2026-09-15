import { TestBed } from '@angular/core/testing';
import { I18nService } from './i18n.service';
import { LoginResponse } from './live.types';
import { PrefsService } from './prefs.service';
import { ApiError } from './api.service';
import { SessionService } from './session.service';

const user = { id: 'u1', email: 'dev@glimtpanel.local', name: 'Developer', timezone: 'Europe/Oslo', language: 'no', plan: 'beta', earlyAdopter: true, emailConfirmed: true };

function login(overrides: Partial<LoginResponse> = {}): LoginResponse {
  return { accessToken: 'tok', expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), user, ...overrides };
}

function json(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status });
}

/** Ruter mock-fetch på sti (etter /api). */
function routes(table: Record<string, (init: RequestInit) => Response | Promise<Response>>): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: string, init: RequestInit) => {
    const key = `${init.method} ${url.replace(/^\/api/, '')}`;
    const handler = table[key];
    if (!handler) throw new Error(`uventet kall ${key}`);
    return handler(init);
  });
}

/** jsdom uten opprinnelse har ikke alltid localStorage; PrefsService tåler det, og testene skal ikke lekke valg. */
function clearStorage(): void {
  try {
    globalThis.localStorage?.clear();
  } catch {
    // ingen lagring
  }
}

describe('SessionService', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    clearStorage();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function setup(table: Parameters<typeof routes>[0], hasSession = true): SessionService {
    fetchMock = routes(table);
    vi.stubGlobal('fetch', fetchMock);
    TestBed.configureTestingModule({});
    TestBed.inject(PrefsService).hasSession.set(hasSession);
    return TestBed.inject(SessionService);
  }

  it('oppstart: refresh (cookie) → /auth/me → innlogget og ready', async () => {
    const session = setup({
      'POST /auth/refresh': () => json(200, login()),
      'GET /auth/me': () => json(200, { ...user, ownsServers: true, readerOf: 0 }),
    });
    expect(session.ready()).toBe(false);
    session.start();
    await session.whenReady();
    expect(session.isAuthenticated()).toBe(true);
    expect(session.accessToken()).toBe('tok');
    expect(session.user()?.ownsServers).toBe(true);
    expect(session.ownsAnyServer()).toBe(true);
    // profilen setter språk og tidssone
    const i18n = TestBed.inject(I18nService);
    expect(i18n.lang()).toBe('no');
    expect(i18n.timeZone()).toBe('Europe/Oslo');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('oppstart uten cookie: 401 → ready uten bruker, ingen /auth/me', async () => {
    const session = setup({ 'POST /auth/refresh': () => json(401, { title: 'Unauthorized' }) });
    session.start();
    await session.whenReady();
    expect(session.ready()).toBe(true);
    expect(session.isAuthenticated()).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('førstegangsbesøk (ingen tidligere sesjon) hopper over refresh og er ready straks', async () => {
    const session = setup({}, false);
    session.start();
    await session.whenReady();
    expect(session.isAuthenticated()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('whenReady starter oppstarten selv om start() ikke er kalt', async () => {
    const session = setup({ 'POST /auth/refresh': () => json(401) });
    await session.whenReady();
    expect(session.ready()).toBe(true);
  });

  it('login setter sesjonen og laster /auth/me; logout tømmer den', async () => {
    const session = setup({
      'POST /auth/refresh': () => json(401),
      'POST /auth/login': (init) => {
        expect(JSON.parse(String(init.body))).toEqual({ email: 'dev@glimtpanel.local', password: 'GlimtDev-2026!' });
        expect((init.headers as Record<string, string>)['authorization']).toBeUndefined();
        return json(200, login());
      },
      'GET /auth/me': () => json(200, { ...user, ownsServers: false, readerOf: 2 }),
      'POST /auth/logout': () => json(204),
    });
    await session.whenReady();
    await session.login('dev@glimtpanel.local', 'GlimtDev-2026!');
    expect(session.isAuthenticated()).toBe(true);
    await vi.waitFor(() => expect(session.user()?.readerOf).toBe(2));
    expect(TestBed.inject(PrefsService).hasSession.value()).toBe(true);
    await session.logout();
    expect(session.isAuthenticated()).toBe(false);
    expect(session.user()).toBeNull();
    expect(session.accessToken()).toBeNull();
    expect(TestBed.inject(PrefsService).hasSession.value()).toBe(false);
  });

  it('oppfrisker 60 s før utløp', async () => {
    vi.useFakeTimers();
    let refreshes = 0;
    const session = setup({
      'POST /auth/refresh': () => {
        refreshes++;
        return json(200, login({ accessToken: `tok-${refreshes}`, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() }));
      },
      'GET /auth/me': () => json(200, user),
    });
    session.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(session.accessToken()).toBe('tok-1');
    await vi.advanceTimersByTimeAsync(4 * 60_000 - 1000);
    expect(refreshes).toBe(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(refreshes).toBe(2);
    expect(session.accessToken()).toBe('tok-2');
  });

  it('demo (steg 10.1): startDemo henter demotoken uten å røre den ekte sesjonen, rollen er leser, endDemo gir den tilbake', async () => {
    const demoUser = { ...user, id: 'demo', email: 'demo@glimtpanel.com', name: 'Demo' };
    let demoTokens = 0;
    const session = setup({
      'POST /auth/refresh': () => json(200, login()),
      'GET /auth/me': () => json(200, { ...user, ownsServers: true }),
      'POST /demo/session': (init) => {
        expect((init.headers as Record<string, string>)['authorization']).toBeUndefined();
        demoTokens++;
        return json(200, login({ accessToken: `demo-${demoTokens}`, expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(), user: demoUser }));
      },
    });
    session.start();
    await session.whenReady();
    await vi.waitFor(() => expect(session.user()?.ownsServers).toBe(true));
    session.setServerRoles([['a', 'owner']]);

    await session.startDemo();
    expect(session.demoMode()).toBe(true);
    expect(session.accessToken()).toBe('demo-1');
    expect(session.user()?.email).toBe('demo@glimtpanel.com');
    expect(session.isAuthenticated()).toBe(true);
    expect(session.ownsAnyServer()).toBe(false);
    session.setServerRoles([['a', 'owner']]);
    expect(session.isOwnerOf('a')).toBe(false);
    expect(await session.loadMe()).toBeNull();
    // Oppfriskning i demoen henter et nytt demotoken, ikke /auth/refresh.
    expect(await session.refresh()).toBe(true);
    expect(session.accessToken()).toBe('demo-2');
    // logout i demoen er endDemo: den ekte sesjonen står som før.
    await session.logout();
    expect(session.demoMode()).toBe(false);
    expect(session.accessToken()).toBe('tok');
    expect(session.user()?.email).toBe('dev@glimtpanel.local');
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/auth/logout'))).toHaveLength(0);
    expect(TestBed.inject(PrefsService).hasSession.value()).toBe(true);
  });

  it('demo uten ekte sesjon: uinnlogget etter endDemo, og 404 fra huben kaster', async () => {
    const session = setup({ 'POST /demo/session': () => json(404, { title: 'Not found' }) }, false);
    await session.whenReady();
    await expect(session.startDemo()).rejects.toBeInstanceOf(ApiError);
    expect(session.demoMode()).toBe(false);
    expect(session.isAuthenticated()).toBe(false);
    session.endDemo();
    expect(TestBed.inject(PrefsService).hasSession.value()).toBe(false);
  });

  it('isOwnerOf leser rollekartet', async () => {
    const session = setup({ 'POST /auth/refresh': () => json(401) });
    session.setServerRoles([
      ['a', 'owner'],
      ['b', 'reader'],
    ]);
    expect(session.isOwnerOf('a')).toBe(true);
    expect(session.isOwnerOf('b')).toBe(false);
    expect(session.isOwnerOf('c')).toBe(false);
    expect(session.ownsAnyServer()).toBe(true);
  });
});
