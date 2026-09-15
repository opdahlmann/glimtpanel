import { toLogLine } from '@core/log-stream.service';
import { demoServer } from '../server/server.fixtures';
import { findContainer } from './container.page';

describe('ContainerPage-hjelpere', () => {
  it('findContainer finner på full id, kort id og navn', () => {
    const s = demoServer();
    expect(findContainer(s, 'c0web')?.name).toBe('web-web');
    expect(findContainer(s, 'c1')?.name).toBe('web-api');
    expect(findContainer(s, 'web-cron')?.name).toBe('web-cron');
    expect(findContainer(s, 'nope')).toBeNull();
    expect(findContainer(null, 'c0web')).toBeNull();
  });

  it('toLogLine oversetter hubens prioritet og felter', () => {
    expect(toLogLine({ ts: 1, unit: null, container: 'web-web', priority: null, message: 'm' })).toEqual({ ts: 1, unit: undefined, container: 'web-web', priority: 'info', message: 'm' });
    expect(toLogLine({ ts: 2, unit: 'sshd', container: null, priority: 'err', message: 'x' }).priority).toBe('err');
    expect(toLogLine({ ts: 3, unit: 'sshd', container: null, priority: 'warn', message: 'x' }).priority).toBe('warn');
  });
});
