import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { ApiError, ApiService } from '@core/api.service';
import { HistoryService } from '@core/history.service';
import { LiveService } from '@core/live.service';
import { LiveStore } from '@core/live.store';
import { LiveState, ServerListItem, UserDto } from '@core/live.types';
import { PrefsService } from '@core/prefs.service';
import { ServerListService } from '@core/server-list.service';
import { SessionService } from '@core/session.service';
import { TitleService } from '../../shell/title.service';
import { ServerPage } from './server.page';
import { demoDownServer, demoServer } from './server.fixtures';

class LiveServiceStub {
  readonly state = signal<LiveState>('connected');
  readonly unsubscribe = vi.fn();
  readonly subscribeServer = vi.fn(() => this.unsubscribe);
  readonly startLog = vi.fn(() => new Promise<string>(() => undefined));
  readonly stopLog = vi.fn(() => Promise.resolve());
}

class SessionStub {
  readonly user = signal<UserDto | null>(null);
  readonly isAuthenticated = signal(true);
  readonly ownsAnyServer = signal(true);
  readonly demoMode = signal(false);
  roles = new Map<string, 'owner' | 'reader'>([['demo-web-02', 'owner']]);
  isOwnerOf(id: string): boolean {
    return this.roles.get(id) === 'owner';
  }
  setServerRoles = vi.fn();
}

class ServerListStub {
  readonly servers = signal<ServerListItem[]>([]);
  readonly loaded = signal(true);
  readonly byId = signal(new Map<string, ServerListItem>());
  readonly load = vi.fn(() => Promise.resolve([] as ServerListItem[]));
}

function clearStorage(): void {
  try {
    globalThis.localStorage?.clear();
  } catch {
    // ingen lagring
  }
}

describe('ServerPage', () => {
  let live: LiveServiceStub;
  let session: SessionStub;
  let serverList: ServerListStub;
  let store: LiveStore;
  let api: { get: ReturnType<typeof vi.fn> };
  let history: { get: ReturnType<typeof vi.fn> };
  let fragment: string | null;

  async function setup(): Promise<void> {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [ServerPage],
      providers: [
        provideRouter([]),
        { provide: ActivatedRoute, useValue: { fragment: of(fragment), snapshot: { fragment } } },
        { provide: LiveService, useValue: live },
        { provide: SessionService, useValue: session },
        { provide: ServerListService, useValue: serverList },
        { provide: ApiService, useValue: api },
        { provide: HistoryService, useValue: history },
      ],
    }).compileComponents();
    store = TestBed.inject(LiveStore);
  }

  beforeEach(async () => {
    clearStorage();
    fragment = null;
    live = new LiveServiceStub();
    session = new SessionStub();
    serverList = new ServerListStub();
    api = { get: vi.fn(() => Promise.resolve(undefined)) };
    history = { get: vi.fn(() => Promise.resolve({ metric: 'cpu', range: '1h', stepMs: 30_000, from: 0, to: 0, values: [] })) };
    await setup();
  });

  async function render(id = 'demo-web-02') {
    const fixture = TestBed.createComponent(ServerPage);
    fixture.componentRef.setInput('id', id);
    await fixture.whenStable();
    return { fixture, el: fixture.nativeElement as HTMLElement, page: fixture.componentInstance };
  }

  it('abonnerer på serveren, henter snapshot og 1 t-historikk, og avmelder ved destroy', async () => {
    const { fixture } = await render();
    expect(live.subscribeServer).toHaveBeenCalledWith('demo-web-02');
    expect(api.get).toHaveBeenCalledWith('/servers/demo-web-02/snapshot');
    expect(history.get).toHaveBeenCalledWith('demo-web-02', 'cpu', '1h');
    expect(history.get).toHaveBeenCalledWith('demo-web-02', 'mem', '1h');
    fixture.destroy();
    expect(live.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('snapshot-svaret tegner siden før strømmen; tittel, topp og ti paneler', async () => {
    api.get.mockImplementation((path: string) => Promise.resolve(path.endsWith('/snapshot') ? demoServer() : undefined));
    const { fixture, el } = await render();
    await fixture.whenStable();
    expect(TestBed.inject(TitleService).title()).toBe('web-02');
    expect(el.querySelector('h1')?.textContent).toBe('web-02');
    expect(el.querySelector('[data-testid="status"]')?.textContent?.trim()).toBe('live');
    expect(el.querySelector('[data-testid="info"]')?.textContent).toBe('Ubuntu 24.04 · 6.8.0-45-generic · 4 cores · 8 GB');
    expect(el.querySelectorAll('gp-panel').length).toBe(10);
    expect(el.querySelector('#panel-cpu .meta')?.textContent).toBe('48% · 1.9 of 4 cores');
    expect(el.querySelector('gp-panel-nav')).not.toBeNull();
    expect(el.querySelectorAll('gp-panel-nav .pill').length).toBe(10);
    expect(el.querySelector('gp-cpu-panel .core')).not.toBeNull();
    expect(el.querySelector('gp-cont-panel [data-container="web-worker"]')).not.toBeNull();
    // Eier: «Alert settings». Ingen flaggknapper uten flagg.
    expect(el.textContent).toContain('Alert settings');
    expect(el.textContent).not.toContain('Text mode');
  });

  it('Server-meldinger fra lageret vinner over snapshot, og «last seen»/nedtonet når nede', async () => {
    const { fixture, el } = await render('demo-nordic-db');
    store.applyServer(demoDownServer());
    await fixture.whenStable();
    expect(el.querySelector('[data-testid="status"]')?.textContent?.trim()).toMatch(/^last seen /);
    expect(el.querySelector('[data-testid="uptime"]')?.textContent).toMatch(/^last boot /);
    expect(el.querySelector('gp-proc-panel')?.textContent).toContain('Not available while the server is down');
    expect(el.querySelector('gp-logs-panel')?.textContent).toContain('Not available while the server is down');
    expect(el.querySelector('gp-cpu-panel')?.classList.contains('dim')).toBe(true);
    expect(live.startLog).not.toHaveBeenCalled();
  });

  it('lukkede paneler huskes i PrefsService og panelnav åpner igjen', async () => {
    api.get.mockImplementation((path: string) => Promise.resolve(path.endsWith('/snapshot') ? demoServer() : undefined));
    const { fixture, el, page } = await render();
    await fixture.whenStable();
    (el.querySelector('#panel-disk .head') as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(TestBed.inject(PrefsService).collapsed.value()).toEqual({ disk: true });
    expect(el.querySelector('#panel-disk gp-disk-panel')).toBeNull();
    page.goTo('disk');
    await fixture.whenStable();
    expect(TestBed.inject(PrefsService).collapsed.value()).toEqual({});
    expect(el.querySelector('#panel-disk gp-disk-panel')).not.toBeNull();
  });

  it('fragment #mem åpner minnepanelet selv om det var lukket', async () => {
    fragment = 'mem';
    TestBed.inject(PrefsService).collapsed.set({ mem: true });
    await setup();
    api.get.mockImplementation((path: string) => Promise.resolve(path.endsWith('/snapshot') ? demoServer() : undefined));
    const { fixture, el } = await render();
    await fixture.whenStable();
    expect(el.querySelector('#panel-mem gp-mem-panel')).not.toBeNull();
    expect(TestBed.inject(PrefsService).collapsed.value()).toEqual({});
  });

  it('404 fra snapshot viser «Server not found»; leser ser ikke «Alert settings»', async () => {
    api.get.mockImplementation(() => Promise.reject(new ApiError(404)));
    session.roles = new Map([['demo-web-02', 'reader']]);
    const { fixture, el } = await render();
    await fixture.whenStable();
    expect(el.textContent).toContain('Server not found');
    expect(el.textContent).not.toContain('Alert settings');
  });

  it('loggpanelet starter en journal-strøm med tail 10 når serveren er oppe, og stopper ved destroy', async () => {
    live.startLog.mockImplementation(() => Promise.resolve('stream-1'));
    api.get.mockImplementation((path: string) => Promise.resolve(path.endsWith('/snapshot') ? demoServer() : undefined));
    const { fixture } = await render();
    await fixture.whenStable();
    expect(live.startLog).toHaveBeenCalledWith({ serverId: 'demo-web-02', source: 'journal', tail: 10 }, expect.anything());
    fixture.destroy();
    expect(live.stopLog).toHaveBeenCalledWith('stream-1');
  });
});
