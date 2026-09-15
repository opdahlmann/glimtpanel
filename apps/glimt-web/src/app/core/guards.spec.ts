import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRouteSnapshot, convertToParamMap, Route, Router, RouterStateSnapshot, UrlSegment, UrlTree } from '@angular/router';
import { ConfigService, DEFAULT_CONFIG } from './config.service';
import { authGuard, authShellMatch, demoUrl, devGuard, guestGuard, ownerGuard, safeNext } from './guards';
import { SessionService } from './session.service';

function snapshot(params: Record<string, string> = {}, query: Record<string, string> = {}): ActivatedRouteSnapshot {
  return { paramMap: convertToParamMap(params), queryParamMap: convertToParamMap(query), parent: null } as unknown as ActivatedRouteSnapshot;
}

function state(url: string): RouterStateSnapshot {
  return { url } as RouterStateSnapshot;
}

describe('guards', () => {
  let session: {
    ready: ReturnType<typeof signal<boolean>>;
    isAuthenticated: ReturnType<typeof signal<boolean>>;
    whenReady: ReturnType<typeof vi.fn>;
    isOwnerOf: ReturnType<typeof vi.fn>;
    ownsAnyServer: ReturnType<typeof signal<boolean>>;
    demoMode: ReturnType<typeof signal<boolean>>;
    endDemo: ReturnType<typeof vi.fn>;
  };
  let config: { config: ReturnType<typeof signal<typeof DEFAULT_CONFIG>> };
  let router: Router;

  beforeEach(() => {
    session = {
      ready: signal(true),
      isAuthenticated: signal(false),
      whenReady: vi.fn().mockResolvedValue(undefined),
      isOwnerOf: vi.fn().mockReturnValue(false),
      ownsAnyServer: signal(false),
      demoMode: signal(false),
      endDemo: vi.fn(),
    };
    config = { config: signal({ ...DEFAULT_CONFIG }) };
    TestBed.configureTestingModule({
      providers: [
        { provide: SessionService, useValue: session },
        { provide: ConfigService, useValue: config },
      ],
    });
    router = TestBed.inject(Router);
  });

  const run = <T>(fn: () => T): T => TestBed.runInInjectionContext(fn);

  it('authGuard venter på ready og sender uinnloggede til /login?next=', async () => {
    const result = await run(() => authGuard(snapshot(), state('/servers/x')));
    expect(session.whenReady).toHaveBeenCalled();
    expect(result).toBeInstanceOf(UrlTree);
    expect(router.serializeUrl(result as UrlTree)).toBe('/login?next=%2Fservers%2Fx');
  });

  it('authGuard uten next for roten, og true når innlogget', async () => {
    const tree = (await run(() => authGuard(snapshot(), state('/')))) as UrlTree;
    expect(router.serializeUrl(tree)).toBe('/login');
    session.isAuthenticated.set(true);
    expect(await run(() => authGuard(snapshot(), state('/')))).toBe(true);
  });

  it('authGuard i demoen (steg 10.1) sender absolutte lenker under /demo', async () => {
    session.isAuthenticated.set(true);
    session.demoMode.set(true);
    const tree = (await run(() => authGuard(snapshot(), state('/servers/demo-web-02?tab=cpu')))) as UrlTree;
    expect(router.serializeUrl(tree)).toBe('/demo/servers/demo-web-02?tab=cpu');
    expect(router.serializeUrl((await run(() => authGuard(snapshot(), state('/')))) as UrlTree)).toBe('/demo');
    expect(demoUrl('/demo/logs')).toBe('/demo/logs');
    expect(demoUrl('/demo')).toBe('/demo');
    expect(demoUrl('')).toBe('/demo');
    expect(demoUrl('/logs?server=x')).toBe('/demo/logs?server=x');
  });

  it('guestGuard avslutter demoen («Create a free account»)', async () => {
    session.demoMode.set(true);
    expect(await run(() => guestGuard(snapshot(), state('/register')))).toBe(true);
    expect(session.endDemo).toHaveBeenCalled();
  });

  it('guestGuard slipper gjennom uinnloggede og sender innloggede til / eller next', async () => {
    expect(await run(() => guestGuard(snapshot(), state('/login')))).toBe(true);
    session.isAuthenticated.set(true);
    const tree = (await run(() => guestGuard(snapshot({}, { next: '/logs' }), state('/login')))) as UrlTree;
    expect(router.serializeUrl(tree)).toBe('/logs');
    const root = (await run(() => guestGuard(snapshot({}, { next: 'https://evil.example' }), state('/login')))) as UrlTree;
    expect(router.serializeUrl(root)).toBe('/');
  });

  it('ownerGuard krever eier av :id', async () => {
    session.isAuthenticated.set(true);
    session.isOwnerOf.mockImplementation((id: string) => id === 'mine');
    expect(await run(() => ownerGuard(snapshot({ id: 'mine' }), state('/x')))).toBe(true);
    const tree = (await run(() => ownerGuard(snapshot({ id: 'theirs' }), state('/x')))) as UrlTree;
    expect(router.serializeUrl(tree)).toBe('/');
  });

  it('devGuard slipper gjennom i development og e2e, ikke i production', () => {
    expect(run(() => devGuard(snapshot(), state('/dev/components')))).toBe(true);
    config.config.set({ ...DEFAULT_CONFIG, env: 'e2e' });
    expect(run(() => devGuard(snapshot(), state('/dev/components')))).toBe(true);
    config.config.set({ ...DEFAULT_CONFIG, env: 'production' });
    expect(run(() => devGuard(snapshot(), state('/dev/components')))).toBeInstanceOf(UrlTree);
  });

  it('authShellMatch matcher bare auth-stiene, ikke roten', () => {
    const match = (url: string) =>
      run(() => authShellMatch({} as Route, url.split('/').filter(Boolean).map((p) => new UrlSegment(p, {})), {} as never));
    expect(match('/login')).toBe(true);
    expect(match('/confirm')).toBe(true);
    expect(match('/')).toBe(false);
    expect(match('/servers/x')).toBe(false);
  });

  it('safeNext godtar bare interne stier', () => {
    expect(safeNext('/servers/a?x=1')).toBe('/servers/a?x=1');
    expect(safeNext('//evil.example')).toBe('/');
    expect(safeNext('https://evil.example')).toBe('/');
    expect(safeNext(null)).toBe('/');
  });
});
