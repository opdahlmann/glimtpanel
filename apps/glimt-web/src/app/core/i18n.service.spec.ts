import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import en from '@i18n/en.json';
import no from '@i18n/no.json';
import { ConfigService, DEFAULT_CONFIG } from './config.service';
import { I18nService } from './i18n.service';
import { PrefsService } from './prefs.service';
import { SessionService } from './session.service';

/** jsdom uten opprinnelse har ikke alltid localStorage; PrefsService tåler det, og testene skal ikke lekke valg. */
function clearStorage(): void {
  try {
    globalThis.localStorage?.clear();
  } catch {
    // ingen lagring
  }
}

describe('ordboken', () => {
  it('en.json og no.json har identisk nøkkelsett', () => {
    const enKeys = Object.keys(en).sort();
    const noKeys = Object.keys(no).sort();
    expect(noKeys).toEqual(enKeys);
  });

  it('ingen tomme tekster', () => {
    for (const dict of [en, no]) {
      for (const [k, v] of Object.entries(dict)) expect(v, k).not.toBe('');
    }
  });
});

describe('I18nService', () => {
  let session: { isAuthenticated: ReturnType<typeof vi.fn>; updateAccount: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    clearStorage();
    session = { isAuthenticated: vi.fn().mockReturnValue(false), updateAccount: vi.fn().mockResolvedValue(undefined) };
    TestBed.configureTestingModule({ providers: [{ provide: SessionService, useValue: session }] });
  });

  afterEach(() => clearStorage());

  it('starter på config.defaultLang når ingenting er lagret', () => {
    const i18n = TestBed.inject(I18nService);
    expect(i18n.lang()).toBe('en');
    expect(i18n.t('servers')).toBe('Servers');
  });

  it('bytter språk uten omlasting, lagrer valget og oppdaterer t()', () => {
    const i18n = TestBed.inject(I18nService);
    i18n.setLang('no');
    expect(i18n.lang()).toBe('no');
    expect(i18n.t('servers')).toBe('Servere');
    expect(i18n.t('lastSeen')).toBe('sist sett');
    expect(TestBed.inject(PrefsService).lang.value()).toBe('no');
    expect(session.updateAccount).not.toHaveBeenCalled();
  });

  it('lagrer språket i profilen når innlogget', async () => {
    session.isAuthenticated.mockReturnValue(true);
    const i18n = TestBed.inject(I18nService);
    i18n.setLang('no');
    await Promise.resolve();
    expect(session.updateAccount).toHaveBeenCalledWith({ language: 'no' });
  });

  it('lagret valg > profil > standard', () => {
    const i18n = TestBed.inject(I18nService);
    i18n.applyProfile({ language: 'no', timezone: 'Europe/Oslo' });
    expect(i18n.lang()).toBe('no');
    expect(i18n.timeZone()).toBe('Europe/Oslo');
    TestBed.inject(PrefsService).lang.set('en');
    expect(i18n.lang()).toBe('en');
    i18n.applyProfile(null);
    expect(i18n.timeZone()).toBeNull();
  });

  it('bruker standardspråket fra config når det er norsk', () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: SessionService, useValue: session },
        { provide: ConfigService, useValue: { config: signal({ ...DEFAULT_CONFIG, defaultLang: 'no' }) } },
      ],
    });
    const i18n = TestBed.inject(I18nService);
    expect(i18n.lang()).toBe('no');
  });

  describe('dato og klokkeslett (Europe/Oslo, 24 t)', () => {
    // 2026-09-09T06:14:05Z = 08:14:05 i Oslo (sommertid)
    const now = Date.UTC(2026, 8, 9, 6, 14, 5);

    it('formatClock og formatTimeShort', () => {
      const i18n = TestBed.inject(I18nService);
      i18n.applyProfile({ language: 'en', timezone: 'Europe/Oslo' });
      expect(i18n.formatClock(now)).toBe('08:14:05');
      expect(i18n.formatTimeShort(now)).toBe('08:14');
      expect(i18n.formatTimeShort(Date.UTC(2026, 8, 9, 22, 5))).toBe('00:05');
    });

    it('formatWhen: i dag, i går, ellers dato', () => {
      const i18n = TestBed.inject(I18nService);
      i18n.applyProfile({ language: 'en', timezone: 'Europe/Oslo' });
      expect(i18n.formatWhen(now - 3 * 60_000, now)).toBe('08:11');
      expect(i18n.formatWhen(Date.UTC(2026, 8, 8, 21, 10), now)).toBe('yesterday 23:10');
      expect(i18n.formatWhen(Date.UTC(2026, 8, 7, 12, 20), now)).toBe('Sep 7 14:20');
      i18n.setLang('no');
      expect(i18n.formatWhen(Date.UTC(2026, 8, 8, 21, 10), now)).toBe('i går 23:10');
      expect(i18n.formatWhen(Date.UTC(2026, 6, 30, 23, 5), now)).toBe('31. juli 01:05');
    });

    it('formatDate uten klokkeslett', () => {
      const i18n = TestBed.inject(I18nService);
      i18n.applyProfile({ language: 'en', timezone: 'Europe/Oslo' });
      expect(i18n.formatDate(Date.UTC(2026, 6, 29, 23, 5), false)).toBe('Jul 30');
    });
  });
});
