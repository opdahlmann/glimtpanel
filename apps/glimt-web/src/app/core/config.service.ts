import { Injectable, signal } from '@angular/core';

/** Kjøretidskonfigurasjon. Samme form som scripts/web-config.mjs og infra/glimt-web/40-glimt-config.sh skriver. */
export interface AppConfig {
  env: string;
  apiUrl: string;
  hubUrl: string;
  hubPublicUrl: string;
  installUrl: string;
  docsUrl: string;
  vapidPublic: string;
  defaultLang: string;
  featureFlags: string[];
}

export const CONFIG_URL = '/config.json';

/** Brukes når /config.json mangler eller ikke kan leses (f.eks. `ng build` uten generert fil). */
export const DEFAULT_CONFIG: AppConfig = {
  env: 'development',
  apiUrl: '/api',
  hubUrl: '/hub/live',
  hubPublicUrl: '',
  installUrl: '',
  docsUrl: '',
  vapidPublic: '',
  defaultLang: 'en',
  featureFlags: [],
};

@Injectable({ providedIn: 'root' })
export class ConfigService {
  private readonly _config = signal<AppConfig>(DEFAULT_CONFIG);
  private readonly _loaded = signal(false);

  /** Gjeldende konfigurasjon. Standardverdier til `load()` har kjørt. */
  readonly config = this._config.asReadonly();
  /** `true` etter at `load()` er ferdig, uansett om hentingen lyktes. */
  readonly loaded = this._loaded.asReadonly();

  /** Henter /config.json. Kalles fra provideAppInitializer i app.config.ts. Kaster aldri. */
  async load(): Promise<void> {
    try {
      const res = await fetch(CONFIG_URL, { cache: 'no-store' });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const json = (await res.json()) as Partial<AppConfig> | null;
      this._config.set(normalizeConfig(json));
    } catch (err) {
      console.warn(`[config] could not load ${CONFIG_URL}, using default config`, err);
      this._config.set(DEFAULT_CONFIG);
    } finally {
      this._loaded.set(true);
    }
  }

  hasFlag(flag: string): boolean {
    return this.config().featureFlags.includes(flag);
  }
}

/** Fyller inn manglende nøkler fra standardverdiene og sikrer at featureFlags er en strengliste. */
export function normalizeConfig(json: Partial<AppConfig> | null | undefined): AppConfig {
  const flags = Array.isArray(json?.featureFlags)
    ? json.featureFlags.filter((f): f is string => typeof f === 'string' && f.length > 0)
    : [];
  return { ...DEFAULT_CONFIG, ...(json ?? {}), featureFlags: flags };
}
