import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { LiveService } from '@core/live.service';
import { cardFromStatus, LastHour, LiveStore } from '@core/live.store';
import { CardDto, LiveState } from '@core/live.types';
import { TitleService } from '../../shell/title.service';
import { OverviewPage } from './overview.page';

class LiveServiceStub {
  readonly state = signal<LiveState>('disconnected');
  readonly unsubscribe = vi.fn();
  readonly subscribeOverview = vi.fn(() => this.unsubscribe);
}

class LiveStoreStub {
  readonly cards = signal<CardDto[]>([]);
  readonly hour = signal<LastHour>({ cpu: [10, 20, 30], mem: [1, 2, 3] });
  lastHour = vi.fn(() => this.hour);
}

/** jsdom uten opprinnelse har ikke alltid localStorage; PrefsService tåler det, og testene skal ikke lekke valg. */
function clearStorage(): void {
  try {
    globalThis.localStorage?.clear();
  } catch {
    // ingen lagring
  }
}

describe('OverviewPage', () => {
  let live: LiveServiceStub;
  let store: LiveStoreStub;

  beforeEach(async () => {
    clearStorage();
    live = new LiveServiceStub();
    store = new LiveStoreStub();
    await TestBed.configureTestingModule({
      imports: [OverviewPage],
      providers: [provideRouter([]), { provide: LiveService, useValue: live }, { provide: LiveStore, useValue: store }],
    }).compileComponents();
  });

  it('abonnerer på oversikten ved opprettelse, avmelder ved destroy og setter tittelen', async () => {
    const fixture = TestBed.createComponent(OverviewPage);
    await fixture.whenStable();
    expect(live.subscribeOverview).toHaveBeenCalledTimes(1);
    expect(TestBed.inject(TitleService).title()).toBe('Servers');
    fixture.destroy();
    expect(live.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('viser tom-tilstand uten kort', async () => {
    const fixture = TestBed.createComponent(OverviewPage);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('h1')?.textContent).toBe('Servers');
    expect(el.querySelector('.empty')?.textContent).toContain('Waiting for the agent');
  });

  it('viser én rad per kort med status, tall og sparkline', async () => {
    live.state.set('connected');
    store.cards.set([
      { ...cardFromStatus({ id: 'a', name: 'web-02', hostname: 'web-02', status: 'up', lastSeenAt: null, connected: true }), cpu: 48.4, mem: 61, diskWorst: { path: '/', pct: 92 } },
      { ...cardFromStatus({ id: 'b', name: 'nordic-db', hostname: 'nordic-db', status: 'down', lastSeenAt: '2026-09-09T03:12:00Z', connected: false }) },
    ]);
    const fixture = TestBed.createComponent(OverviewPage);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    const rows = el.querySelectorAll('gp-row');
    expect(rows.length).toBe(2);
    expect(rows[0].querySelector('.name')?.textContent).toBe('web-02');
    expect(rows[0].querySelector('.name')?.getAttribute('href')).toBe('/servers/a');
    expect([...rows[0].querySelectorAll('.v')].map((v) => v.textContent)).toEqual(['48%', '61%', '92%']);
    expect(rows[0].querySelector('gp-sparkline path')?.getAttribute('d')).toContain('M0');
    expect(rows[1].querySelector('.status')?.textContent).toContain('last seen');
    expect([...rows[1].querySelectorAll('.v')].map((v) => v.textContent)).toEqual(['—', '—', '—']);
    expect(el.querySelector('.summary')?.textContent).toContain('2 Servers · 1 up · 1 down');
  });
});
