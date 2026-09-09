import { ConfigService, CONFIG_URL, DEFAULT_CONFIG, normalizeConfig } from './config.service';

const remote = {
  env: 'production',
  apiUrl: '/api',
  hubUrl: '/hub/live',
  hubPublicUrl: 'https://api.glimtpanel.com',
  installUrl: 'https://get.glimtpanel.com',
  docsUrl: 'https://github.com/opdahlmann/glimtpanel#readme',
  vapidPublic: 'BPublicKey',
  defaultLang: 'no',
  featureFlags: ['textmode', 'snapshot'],
};

describe('ConfigService', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('starts with the default config and loaded=false', () => {
    const service = new ConfigService();
    expect(service.config()).toEqual(DEFAULT_CONFIG);
    expect(service.loaded()).toBe(false);
  });

  it('populates the config signal from /config.json', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => remote });
    vi.stubGlobal('fetch', fetchMock);

    const service = new ConfigService();
    await service.load();

    expect(fetchMock).toHaveBeenCalledWith(CONFIG_URL, { cache: 'no-store' });
    expect(service.config()).toEqual(remote);
    expect(service.loaded()).toBe(true);
    expect(service.hasFlag('textmode')).toBe(true);
    expect(service.hasFlag('groups')).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('fills missing keys from the defaults', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ env: 'e2e' }) }));

    const service = new ConfigService();
    await service.load();

    expect(service.config()).toEqual({ ...DEFAULT_CONFIG, env: 'e2e' });
  });

  it('falls back to defaults with a warning when fetch rejects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    const service = new ConfigService();
    await expect(service.load()).resolves.toBeUndefined();

    expect(service.config()).toEqual(DEFAULT_CONFIG);
    expect(service.loaded()).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(CONFIG_URL);
  });

  it('falls back to defaults with a warning on a non-OK response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) }));

    const service = new ConfigService();
    await service.load();

    expect(service.config()).toEqual(DEFAULT_CONFIG);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('normalizeConfig', () => {
  it('drops non-string feature flags and tolerates null', () => {
    expect(normalizeConfig(null)).toEqual(DEFAULT_CONFIG);
    expect(normalizeConfig({ featureFlags: ['a', 1, '', null] as unknown as string[] }).featureFlags).toEqual(['a']);
  });
});
