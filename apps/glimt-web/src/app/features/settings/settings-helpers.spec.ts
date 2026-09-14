import { GrantDto } from '@core/live.types';
import { grantRow } from './access-settings.component';
import { offsetLabel, timeZoneOptions } from './account-settings.component';

/** Rene hjelpere i innstillingene (steg 8.2 og 8.4): tidssoner med offset, tilgangsrader. */
describe('settings helpers', () => {
  it('tidssonelisten har offset i teksten og tar med profilens sone', () => {
    const summer = new Date('2026-07-01T12:00:00Z');
    expect(offsetLabel('Europe/Oslo', summer)).toBe('UTC+02:00');
    expect(offsetLabel('UTC', summer)).toBe('UTC+00:00');
    expect(offsetLabel('America/New_York', summer)).toBe('UTC-04:00');
    const options = timeZoneOptions('Europe/Oslo', summer);
    expect(options.find((o) => o.value === 'Europe/Oslo')?.label).toBe('Europe/Oslo (UTC+02:00)');
    expect(options.length).toBeGreaterThan(10);
  });

  it('grantRow: All servers eller taggene, og pending', () => {
    const base: GrantDto = { id: 'g1', email: 'kari@example.com', scope: 'all', status: 'accepted', createdAt: '2026-09-14T08:00:00Z', initials: 'KH' };
    expect(grantRow(base, 'All servers')).toEqual({ id: 'g1', initials: 'KH', email: 'kari@example.com', scope: 'All servers', status: 'accepted', pending: false });
    expect(grantRow({ ...base, scope: ['client-a', 'client-b'], status: 'pending' }, 'All servers')).toMatchObject({ scope: 'client-a, client-b', pending: true });
  });
});
