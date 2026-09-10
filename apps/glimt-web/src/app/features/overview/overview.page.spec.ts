import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ApiService } from '@core/api.service';
import { ConfigService, DEFAULT_CONFIG } from '@core/config.service';
import { ConnectionService } from '@core/connection.service';
import { LiveService } from '@core/live.service';
import { LiveStore } from '@core/live.store';
import { CardDto, LiveState, ServerListItem, UserDto } from '@core/live.types';
import { PrefsService } from '@core/prefs.service';
import { ServerListService } from '@core/server-list.service';
import { SessionService } from '@core/session.service';
import { TitleService } from '../../shell/title.service';
import { DEMO_CARDS, demoCardByName } from './overview.fixtures';
import { OverviewPage, SEARCH_DEBOUNCE_MS } from './overview.page';

class LiveServiceStub {
  readonly state = signal<LiveState>('connected');
  readonly unsubscribe = vi.fn();
  readonly subscribeOverview = vi.fn(() => this.unsubscribe);
  added: ((card: CardDto) => void) | null = null;
  readonly onServerAdded = vi.fn((cb: (card: CardDto) => void) => {
    this.added = cb;
    return () => undefined;
  });
  readonly onServerRemoved = vi.fn(() => () => undefined);
}

class SessionStub {
  readonly user = signal<UserDto | null>({ id: 'u1', email: 'dev@glimtpanel.local', name: 'Dev', timezone: 'Europe/Oslo', language: 'en', plan: 'beta', earlyAdopter: true, emailConfirmed: true, ownsServers: true, readerOf: 0 });
  readonly ownsAnyServer = signal(true);
  readonly isAuthenticated = signal(true);
  setServerRoles = vi.fn();
}

class ServerListStub {
  readonly servers = signal<ServerListItem[]>([]);
  readonly loaded = signal(false);
  readonly load = vi.fn(() => Promise.resolve([] as ServerListItem[]));
}

class ConnectionStub {
  readonly offline = signal(false);
}

function clearStorage(): void {
  try {
    globalThis.localStorage?.clear();
  } catch {
    // ingen lagring
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('OverviewPage', () => {
  let live: LiveServiceStub;
  let session: SessionStub;
  let serverList: ServerListStub;
  let store: LiveStore;
  let api: { post: ReturnType<typeof vi.fn>; patch: ReturnType<typeof vi.fn> };

  async function setup(extraProviders: unknown[] = []): Promise<void> {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [OverviewPage],
      providers: [
        provideRouter([]),
        { provide: LiveService, useValue: live },
        { provide: SessionService, useValue: session },
        { provide: ServerListService, useValue: serverList },
        { provide: ConnectionService, useValue: new ConnectionStub() },
        { provide: ApiService, useValue: api },
        ...(extraProviders as []),
      ],
    }).compileComponents();
    store = TestBed.inject(LiveStore);
  }

  beforeEach(async () => {
    clearStorage();
    live = new LiveServiceStub();
    session = new SessionStub();
    serverList = new ServerListStub();
    api = { post: vi.fn(() => new Promise(() => undefined)), patch: vi.fn() };
    await setup();
  });

  afterEach(() => {
    document.body.style.overflow = '';
  });

  async function render() {
    const fixture = TestBed.createComponent(OverviewPage);
    await fixture.whenStable();
    return { fixture, el: fixture.nativeElement as HTMLElement, page: fixture.componentInstance };
  }

  function seedDemo(): void {
    for (const c of DEMO_CARDS) store.applyCard(c);
    serverList.servers.set(DEMO_CARDS.map((c) => ({ id: c.id, name: c.name, hostname: c.hostname, tags: c.tags, status: c.status, lastSeenAt: c.lastSeenAt, role: 'owner' as const })));
    serverList.loaded.set(true);
  }

  it('abonnerer på oversikten, laster serverlisten, setter tittelen og avmelder ved destroy', async () => {
    const { fixture } = await render();
    expect(live.subscribeOverview).toHaveBeenCalledTimes(1);
    expect(serverList.load).toHaveBeenCalledTimes(1);
    expect(TestBed.inject(TitleService).title()).toBe('Servers');
    fixture.destroy();
    expect(live.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('eier uten servere: skjerm 3 med innrulleringskortet og «Add server»', async () => {
    serverList.loaded.set(true);
    const { el } = await render();
    expect(el.querySelector('[data-testid="empty-owner"]')).not.toBeNull();
    expect(el.textContent).toContain('No servers yet');
    expect(el.querySelector('gp-enrol-panel')).not.toBeNull();
    expect(api.post).toHaveBeenCalledWith('/servers/enrol-key', { dockerMode: 'proxy' });
    expect(el.querySelector('gp-button')?.textContent?.trim()).toBe('Add server');
    expect(el.querySelector('[data-testid="summary"]')?.textContent).toContain('0 servers · 0 up · 0 down · 0 paused · live · ');
  });

  it('leser uten servere: «no access yet» og ingen «Add server» (skjerm 18)', async () => {
    session.ownsAnyServer.set(false);
    session.user.update((u) => ({ ...u!, ownsServers: false, readerOf: 1 }));
    serverList.loaded.set(true);
    const { el } = await render();
    expect(el.querySelector('[data-testid="empty-reader"]')?.textContent).toContain('You have not been given access to any servers yet');
    expect(el.querySelector('gp-enrol-panel')).toBeNull();
    expect(el.querySelector('gp-button')).toBeNull();
  });

  it('før listen er lastet vises ingen tom-tilstand (ingen nøkkel hentes)', async () => {
    const { el } = await render();
    expect(el.querySelector('[data-testid="empty-owner"]')).toBeNull();
    expect(api.post).not.toHaveBeenCalled();
    expect(el.querySelector('.empty')?.textContent).toContain('Loading');
  });

  it('16 demoservere: sammendrag, verktøylinje uten visningssegment, chips og kort sortert på navn', async () => {
    seedDemo();
    const { el } = await render();
    expect(el.querySelector('[data-testid="summary"]')?.textContent).toMatch(/^16 servers · 14 up · 1 down · 1 paused · live · \d\d:\d\d:\d\d$/);
    expect(el.querySelector('gp-input input')?.getAttribute('placeholder')).toBe('Search servers…');
    expect([...el.querySelectorAll('gp-select option')].map((o) => o.textContent)).toEqual(['Sort: Name', 'Sort: CPU', 'Sort: Memory', 'Sort: Disk', 'Sort: Status', 'Sort: Tag']);
    expect(el.querySelector('gp-segment')).toBeNull();
    expect([...el.querySelectorAll('.chip')].map((c) => c.textContent?.trim())).toEqual(['All', 'client-a', 'client-b', 'homelab', 'prod', 'staging', 'up', 'down', 'paused', 'Has alert']);
    expect(el.querySelector('.chip')?.getAttribute('aria-pressed')).toBe('true');
    const cards = el.querySelectorAll('gp-server-card');
    expect(cards.length).toBe(16);
    expect(cards[0].getAttribute('aria-label')).toMatch(/^acme-app:/);
    expect(el.querySelector('.grid')?.getAttribute('role')).toBe('list');
  });

  it('filterchips og sortering virker og huskes i PrefsService', async () => {
    seedDemo();
    const { el, fixture } = await render();
    const chip = (label: string) => [...el.querySelectorAll<HTMLButtonElement>('.chip')].find((c) => c.textContent?.trim() === label)!;
    chip('homelab').click();
    await fixture.whenStable();
    expect(el.querySelectorAll('gp-server-card').length).toBe(4);
    chip('down').click();
    await fixture.whenStable();
    expect(el.querySelectorAll('gp-server-card').length).toBe(0);
    expect(el.querySelector('.empty')?.textContent).toContain('No servers match');
    chip('All').click();
    await fixture.whenStable();
    expect(el.querySelectorAll('gp-server-card').length).toBe(16);
    chip('Has alert').click();
    await fixture.whenStable();
    expect(el.querySelectorAll('gp-server-card').length).toBe(5);
    expect(TestBed.inject(PrefsService).filters.value()).toEqual({ tag: '', status: '', alert: true });
    chip('Has alert').click();

    const select = el.querySelector('gp-select select') as HTMLSelectElement;
    select.value = 'cpu';
    select.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    expect(el.querySelector('gp-server-card')?.getAttribute('aria-label')).toMatch(/^api-prod:/);
    expect(TestBed.inject(PrefsService).sort.value()).toBe('cpu');
  });

  it('søket filtrerer på navn og tagger etter 150 ms', async () => {
    seedDemo();
    const { el, fixture, page } = await render();
    page.onSearch('nordic');
    await sleep(SEARCH_DEBOUNCE_MS + 60);
    await fixture.whenStable();
    expect([...el.querySelectorAll('gp-server-card')].map((c) => c.getAttribute('aria-label')?.split(':')[0])).toEqual(['nordic-db', 'nordic-shop']);
  });

  it('«/» fokuserer søket, piltaster flytter fokus mellom kortene', async () => {
    seedDemo();
    const { el, page } = await render();
    const input = el.querySelector('gp-input input') as HTMLInputElement;
    page.onDocumentKeydown(new KeyboardEvent('keydown', { key: '/' }));
    expect(document.activeElement).toBe(input);
    const cards = el.querySelectorAll<HTMLElement>('gp-server-card');
    cards[0].focus();
    cards[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(document.activeElement).toBe(cards[1]);
    cards[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(document.activeElement).toBe(cards[15]);
  });

  it('«Add server» åpner dialogen på trinn 0; ServerAdded flytter den til trinn 1', async () => {
    seedDemo();
    const { el, fixture, page } = await render();
    (el.querySelector('gp-button button') as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(document.querySelector('[role="dialog"] gp-enrol-panel')).not.toBeNull();
    live.added!({ ...demoCardByName('web-01'), id: 'new-1', name: 'web-03', hostname: 'web-03', tags: [] });
    await fixture.whenStable();
    expect(page.addStep()).toBe(1);
    expect(document.querySelector('[role="dialog"] .connected')?.textContent).toContain('web-03');
    expect(serverList.load).toHaveBeenCalledTimes(2);
  });

  it('skjerm 3: ServerAdded i tom-tilstanden åpner dialogen rett på trinn 1', async () => {
    serverList.loaded.set(true);
    const { fixture, page } = await render();
    expect(page.emptyOwner()).toBe(true);
    // Som LiveService gjør det: kortet legges i lageret før siden får beskjed.
    const card = { ...demoCardByName('web-01'), id: 'new-1', name: 'web-03', hostname: 'web-03', tags: [] };
    store.applyCard(card);
    live.added!(card);
    await fixture.whenStable();
    expect(page.addOpen()).toBe(true);
    expect(page.addStep()).toBe(1);
  });

  it('visningssegmentet rendres bare når flere visninger er slått på', async () => {
    await setup([{ provide: ConfigService, useValue: { config: signal({ ...DEFAULT_CONFIG, featureFlags: ['compact'] }), loaded: signal(true), hasFlag: (f: string) => f === 'compact' } }]);
    seedDemo();
    const { el } = await render();
    expect(el.querySelector('gp-segment')).not.toBeNull();
    expect([...el.querySelectorAll('gp-segment [role="radio"]')].map((r) => r.textContent)).toEqual(['Cards', 'Compact']);
  });
});
