import { CardDto } from '@core/live.types';
import { clearFilters, countByStatus, filterCards, isAllActive, sortCards, toggleKind } from './overview.model';
import { DEMO_CARDS } from './overview.fixtures';

function node(name: string, status: CardDto['status'] = 'up'): CardDto {
  return { ...DEMO_CARDS[0], id: `demo-${name}`, name, tags: ['edge'], kind: 'container', status, connected: status === 'up', cpu: status === 'up' ? 17 : null };
}

/** Oversiktens modell med containernoder (steg 12.8): tellinger, typefilter og sortering på status. */
describe('overview.model med noder', () => {
  const cards = [...DEMO_CARDS, node('acme-backend'), node('edge-worker', 'sleeping')];

  it('teller begge typer og de sovende', () => {
    const c = countByStatus(cards);
    expect(c.total).toBe(18);
    expect(c.servers).toBe(16);
    expect(c.containers).toBe(2);
    expect(c.sleeping).toBe(1);
    expect(c.down).toBe(1);
    expect(c.paused).toBe(1);
  });

  it('filtrerer på type og på sovende', () => {
    const f = toggleKind(clearFilters(), 'container');
    expect(f.kind).toBe('container');
    expect(filterCards(cards, '', f).map((c) => c.name)).toEqual(['acme-backend', 'edge-worker']);
    expect(toggleKind(f, 'container').kind).toBe('');
    expect(isAllActive(f)).toBe(false);
    expect(filterCards(cards, '', { ...clearFilters(), status: 'sleeping' }).map((c) => c.name)).toEqual(['edge-worker']);
    expect(filterCards(cards, '', { ...clearFilters(), kind: 'server' })).toHaveLength(16);
  });

  it('sorterer på status: nede, sovende, pauset, oppe', () => {
    const names = sortCards(cards, 'status').map((c) => c.name);
    expect(names.slice(0, 3)).toEqual(['nordic-db', 'edge-worker', 'media']);
  });
});
