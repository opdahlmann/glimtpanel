import { ServerStatusDto } from './live.types';

export type ServerMap = ReadonlyMap<string, ServerStatusDto>;

/**
 * Ren reduksjon: legger inn eller erstatter en server (per id) og returnerer et nytt Map,
 * slik at signaler ser endringen. Meldinger uten id ignoreres.
 */
export function applyServerStatus(servers: ServerMap, dto: ServerStatusDto | null | undefined): ServerMap {
  if (!dto || typeof dto.id !== 'string' || dto.id.length === 0) {
    return servers;
  }
  const next = new Map(servers);
  next.set(dto.id, dto);
  return next;
}

/** Sortert liste: navn (uavhengig av store/små bokstaver), deretter id som stabil tiebreaker. */
export function sortServers(servers: ServerMap): ServerStatusDto[] {
  return [...servers.values()].sort(compareServers);
}

export function compareServers(a: ServerStatusDto, b: ServerStatusDto): number {
  const byName = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  return byName !== 0 ? byName : a.id.localeCompare(b.id);
}
