import { AlertDto, RuleInfoDto } from '@core/live.types';
import { alertColor, alertLink, filterAlerts, orderRules, ruleDefaultText, ruleNameKey } from './alerts.model';
import { sortAlerts } from '@core/alert.store';

function alert(overrides: Partial<AlertDto> & Pick<AlertDto, 'id'>): AlertDto {
  return {
    serverId: 's1',
    serverName: 'web-02',
    rule: 'disk_full',
    key: '/',
    severity: 'critical',
    state: 'firing',
    detail: '/ · 92 %',
    firedAt: '2026-09-14T06:11:00Z',
    resolvedAt: null,
    lastReminderAt: null,
    silenced: false,
    notifiedVia: [],
    ...overrides,
  };
}

function rule(overrides: Partial<RuleInfoDto> & Pick<RuleInfoDto, 'id'>): RuleInfoDto {
  return { severity: 'warning', thresholdUnit: 'percent', defaultThreshold: 95, defaultDurationSec: 300, enabled: true, threshold: 95, durationSec: 300, overridden: false, ...overrides };
}

const t = (k: string) => `[${k}]`;

describe('alerts.model', () => {
  it('sorterer nyeste først: aktive på firedAt, løste på resolvedAt', () => {
    const list = sortAlerts([
      alert({ id: 'a', firedAt: '2026-09-14T06:00:00Z' }),
      alert({ id: 'b', firedAt: '2026-09-14T05:00:00Z', state: 'resolved', resolvedAt: '2026-09-14T07:00:00Z' }),
      alert({ id: 'c', firedAt: '2026-09-14T06:30:00Z' }),
    ]);
    expect(list.map((a) => a.id)).toEqual(['b', 'c', 'a']);
  });

  it('filtrerer på tilstand og farger prikken', () => {
    const list = [alert({ id: 'a' }), alert({ id: 'b', state: 'resolved', resolvedAt: '2026-09-14T07:00:00Z' }), alert({ id: 'c', severity: 'warning' }), alert({ id: 'd', severity: 'info' })];
    expect(filterAlerts(list, 'active').map((a) => a.id)).toEqual(['a', 'c', 'd']);
    expect(filterAlerts(list, 'resolved').map((a) => a.id)).toEqual(['b']);
    expect(filterAlerts(list, 'all')).toHaveLength(4);
    expect(alertColor(list[0])).toBe('var(--color-crit)');
    expect(alertColor(list[1])).toBe('var(--color-ram)');
    expect(alertColor(list[2])).toBe('var(--color-warn)');
    expect(alertColor(list[3])).toBe('var(--color-info)');
  });

  it('lenker tjenestefeil til loggene med enheten og resten til panelet', () => {
    expect(alertLink(alert({ id: 'a', rule: 'svc_failed', key: 'cron-sync.service' }))).toEqual({ path: ['/logs'], query: { server: 's1', source: 'journal', unit: 'cron-sync.service' } });
    expect(alertLink(alert({ id: 'a', rule: 'disk_full' }))).toEqual({ path: ['/servers', 's1'], fragment: 'disk' });
    expect(alertLink(alert({ id: 'a', rule: 'cont_restart' }))).toEqual({ path: ['/servers', 's1'], fragment: 'cont' });
    expect(alertLink(alert({ id: 'a', rule: 'server_down' }))).toEqual({ path: ['/servers', 's1'] });
    expect(ruleNameKey('mem_pressure')).toBe('r_mem_pressure');
  });

  it('bygger standardteksten av deler når terskelen er justert, ellers fra ordboken', () => {
    expect(ruleDefaultText(rule({ id: 'mem_pressure' }), t, 'min')).toBe('[d_mem_pressure]');
    expect(ruleDefaultText(rule({ id: 'mem_pressure', threshold: 90, durationSec: 600 }), t, 'min')).toBe('> 90 % [d_for] 10 min');
    expect(ruleDefaultText(rule({ id: 'disk_full', thresholdUnit: 'percent', defaultThreshold: 90, defaultDurationSec: null, threshold: 95, durationSec: null }), t, 'min')).toBe('> 95 % [d_disk_full_post]');
    expect(ruleDefaultText(rule({ id: 'server_down', thresholdUnit: 'seconds', defaultThreshold: null, defaultDurationSec: 120, threshold: null, durationSec: 300 }), t, 'min')).toBe('[d_server_down_pre] 5 min');
    expect(ruleDefaultText(rule({ id: 'cont_restart', thresholdUnit: 'count', defaultThreshold: 3, defaultDurationSec: 600, threshold: 5, durationSec: 600 }), t, 'min')).toBe('[d_cont_restart_pre] > 5 [d_cont_restart_post] 10 min');
    expect(orderRules([rule({ id: 'reboot' }), rule({ id: 'server_down' })]).map((r) => r.id)).toEqual(['server_down', 'reboot']);
  });
});
