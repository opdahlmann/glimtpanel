import { Injectable, Signal, signal } from '@angular/core';

export type Lang = 'en' | 'no';
export type SortKey = 'name' | 'cpu' | 'mem' | 'disk' | 'status' | 'alerts';
export type ViewKey = 'cards' | 'compact' | 'groups';

export interface OverviewFilters {
  tag: string;
  status: '' | 'up' | 'down' | 'paused';
  alert: boolean;
}

/** Nøklene i localStorage, alle med prefiks `gp.` (FB 5.2 «husk valg»). */
export interface Prefs {
  lang: Lang | null;
  sort: SortKey;
  filters: OverviewFilters;
  view: ViewKey;
  /** Panel-id → lukket. */
  collapsed: Record<string, boolean>;
  sparklines: boolean;
  welcomeSeen: boolean;
  /** Vi har hatt en sesjon i denne nettleseren (cookien er httpOnly og usynlig): styrer om oppstarten prøver refresh. */
  hasSession: boolean;
}

export const PREF_DEFAULTS: Prefs = {
  lang: null,
  sort: 'name',
  filters: { tag: '', status: '', alert: false },
  view: 'cards',
  collapsed: {},
  sparklines: true,
  welcomeSeen: false,
  hasSession: false,
};

const PREFIX = 'gp.';

/** Én lagret verdi: `value` er et signal, `set`/`update` skriver til localStorage. */
export class Pref<T> {
  private readonly _value: ReturnType<typeof signal<T>>;
  readonly value: Signal<T>;

  constructor(
    private readonly key: string,
    private readonly fallback: T,
  ) {
    this._value = signal<T>(readStorage(key, fallback));
    this.value = this._value.asReadonly();
  }

  set(v: T): void {
    this._value.set(v);
    writeStorage(this.key, v);
  }

  update(fn: (v: T) => T): void {
    this.set(fn(this._value()));
  }

  reset(): void {
    this.set(this.fallback);
  }
}

/** Typet wrapper rundt localStorage med signaler. Tåler at lagring er utilgjengelig (privat modus, jsdom). */
@Injectable({ providedIn: 'root' })
export class PrefsService {
  readonly lang = new Pref<Lang | null>('lang', PREF_DEFAULTS.lang);
  readonly sort = new Pref<SortKey>('sort', PREF_DEFAULTS.sort);
  readonly filters = new Pref<OverviewFilters>('filters', PREF_DEFAULTS.filters);
  readonly view = new Pref<ViewKey>('view', PREF_DEFAULTS.view);
  readonly collapsed = new Pref<Record<string, boolean>>('collapsed', PREF_DEFAULTS.collapsed);
  readonly sparklines = new Pref<boolean>('sparklines', PREF_DEFAULTS.sparklines);
  readonly welcomeSeen = new Pref<boolean>('welcomeSeen', PREF_DEFAULTS.welcomeSeen);
  readonly hasSession = new Pref<boolean>('hasSession', PREF_DEFAULTS.hasSession);

  /** Sletter alle lagrede valg (brukes ved utlogging av testene, ikke av appen). */
  clear(): void {
    for (const p of [this.lang, this.sort, this.filters, this.view, this.collapsed, this.sparklines, this.welcomeSeen, this.hasSession]) {
      p.reset();
    }
  }
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function readStorage<T>(key: string, fallback: T): T {
  const s = storage();
  if (!s) return fallback;
  try {
    const raw = s.getItem(PREFIX + key);
    if (raw === null) return fallback;
    const parsed = JSON.parse(raw) as T;
    return isPlainObject(fallback) && isPlainObject(parsed) ? { ...fallback, ...parsed } : parsed;
  } catch {
    return fallback;
  }
}

function writeStorage<T>(key: string, v: T): void {
  const s = storage();
  if (!s) return;
  try {
    if (v === null || v === undefined) s.removeItem(PREFIX + key);
    else s.setItem(PREFIX + key, JSON.stringify(v));
  } catch {
    // full eller sperret lagring: valget lever bare i minnet
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
