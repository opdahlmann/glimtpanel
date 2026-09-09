import { applyServerStatus, compareServers, sortServers } from './live.reducer';
import { ServerStatusDto } from './live.types';

function dto(overrides: Partial<ServerStatusDto> & Pick<ServerStatusDto, 'id' | 'name'>): ServerStatusDto {
  return {
    hostname: `${overrides.name}.local`,
    status: 'up',
    lastSeenAt: '2026-09-09T20:00:00Z',
    connected: true,
    agentVersion: '0.1.0',
    os: 'Ubuntu 24.04',
    arch: 'x86_64',
    cores: 4,
    ramBytes: 8 * 1024 ** 3,
    ...overrides,
  };
}

describe('applyServerStatus', () => {
  it('adds a server that comes up', () => {
    const next = applyServerStatus(new Map(), dto({ id: 'a', name: 'ubuntu-dev' }));
    expect(next.size).toBe(1);
    expect(next.get('a')?.status).toBe('up');
  });

  it('replaces the entry with the same id when the server goes down', () => {
    const initial = applyServerStatus(new Map(), dto({ id: 'a', name: 'ubuntu-dev' }));
    const down = dto({ id: 'a', name: 'ubuntu-dev', status: 'down', connected: false, lastSeenAt: '2026-09-09T20:02:00Z' });
    const next = applyServerStatus(initial, down);

    expect(next.size).toBe(1);
    expect(next.get('a')).toEqual(down);
    expect(next.get('a')?.lastSeenAt).toBe('2026-09-09T20:02:00Z');
  });

  it('returns a new map and leaves the previous one untouched', () => {
    const initial = applyServerStatus(new Map(), dto({ id: 'a', name: 'one' }));
    const next = applyServerStatus(initial, dto({ id: 'b', name: 'two' }));

    expect(next).not.toBe(initial);
    expect(initial.size).toBe(1);
    expect(next.size).toBe(2);
  });

  it('ignores messages without an id', () => {
    const initial = applyServerStatus(new Map(), dto({ id: 'a', name: 'one' }));
    expect(applyServerStatus(initial, null)).toBe(initial);
    expect(applyServerStatus(initial, { ...dto({ id: '', name: 'x' }) })).toBe(initial);
  });
});

describe('sortServers', () => {
  it('sorts by name, case-insensitively, regardless of arrival order', () => {
    let map = applyServerStatus(new Map(), dto({ id: '3', name: 'web-02' }));
    map = applyServerStatus(map, dto({ id: '1', name: 'Alpha' }));
    map = applyServerStatus(map, dto({ id: '2', name: 'db-01' }));

    expect(sortServers(map).map((s) => s.name)).toEqual(['Alpha', 'db-01', 'web-02']);
  });

  it('uses id as a stable tiebreaker for equal names', () => {
    let map = applyServerStatus(new Map(), dto({ id: 'b', name: 'same' }));
    map = applyServerStatus(map, dto({ id: 'a', name: 'same' }));

    expect(sortServers(map).map((s) => s.id)).toEqual(['a', 'b']);
    expect(compareServers(dto({ id: 'a', name: 'same' }), dto({ id: 'b', name: 'same' }))).toBeLessThan(0);
  });

  it('returns an empty array for an empty map', () => {
    expect(sortServers(new Map())).toEqual([]);
  });
});
