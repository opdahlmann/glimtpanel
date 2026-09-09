import { formatBytes, formatDuration, formatDurationClock, formatGb, formatRate, formatTime } from './format';
import { metricColor, thr, withAlpha } from './thr';

describe('format utils', () => {
  it('thr returns crit from 90, warn from 80, otherwise the base colour', () => {
    expect(thr(79.9, 'var(--color-disk)')).toBe('var(--color-disk)');
    expect(thr(80, 'var(--color-disk)')).toBe('var(--color-warn)');
    expect(thr(89.9, 'x')).toBe('var(--color-warn)');
    expect(thr(90, 'x')).toBe('var(--color-crit)');
    expect(metricColor('cpu')).toBe('var(--color-cpu)');
    expect(metricColor('#fff')).toBe('#fff');
    expect(withAlpha('#0a84ff', '14', 8)).toBe('#0a84ff14');
    expect(withAlpha('var(--color-cpu)', '14', 8)).toBe('color-mix(in srgb, var(--color-cpu) 8%, transparent)');
  });

  it('formatBytes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(412 * 1024 ** 2)).toBe('412.0 MB');
    expect(formatBytes(8 * 1024 ** 3)).toBe('8.0 GB');
    expect(formatBytes(2.5 * 1024 ** 4)).toBe('2.5 TB');
  });

  it('formatRate and formatGb use one decimal', () => {
    expect(formatRate(15518924)).toBe('14.8');
    expect(formatRate(15518924, true)).toBe('14.8 MB/s');
    expect(formatRate(0)).toBe('0.0');
    expect(formatGb(8 * 1024 ** 3)).toBe('8.0');
    expect(formatGb(4.94 * 1024 ** 3, true)).toBe('4.9 GB');
  });

  it('formatDuration', () => {
    expect(formatDuration(12 * 86400 + 4 * 3600 + 59 * 60)).toBe('12d 4h');
    expect(formatDuration(4 * 3600 + 12 * 60)).toBe('4h 12m');
    expect(formatDuration(12 * 60 + 5)).toBe('12m');
    expect(formatDuration(45)).toBe('45s');
    expect(formatDurationClock(3 * 86400 + 4 * 3600 + 12 * 60)).toBe('3d 04:12');
    expect(formatDurationClock(4 * 3600 + 12 * 60 + 33)).toBe('04:12:33');
  });

  it('formatTime uses 24-hour Intl output in the given zone', () => {
    const ms = Date.UTC(2026, 8, 10, 22, 14, 5);
    expect(formatTime(ms, { timeZone: 'Europe/Oslo' })).toBe('00:14');
    expect(formatTime(ms, { timeZone: 'Europe/Oslo', seconds: true })).toBe('00:14:05');
    expect(formatTime(ms, { timeZone: 'UTC', seconds: true })).toBe('22:14:05');
    expect(formatTime(Date.UTC(2026, 0, 1, 0, 0), { timeZone: 'UTC' })).toBe('00:00');
  });
});
