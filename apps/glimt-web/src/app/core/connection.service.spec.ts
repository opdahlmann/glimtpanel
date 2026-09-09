import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ConnectionService, OFFLINE_AFTER_MS } from './connection.service';
import { LiveService } from './live.service';
import { LiveState } from './live.types';

describe('ConnectionService', () => {
  let live: { state: ReturnType<typeof signal<LiveState>>; lastMessageAt: ReturnType<typeof signal<number | null>>; reconnect: ReturnType<typeof vi.fn> };
  let conn: ConnectionService;

  beforeEach(() => {
    vi.useFakeTimers();
    live = { state: signal<LiveState>('connected'), lastMessageAt: signal<number | null>(null), reconnect: vi.fn().mockResolvedValue(undefined) };
    TestBed.configureTestingModule({ providers: [{ provide: LiveService, useValue: live }] });
    conn = TestBed.inject(ConnectionService);
    TestBed.tick();
  });

  afterEach(() => vi.useRealTimers());

  it('er online mens forbindelsen er oppe', () => {
    expect(conn.offline()).toBe(false);
  });

  it('blir offline først etter 2 s uten forbindelse, og online igjen uten forsinkelse', () => {
    live.state.set('reconnecting');
    TestBed.tick();
    vi.advanceTimersByTime(OFFLINE_AFTER_MS - 1);
    expect(conn.offline()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(conn.offline()).toBe(true);
    live.state.set('connected');
    TestBed.tick();
    expect(conn.offline()).toBe(false);
  });

  it('en kort gjenoppkobling under 2 s gir ikke banner', () => {
    live.state.set('reconnecting');
    TestBed.tick();
    vi.advanceTimersByTime(500);
    live.state.set('connected');
    TestBed.tick();
    vi.advanceTimersByTime(OFFLINE_AFTER_MS);
    expect(conn.offline()).toBe(false);
  });

  it('navigator offline gir banner straks; frozenAt speiler siste melding', () => {
    window.dispatchEvent(new Event('offline'));
    expect(conn.offline()).toBe(true);
    window.dispatchEvent(new Event('online'));
    expect(conn.offline()).toBe(false);
    live.lastMessageAt.set(1234);
    expect(conn.frozenAt()).toBe(1234);
  });

  it('reconnect() kaller LiveService.reconnect', () => {
    conn.reconnect();
    expect(live.reconnect).toHaveBeenCalledTimes(1);
  });
});
