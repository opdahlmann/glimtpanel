import { CardDto, GroupDto } from '@core/live.types';
import { DEMO_CARDS } from '../overview.fixtures';
import { groupSums, groupView, worstStatus } from './group-view';

const GB = 1024 ** 3;
const texts = { t: (k: string) => k, formatWhen: (ms: number) => `@${ms}` };

function byId(cards: CardDto[]): Map<string, CardDto> {
  return new Map(cards.map((c) => [c.id, c]));
}

function group(over: Partial<GroupDto> = {}): GroupDto {
  return { id: 'g1', name: 'Acme', memberIds: ['demo-web-02', 'demo-db-prod'], order: 0, createdAt: '2026-09-14T08:00:00Z', ...over };
}

/** Summering på gruppekortet (steg 13.2): kjerner, GB, verste status, varsler. */
describe('group-view', () => {
  it('summerer kjerner og GB over medlemmene som er oppe, og teller varsler', () => {
    // web-02: 4 kjerner à 48 %, 8 GB à 61 %; db-prod: 8 kjerner à 28 %, 32 GB à 79 %.
    const v = groupView(group(), byId(DEMO_CARDS), texts);
    expect(v.count).toBe(2);
    expect(v.summary).toBe('2 nodes · 2 up');
    expect(v.cpu).toBe('4.2 of 12 cores');
    expect(v.mem).toBe('30.2 of 40 GB');
    expect(v.alerts).toBe('1 active');
    expect(v.alertsTone).toBe('crit');
    expect(v.worst).toBe('up');
    expect(v.stripe).toBe('transparent');
    expect(v.members.map((m) => [m.name, m.kind, m.cpu, m.mem])).toEqual([
      ['web-02', 'server', '48%', '61%'],
      ['db-prod', 'server', '28%', '79%'],
    ]);
    expect(v.ariaLabel).toBe('Acme: 2 nodes, 2 up, cpu 4.2 of 12 cores, memory 30.2 of 40 GB, alerts 1 active');
  });

  it('verste status: nede > sover > pauset > oppe, og medlemmer som mangler i lageret telles ikke', () => {
    const sleeping: CardDto = { ...DEMO_CARDS[0], id: 'n1', name: 'edge-worker', kind: 'container', status: 'sleeping', connected: false, cpu: null, mem: null, cores: 1, ramBytes: 0.5 * GB };
    const cards = byId([...DEMO_CARDS, sleeping]);
    const v = groupView(group({ memberIds: ['demo-nordic-db', 'n1', 'demo-media', 'gone'] }), cards, texts);
    expect(v.count).toBe(3);
    expect(v.summary).toBe('3 nodes · 0 up · 1 down · 1 sleeping · 1 paused');
    expect(v.worst).toBe('down');
    expect(v.dot).toBe('down');
    expect(v.stripe).toBe('var(--color-crit)');
    expect(v.dimmed).toBe(true);
    expect(v.members.find((m) => m.id === 'n1')).toMatchObject({ kind: 'container', dot: 'paused', cpu: '—', mem: '—' });
    expect(worstStatus(['up', 'paused', 'sleeping'])).toBe('sleeping');
    expect(worstStatus([])).toBe('up');
  });

  it('tom gruppe', () => {
    const v = groupView(group({ memberIds: [] }), byId(DEMO_CARDS), texts);
    expect(v.empty).toBe(true);
    expect(v.summary).toBe('noNodesYet');
    expect(v.cpu).toBe('—');
    expect(v.mem).toBe('—');
    expect(v.alerts).toBe('0 active');
    expect(v.dimmed).toBe(false);
    expect(groupSums([])).toEqual({ cpuCores: 0, totalCores: 0, memGb: 0, totalGb: 0, alerts: 0 });
  });
});
