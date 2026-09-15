import { clearFilters, collectTags, countByStatus, filterCards, isAllActive, matchesSearch, sortCards, toggleFilter } from './overview.model';
import { DEMO_CARDS, demoCardByName } from './overview.fixtures';

const names = (cards: { name: string }[]) => cards.map((c) => c.name);

describe('overview.model (16 demoservere)', () => {
  it('sorterer på navn uavhengig av store/små bokstaver', () => {
    const sorted = names(sortCards(DEMO_CARDS, 'name'));
    expect(sorted.slice(0, 4)).toEqual(['acme-app', 'acme-db', 'api-prod', 'backup']);
    expect(sorted).toHaveLength(16);
  });

  it('sorterer cpu, mem og disk synkende med nede-servere (null) sist', () => {
    const cpu = names(sortCards(DEMO_CARDS, 'cpu'));
    expect(cpu[0]).toBe('api-prod');
    expect(cpu[1]).toBe('nordic-shop');
    expect(cpu.at(-1)).toBe('nordic-db');
    expect(names(sortCards(DEMO_CARDS, 'mem'))[0]).toBe('cache-01');
    const disk = names(sortCards(DEMO_CARDS, 'disk'));
    expect(disk.slice(0, 3)).toEqual(['web-02', 'nas', 'acme-db']);
  });

  it('sorterer status down → paused → up, deretter navn', () => {
    const sorted = names(sortCards(DEMO_CARDS, 'status'));
    expect(sorted[0]).toBe('nordic-db');
    expect(sorted[1]).toBe('media');
    expect(sorted.slice(2, 4)).toEqual(['acme-app', 'acme-db']);
  });

  it('sorterer på sammenslått taggstreng, deretter navn', () => {
    const sorted = names(sortCards(DEMO_CARDS, 'tag'));
    expect(sorted.slice(0, 2)).toEqual(['acme-app', 'acme-db']); // client-a
    expect(sorted.slice(2, 4)).toEqual(['nordic-db', 'nordic-shop']); // client-b
    expect(sorted.at(-1)).toBe('staging-web'); // staging sist
  });

  it('søker på navn og tagger uavhengig av store/små bokstaver', () => {
    expect(names(filterCards(DEMO_CARDS, 'NORDIC', clearFilters()))).toEqual(['nordic-shop', 'nordic-db']);
    expect(names(filterCards(DEMO_CARDS, 'client-a', clearFilters()))).toEqual(['acme-app', 'acme-db']);
    expect(filterCards(DEMO_CARDS, '   ', clearFilters())).toHaveLength(16);
    expect(matchesSearch({ name: 'web-01', tags: ['prod'] }, 'pro')).toBe(true);
    expect(matchesSearch({ name: 'web-01', tags: ['prod'] }, 'db')).toBe(false);
  });

  it('filtrerer på én tagg, én status og «Has alert» uavhengig', () => {
    expect(filterCards(DEMO_CARDS, '', { tag: 'homelab', status: '', alert: false, kind: '' })).toHaveLength(4);
    expect(names(filterCards(DEMO_CARDS, '', { tag: '', status: 'down', alert: false, kind: '' }))).toEqual(['nordic-db']);
    expect(names(filterCards(DEMO_CARDS, '', { tag: '', status: 'paused', alert: false, kind: '' }))).toEqual(['media']);
    expect(filterCards(DEMO_CARDS, '', { tag: '', status: 'up', alert: false, kind: '' })).toHaveLength(14);
    expect(names(filterCards(DEMO_CARDS, '', { tag: '', status: '', alert: true, kind: '' }))).toEqual(['web-02', 'api-prod', 'worker-01', 'acme-app', 'nordic-db']);
    expect(names(filterCards(DEMO_CARDS, '', { tag: 'prod', status: 'up', alert: true, kind: '' }))).toEqual(['web-02', 'api-prod', 'worker-01']);
  });

  it('samler taggene alfabetisk uten duplikater', () => {
    expect(collectTags(DEMO_CARDS)).toEqual(['client-a', 'client-b', 'homelab', 'prod', 'staging']);
    expect(collectTags([{ tags: ['b', 'a'] }, { tags: ['a'] }])).toEqual(['a', 'b']);
  });

  it('teller opp status til sammendraget', () => {
    expect(countByStatus(DEMO_CARDS)).toEqual({ total: 16, up: 14, down: 1, paused: 1, sleeping: 0, servers: 16, containers: 0 });
  });

  it('chips slår av og på som prototypen', () => {
    let f = clearFilters();
    expect(isAllActive(f)).toBe(true);
    f = toggleFilter(f, 'tag', 'prod');
    expect(f.tag).toBe('prod');
    expect(isAllActive(f)).toBe(false);
    f = toggleFilter(f, 'tag', 'prod');
    expect(f.tag).toBe('');
    f = toggleFilter(f, 'status', 'down');
    f = toggleFilter(f, 'status', 'up');
    expect(f.status).toBe('up');
    f = toggleFilter(f, 'status', 'up');
    expect(f.status).toBe('');
    f = toggleFilter(toggleFilter(f, 'alert', true), 'alert', true);
    expect(f.alert).toBe(false);
  });

  it('demoserveren nordic-db er nede uten tall', () => {
    const c = demoCardByName('nordic-db');
    expect(c.status).toBe('down');
    expect(c.cpu).toBeNull();
  });
});
