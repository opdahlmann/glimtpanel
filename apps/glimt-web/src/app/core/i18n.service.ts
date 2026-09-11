import { computed, inject, Injectable, Injector, signal } from '@angular/core';
import en from '@i18n/en.json';
import no from '@i18n/no.json';
import { ConfigService } from './config.service';
import { Lang, PrefsService } from './prefs.service';
import { SessionService } from './session.service';

/** Alle nøklene i ordboken (6.5). `no.json` har samme nøkkelsett (testet). */
export type I18nKey = keyof typeof en;
export type Dictionary = Record<I18nKey, string>;

export const DICTIONARIES: Record<Lang, Dictionary> = { en, no: no as Dictionary };

export function isLang(v: unknown): v is Lang {
  return v === 'en' || v === 'no';
}

/**
 * Ordbok og dato/klokkeslett (steg 3.2). `lang` er lagret valg → brukerprofil → `config.defaultLang`.
 * `setLang` lagrer i localStorage og, når innlogget, `PATCH /api/account { language }`.
 * Klokkeslett vises i 24-timers format i brukerens tidssone (fra profilen, ellers nettleserens) i begge språk.
 */
@Injectable({ providedIn: 'root' })
export class I18nService {
  private readonly config = inject(ConfigService);
  private readonly prefs = inject(PrefsService);
  private readonly injector = inject(Injector);

  /** Språk fra brukerprofilen (settes av SessionService), brukes når ingenting er lagret lokalt. */
  private readonly profileLang = signal<Lang | null>(null);
  private readonly _timeZone = signal<string | null>(null);

  readonly lang = computed<Lang>(() => {
    const stored = this.prefs.lang.value();
    if (isLang(stored)) return stored;
    const profile = this.profileLang();
    if (profile) return profile;
    const def = this.config.config().defaultLang;
    return isLang(def) ? def : 'en';
  });

  readonly dict = computed(() => DICTIONARIES[this.lang()]);
  /** IANA-tidssone eller null = nettleserens. */
  readonly timeZone = this._timeZone.asReadonly();
  /** BCP 47 for Intl (måned- og ukedagsnavn). Tall og enheter er uendret. */
  readonly locale = computed(() => (this.lang() === 'no' ? 'nb-NO' : 'en-US'));

  t(key: I18nKey): string {
    return this.dict()[key] ?? key;
  }

  /** Bytter språk, lagrer lokalt og i profilen når innlogget. */
  setLang(lang: Lang): void {
    if (!isLang(lang)) return;
    this.prefs.lang.set(lang);
    void this.persistToProfile(lang);
  }

  /** Kalles av SessionService når profilen er lastet. Overstyrer ikke et lokalt lagret valg. */
  applyProfile(user: { language?: string | null; timezone?: string | null } | null): void {
    this.profileLang.set(user && isLang(user.language) ? user.language : null);
    this._timeZone.set(user?.timezone && isValidTimeZone(user.timezone) ? user.timezone : null);
  }

  private async persistToProfile(lang: Lang): Promise<void> {
    // Lazy oppslag: SessionService avhenger av I18nService, så den hentes først når den trengs.
    const session = this.injector.get(SessionService);
    if (!session.isAuthenticated()) return;
    try {
      await session.updateAccount({ language: lang });
    } catch (err) {
      console.warn('[i18n] could not save language to profile', err);
    }
  }

  // ---- dato og klokkeslett ---------------------------------------------------------------------

  /** "08:14:05" */
  formatClock(ms: number | Date): string {
    return this.fmt({ hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(ms);
  }

  /** "08:14" */
  formatTimeShort(ms: number | Date): string {
    return this.fmt({ hour: '2-digit', minute: '2-digit' }).format(ms);
  }

  /** "Sep 7 14:20" (en) / "7. sep. 14:20" (no). */
  formatDate(ms: number | Date, withTime = true): string {
    const day = this.fmt({ month: 'short', day: 'numeric' }).format(ms);
    return withTime ? `${day} ${this.formatTimeShort(ms)}` : day;
  }

  /** "Apr 2029" (en) / "apr. 2029" (no), for «Supported until». */
  formatMonthYear(ms: number | Date): string {
    return this.fmt({ month: 'short', year: 'numeric' }).format(ms);
  }

  /** "08:11" i dag, "yesterday 23:10" i går, ellers "Sep 7 14:20". */
  formatWhen(ms: number | Date, now: number = Date.now()): string {
    const day = this.dayKey(ms);
    if (day === this.dayKey(now)) return this.formatTimeShort(ms);
    if (day === this.dayKey(now - 86_400_000)) return `${this.t('yesterday')} ${this.formatTimeShort(ms)}`;
    return this.formatDate(ms);
  }

  private readonly cache = new Map<string, Intl.DateTimeFormat>();

  private fmt(opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
    const tz = this.timeZone() ?? undefined;
    const locale = this.locale();
    const key = `${locale}|${tz ?? ''}|${JSON.stringify(opts)}`;
    let f = this.cache.get(key);
    if (!f) {
      f = new Intl.DateTimeFormat(locale, { ...opts, hourCycle: 'h23', timeZone: tz });
      this.cache.set(key, f);
    }
    return f;
  }

  /** Datonøkkel i brukerens tidssone, f.eks. "2026-09-07". */
  private dayKey(ms: number | Date): string {
    return this.fmt({ year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
  }
}

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
