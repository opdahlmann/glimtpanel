import { RuleInfoDto } from '@core/live.types';
import { ruleChanges, serverOverrides, toDraft } from './alert-settings.component';

function rule(overrides: Partial<RuleInfoDto> & Pick<RuleInfoDto, 'id'>): RuleInfoDto {
  return { severity: 'warning', thresholdUnit: 'percent', defaultThreshold: 95, defaultDurationSec: 300, enabled: true, threshold: 95, durationSec: 300, overridden: false, ...overrides };
}

describe('alert-settings', () => {
  const loaded = [
    rule({ id: 'server_down', severity: 'critical', thresholdUnit: 'seconds', defaultThreshold: null, defaultDurationSec: 120, threshold: null, durationSec: 120 }),
    rule({ id: 'disk_full', severity: 'critical', defaultThreshold: 90, defaultDurationSec: null, threshold: 90, durationSec: null }),
    rule({ id: 'mem_pressure' }),
    rule({ id: 'reboot', severity: 'info', thresholdUnit: 'none', defaultThreshold: null, defaultDurationSec: null, threshold: null, durationSec: null }),
  ];

  it('toDraft gir minutter og fast rekkefølge', () => {
    const draft = toDraft([loaded[2], loaded[0]]);
    expect(draft.map((d) => d.id)).toEqual(['server_down', 'mem_pressure']);
    expect(draft[0]).toEqual({ id: 'server_down', enabled: true, threshold: null, minutes: 2 });
    expect(draft[1]).toEqual({ id: 'mem_pressure', enabled: true, threshold: 95, minutes: 5 });
  });

  it('ruleChanges sender bare det som avviker fra det lagrede', () => {
    const draft = toDraft(loaded);
    expect(ruleChanges(loaded, draft)).toEqual({});
    draft.find((d) => d.id === 'mem_pressure')!.threshold = 90;
    draft.find((d) => d.id === 'mem_pressure')!.minutes = 10;
    draft.find((d) => d.id === 'reboot')!.enabled = false;
    expect(ruleChanges(loaded, draft)).toEqual({ mem_pressure: { threshold: 90, durationSec: 600 }, reboot: { enabled: false } });
  });

  it('serverOverrides er hele avviket fra kontostandarden', () => {
    const account = [rule({ id: 'mem_pressure', threshold: 90, durationSec: 600, defaultThreshold: 90, defaultDurationSec: 600 })];
    const draft = toDraft(account);
    expect(serverOverrides(account, draft)).toEqual({});
    draft[0].threshold = 80;
    draft[0].enabled = false;
    expect(serverOverrides(account, draft)).toEqual({ mem_pressure: { enabled: false, threshold: 80 } });
  });
});
