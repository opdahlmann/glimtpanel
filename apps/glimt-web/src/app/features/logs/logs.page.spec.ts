import { signal, computed } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, provideRouter, Router } from '@angular/router';
import { ActivityMode, ActivityService } from '@core/activity.service';
import { ApiService } from '@core/api.service';
import { LiveService, LogHandlers } from '@core/live.service';
import { LiveState, LogRequest, ServerListItem } from '@core/live.types';
import { ServerListService } from '@core/server-list.service';
import { SessionService } from '@core/session.service';
import { TitleService } from '../../shell/title.service';
import { demoServer } from '../server/server.fixtures';
import { FILTER_DEBOUNCE_MS, hubSource, linesToText, LogsPage, matchesFilter, uiSource } from './logs.page';

class LiveStub {
  readonly state = signal<LiveState>('connected');
  started: { req: LogRequest; handlers: LogHandlers; id: string }[] = [];
  stopped: string[] = [];
  private n = 0;
  readonly startLog = vi.fn(async (req: LogRequest, handlers: LogHandlers) => {
    const id = `s${++this.n}`;
    this.started.push({ req, handlers, id });
    return id;
  });
  readonly stopLog = vi.fn(async (id: string) => {
    this.stopped.push(id);
  });
}

class ServerListStub {
  readonly byId = computed(() => new Map(this.servers().map((s) => [s.id, s])));
  readonly servers = signal<ServerListItem[]>([
    { id: 'demo-web-02', name: 'web-02', hostname: 'web-02', tags: [], status: 'up', lastSeenAt: null, role: 'owner' },
    { id: 'demo-worker-01', name: 'worker-01', hostname: 'worker-01', tags: [], status: 'up', lastSeenAt: null, role: 'owner' },
  ]);
  readonly loaded = signal(true);
  readonly load = vi.fn(() => Promise.resolve([] as ServerListItem[]));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('LogsPage', () => {
  let live: LiveStub;
  let api: { get: ReturnType<typeof vi.fn> };
  let router: Router;

  beforeEach(async () => {
    live = new LiveStub();
    api = { get: vi.fn(() => Promise.resolve(demoServer())) };
    await TestBed.configureTestingModule({
      imports: [LogsPage],
      providers: [
        provideRouter([]),
        { provide: ActivatedRoute, useValue: {} },
        { provide: LiveService, useValue: live },
        { provide: ActivityService, useValue: { mode: signal<ActivityMode>('active') } },
        { provide: ServerListService, useValue: new ServerListStub() },
        { provide: SessionService, useValue: { isAuthenticated: signal(true), user: signal(null) } },
        { provide: ApiService, useValue: api },
      ],
    }).compileComponents();
    router = TestBed.inject(Router);
    vi.spyOn(router, 'navigate').mockResolvedValue(true);
  });

  async function render(params: Record<string, string> = {}) {
    const fixture = TestBed.createComponent(LogsPage);
    for (const [k, v] of Object.entries(params)) fixture.componentRef.setInput(k, v);
    await fixture.whenStable();
    await sleep(0);
    return { fixture, el: fixture.nativeElement as HTMLElement, page: fixture.componentInstance };
  }

  it('uten parametre: første server, journal, 1 t, tail 200; tittelen er Logs', async () => {
    const { el } = await render();
    expect(TestBed.inject(TitleService).title()).toBe('Logs');
    expect(live.startLog).toHaveBeenCalledTimes(1);
    const req = live.started[0].req;
    expect(req).toMatchObject({ serverId: 'demo-web-02', source: 'journal', unit: null, priority: null, tail: 200 });
    expect(Date.now() - (req.sinceMs ?? 0)).toBeGreaterThanOrEqual(3_600_000 - 1000);
    expect(el.querySelectorAll('.sources [role="radio"]').length).toBe(7);
    expect(el.querySelector('.sources [aria-checked="true"]')?.textContent).toBe('System');
    expect(el.querySelector('.hint')?.textContent).toBe('journald: kernel, sshd, systemd units, sudo, cron');
    expect(el.querySelector('[data-testid="log-status"]')?.textContent).toContain('streaming · nothing is stored');
  });

  it('dyplenke fra en feilet tjeneste: server, journal og unit havner i forespørselen, enhetsfilteret vises som chip', async () => {
    const { el } = await render({ server: 'demo-worker-01', source: 'journal', unit: 'cron-sync.service', priority: 'err', range: '24h' });
    expect(live.started[0].req).toMatchObject({ serverId: 'demo-worker-01', source: 'journal', unit: 'cron-sync.service', priority: 'err' });
    expect(Date.now() - (live.started[0].req.sinceMs ?? 0)).toBeGreaterThanOrEqual(86_400_000 - 1000);
    expect(el.querySelector('.hintrow .chip')?.textContent).toContain('Unit · cron-sync.service');
    expect(el.querySelector('.priority [aria-checked="true"]')?.textContent).toBe('Errors');
    expect(el.querySelector('.range [aria-checked="true"]')?.textContent).toBe('24 h');
  });

  it('bytte av kilde og prioritet går via URL-en', async () => {
    const { page } = await render();
    page.onSource('auth');
    expect(router.navigate).toHaveBeenLastCalledWith([], expect.objectContaining({ queryParams: { source: 'auth' }, replaceUrl: true }));
    page.onPriority('warn');
    expect(router.navigate).toHaveBeenLastCalledWith([], expect.objectContaining({ queryParams: { priority: 'warn' } }));
    page.onRange('1h');
    expect(router.navigate).toHaveBeenLastCalledWith([], expect.objectContaining({ queryParams: {} }));
    page.onServer('demo-worker-01');
    expect(router.navigate).toHaveBeenLastCalledWith([], expect.objectContaining({ queryParams: { server: 'demo-worker-01' } }));
  });

  it('tekstfilteret filtrerer det som er lastet etter 100 ms og skrives til URL-en', async () => {
    const { fixture, page, el } = await render();
    live.started[0].handlers.lines(
      [
        { ts: 1, unit: 'sshd', container: null, priority: 'warn', message: 'Failed password for admin' },
        { ts: 2, unit: 'cron', container: null, priority: 'info', message: 'run backup' },
      ],
      null,
    );
    await fixture.whenStable();
    expect(el.querySelectorAll('gp-log-view .line').length).toBe(2);
    page.onFilter('sshd');
    expect(page.filtered().length).toBe(2);
    await sleep(FILTER_DEBOUNCE_MS + 20);
    expect(page.filtered().length).toBe(1);
    expect(router.navigate).toHaveBeenLastCalledWith([], expect.objectContaining({ queryParams: { q: 'sshd' } }));
    expect(page.countText()).toBe('1 lines');
  });

  it('containere: chips fra snapshot, én strøm per valgt container, farge per container, side om side', async () => {
    const { fixture, el, page } = await render({ server: 'demo-web-02', source: 'container', container: 'web-web,web-api' });
    await fixture.whenStable();
    expect(api.get).toHaveBeenCalledWith('/servers/demo-web-02/snapshot');
    expect(live.startLog).toHaveBeenCalledTimes(2);
    expect(live.started.map((s) => s.req.container)).toEqual(['web-web', 'web-api']);
    expect(el.querySelectorAll('[data-testid="container-chips"] .chip').length).toBe(4);
    expect(el.querySelectorAll('[data-testid="container-chips"] .chip.on').length).toBe(2);
    expect(page.containerColor('web-web')).toBe('var(--color-cpu)');
    expect(page.containerColor('web-api')).toBe('var(--color-ram)');
    expect(page.showLayout()).toBe(true);
    page.layout.set('side');
    await fixture.whenStable();
    expect(el.querySelectorAll('.columns .column').length).toBe(2);
    page.toggleContainer('web-cron');
    expect(router.navigate).toHaveBeenLastCalledWith([], expect.objectContaining({ queryParams: { server: 'demo-web-02', source: 'container', container: 'web-web,web-api,web-cron' } }));
    page.toggleContainer('web-api');
    expect(router.navigate).toHaveBeenLastCalledWith([], expect.objectContaining({ queryParams: { server: 'demo-web-02', source: 'container', container: 'web-web' } }));
  });

  it('pause/resume og «Copy lines» kopierer de nyeste', async () => {
    const { fixture, page } = await render();
    live.started[0].handlers.lines([{ ts: Date.UTC(2026, 8, 10, 6, 14, 5), unit: 'sshd', container: null, priority: 'info', message: 'hello' }], null);
    page.togglePause();
    expect(page.pauseLabel()).toBe('Resume');
    live.started[0].handlers.lines([{ ts: 2, unit: 'cron', container: null, priority: 'info', message: 'later' }], null);
    expect(page.pauseLabel()).toBe('Resume · 1');
    page.togglePause();
    expect(page.pauseLabel()).toBe('Pause');
    await fixture.whenStable();
    expect(linesToText(page.filtered(), 'Europe/Oslo').split('\n')[0]).toBe('01:00:00 cron: later');
    expect(linesToText(page.filtered(), 'Europe/Oslo').split('\n')[1]).toBe('08:14:05 sshd: hello');
  });

  it('alle strømmer stoppes når siden forlates', async () => {
    const { fixture } = await render({ server: 'demo-web-02', source: 'container', container: 'web-web,web-api' });
    await fixture.whenStable();
    fixture.destroy();
    expect(live.stopped.sort()).toEqual(['s1', 's2']);
  });

  it('hjelpere: kildekart og filter', () => {
    expect(hubSource('kern')).toBe('kernel');
    expect(hubSource('firewall')).toBe('firewall');
    expect(hubSource(undefined)).toBe('journal');
    expect(uiSource('packages')).toBe('pkg');
    expect(uiSource('nope')).toBe('system');
    expect(matchesFilter({ ts: 1, unit: 'sshd', message: 'Failed', priority: 'warn' }, 'SSH')).toBe(true);
    expect(matchesFilter({ ts: 1, container: 'web-db', message: 'x' }, 'db')).toBe(true);
    expect(matchesFilter({ ts: 1, message: 'x' }, 'y')).toBe(false);
    expect(matchesFilter({ ts: 1, message: '', dropped: 3 }, 'y')).toBe(true);
  });
});
