import { CardDto, ServerStatus } from '@core/live.types';
import { OverviewFilters, SortKey } from '@core/prefs.service';

/**
 * Rene funksjoner for oversikten (steg 4.1), nøyaktig som prototypens `renderVals()`:
 * søk på navn og tagger, én tagg og én status om gangen, «Has alert» uavhengig, og sorteringene
 * name / cpu / mem / disk / status (down → paused → up, deretter navn) / tag (sammenslått taggstreng).
 */

export function tagString(card: Pick<CardDto, 'tags'>): string {
  return card.tags.join(', ');
}

function num(v: number | null | undefined): number {
  return v === null || v === undefined || !Number.isFinite(v) ? 0 : v;
}

function byName(a: Pick<CardDto, 'name' | 'id'>, b: Pick<CardDto, 'name' | 'id'>): number {
  const n = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  return n !== 0 ? n : a.id.localeCompare(b.id);
}

const STATUS_ORDER: Record<ServerStatus, number> = { down: 0, sleeping: 1, paused: 2, up: 3 };

export const SORTERS: Record<SortKey, (a: CardDto, b: CardDto) => number> = {
  name: byName,
  cpu: (a, b) => num(b.cpu) - num(a.cpu) || byName(a, b),
  mem: (a, b) => num(b.mem) - num(a.mem) || byName(a, b),
  disk: (a, b) => num(b.diskWorst?.pct) - num(a.diskWorst?.pct) || byName(a, b),
  status: (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || byName(a, b),
  tag: (a, b) => tagString(a).localeCompare(tagString(b)) || byName(a, b),
};

export function sortCards(cards: readonly CardDto[], sort: SortKey): CardDto[] {
  return [...cards].sort(SORTERS[sort] ?? SORTERS.name);
}

/** Fritekst på navn og tagger (uavhengig av store/små bokstaver). Tom streng matcher alt. */
export function matchesSearch(card: Pick<CardDto, 'name' | 'tags'>, search: string): boolean {
  const q = search.trim().toLowerCase();
  if (!q) return true;
  return card.name.toLowerCase().includes(q) || tagString(card).toLowerCase().includes(q);
}

export function matchesFilters(card: Pick<CardDto, 'tags' | 'status' | 'activeAlerts' | 'kind'>, filters: OverviewFilters): boolean {
  if (filters.tag && !card.tags.includes(filters.tag)) return false;
  if (filters.status && card.status !== filters.status) return false;
  if (filters.alert && !(card.activeAlerts > 0)) return false;
  if (filters.kind && (card.kind ?? 'server') !== filters.kind) return false;
  return true;
}

export function filterCards(cards: readonly CardDto[], search: string, filters: OverviewFilters): CardDto[] {
  return cards.filter((c) => matchesSearch(c, search) && matchesFilters(c, filters));
}

/** Alle tagger i brukerens servere, alfabetisk, uten duplikater (prototypen brukte listens rekkefølge; alfabetisk er stabilt når kort kommer og går). */
export function collectTags(cards: readonly Pick<CardDto, 'tags'>[]): string[] {
  const seen = new Set<string>();
  for (const c of cards) for (const t of c.tags) seen.add(t);
  return [...seen].sort((a, b) => a.localeCompare(b));
}

export interface StatusCounts {
  total: number;
  up: number;
  down: number;
  paused: number;
  sleeping: number;
  servers: number;
  containers: number;
}

export function countByStatus(cards: readonly Pick<CardDto, 'status' | 'kind'>[]): StatusCounts {
  const counts: StatusCounts = { total: cards.length, up: 0, down: 0, paused: 0, sleeping: 0, servers: 0, containers: 0 };
  for (const c of cards) {
    counts[c.status]++;
    if ((c.kind ?? 'server') === 'container') counts.containers++;
    else counts.servers++;
  }
  return counts;
}

/** Klikk på en filterchip: samme tagg/status/type igjen slår den av (prototypen); «Has alert» veksler mot true. */
export function toggleFilter<K extends keyof OverviewFilters>(filters: OverviewFilters, key: K, value: OverviewFilters[K]): OverviewFilters {
  return { ...filters, [key]: filters[key] === value ? clearFilters()[key] : value };
}

export function clearFilters(): OverviewFilters {
  return { tag: '', status: '', alert: false, kind: '' };
}

export function isAllActive(filters: OverviewFilters): boolean {
  return !filters.tag && !filters.status && !filters.alert && !filters.kind;
}
