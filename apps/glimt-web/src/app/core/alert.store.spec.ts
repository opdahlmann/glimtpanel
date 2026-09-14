import { TestBed } from '@angular/core/testing';
import { AlertStore } from './alert.store';
import { ApiService } from './api.service';
import { AlertDto, AlertEventDto } from './live.types';

function alert(overrides: Partial<AlertDto> & Pick<AlertDto, 'id'>): AlertDto {
  return {
    serverId: 's1',
    serverName: 'web-02',
    rule: 'disk_full',
    key: '/',
    severity: 'critical',
    state: 'firing',
    detail: '/ · 92 %',
    firedAt: '2026-09-14T06:11:00Z',
    resolvedAt: null,
    lastReminderAt: null,
    silenced: false,
    notifiedVia: [],
    ...overrides,
  };
}

describe('AlertStore', () => {
  let api: { get: ReturnType<typeof vi.fn> };
  let store: AlertStore;

  beforeEach(() => {
    api = { get: vi.fn() };
    TestBed.configureTestingModule({ providers: [{ provide: ApiService, useValue: api }] });
    store = TestBed.inject(AlertStore);
  });

  it('laster listen én gang om gangen og teller aktive', async () => {
    api.get.mockResolvedValue({ alerts: [alert({ id: 'a' }), alert({ id: 'b', state: 'resolved', resolvedAt: '2026-09-14T07:00:00Z' })], active: 1, resolved: 1 });
    const p1 = store.load();
    const p2 = store.load();
    await Promise.all([p1, p2]);
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.get).toHaveBeenCalledWith('/alerts', { query: { state: 'all' } });
    expect(store.loaded()).toBe(true);
    expect(store.activeCount()).toBe(1);
    expect(store.hasActive()).toBe(true);
    expect(store.resolved().map((a) => a.id)).toEqual(['b']);
  });

  it('applyEvent erstatter raden med samme id og legger nye øverst', () => {
    store.applyEvent({ kind: 'fired', alert: alert({ id: 'a' }), activeOnServer: 1, worstSeverity: 'critical' });
    store.applyEvent({ kind: 'fired', alert: alert({ id: 'b', firedAt: '2026-09-14T06:20:00Z', rule: 'svc_failed' }), activeOnServer: 2, worstSeverity: 'critical' });
    expect(store.alerts().map((a) => a.id)).toEqual(['b', 'a']);
    expect(store.activeCount()).toBe(2);

    const resolved: AlertEventDto = { kind: 'resolved', alert: alert({ id: 'a', state: 'resolved', resolvedAt: '2026-09-14T06:30:00Z' }), activeOnServer: 1, worstSeverity: 'warning' };
    store.applyEvent(resolved);
    expect(store.alerts()).toHaveLength(2);
    expect(store.activeCount()).toBe(1);
    expect(store.alerts()[0].id).toBe('a'); // løst 06:30 er nyere enn utløst 06:20
  });

  it('markSilenced merker aktive rader for serveren, og clear tømmer', () => {
    store.applyEvent({ kind: 'fired', alert: alert({ id: 'a' }), activeOnServer: 1, worstSeverity: 'critical' });
    store.applyEvent({ kind: 'fired', alert: alert({ id: 'b', serverId: 's2' }), activeOnServer: 1, worstSeverity: 'critical' });
    store.markSilenced('s1', true);
    expect(store.alerts().find((a) => a.id === 'a')?.silenced).toBe(true);
    expect(store.alerts().find((a) => a.id === 'b')?.silenced).toBe(false);
    store.clear();
    expect(store.alerts()).toEqual([]);
    expect(store.loaded()).toBe(false);
  });
});
