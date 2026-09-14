import en from '@i18n/en.json';
import { CardDto } from '@core/live.types';
import { I18nKey } from '@core/i18n.service';
import { cardView, CardTexts, f1, gbLabel, osShort, severityColor } from './card-view';
import { demoCardByName } from '../overview.fixtures';

const texts: CardTexts = {
  t: (key: I18nKey) => en[key],
  formatWhen: () => '03:12',
};

describe('cardView', () => {
  it('oppe: live, grønn prikk, ringer og undertekster som prototypen', () => {
    const v = cardView(demoCardByName('web-02'), texts);
    expect(v.status).toBe('up');
    expect(v.dimmed).toBe(false);
    expect(v.dot).toBe('up');
    expect(v.statusText).toBe('live');
    expect(v.info).toBe('Ubuntu 24.04 · 4 cores · 8 GB · up 41d 4h');
    expect(v.cpu).toBe(48);
    expect(v.cpuSub).toBe('1.9 of 4 cores');
    expect(v.memSub).toBe('4.9 of 8 GB');
    expect(v.disk).toBe(92);
    expect(v.diskSub).toBe('/ 92%');
    expect(v.net).toBe('↓15.8 ↑1.2');
    expect(v.containers).toBe('6 / 6');
    expect(v.containersTone).toBe('default');
    expect(v.updates).toBe('7 (2)');
    expect(v.updatesTone).toBe('warn');
    expect(v.reboot).toBe('—');
    expect(v.rebootTone).toBe('muted');
    expect(v.services).toBe('ok');
    expect(v.stripe).toBe('var(--color-crit)');
    expect(v.ariaLabel).toBe('web-02: live, CPU 48%, Memory 61%, Disk 92%');
  });

  it('nede: «last seen», rød prikk, ringer på 0, opasitet, nett «—»', () => {
    const v = cardView(demoCardByName('nordic-db'), texts);
    expect(v.dimmed).toBe(true);
    expect(v.dot).toBe('down');
    expect(v.statusText).toBe('last seen 03:12');
    expect(v.cpu).toBe(0);
    expect(v.mem).toBe(0);
    expect(v.disk).toBe(0);
    expect(v.diskSub).toBe('—');
    expect(v.net).toBe('—');
    expect(v.info).toBe('Ubuntu 24.04 · 4 cores · 16 GB');
    expect(v.ariaLabel).toContain('last seen 03:12');
  });

  it('pauset: nøytral prikk, opasitet .6, ingen stripe selv med varsel', () => {
    const v = cardView({ ...demoCardByName('media'), activeAlerts: 2 }, texts);
    expect(v.dot).toBe('paused');
    expect(v.dimmed).toBe(true);
    expect(v.statusText).toBe('paused');
    expect(v.stripe).toBe('transparent');
  });

  it('chips: containere gule når noen ikke kjører, «—» uten Docker, omstart og feilet tjeneste', () => {
    const web01 = cardView(demoCardByName('web-01'), texts);
    expect(web01.containers).toBe('7 / 8');
    expect(web01.containersTone).toBe('swap');
    const backup = cardView(demoCardByName('backup'), texts);
    expect(backup.containers).toBe('—');
    expect(backup.updates).toBe('31 (14)');
    const db = cardView(demoCardByName('db-prod'), texts);
    expect(db.reboot).toBe('required');
    expect(db.rebootTone).toBe('warn');
    const worker = cardView(demoCardByName('worker-01'), texts);
    expect(worker.services).toBe('1 failed');
    expect(worker.servicesTone).toBe('crit');
    const api = cardView(demoCardByName('api-prod'), texts);
    expect(api.updates).toBe('0');
    expect(api.updatesTone).toBe('default');
  });

  it('tåler et kort uten snapshot (kun status)', () => {
    const bare: CardDto = { ...demoCardByName('web-01'), os: null, versionId: null, cores: null, ramBytes: null, uptimeSec: null, updates: null, securityUpdates: null, rebootRequired: null, diskWorst: null, netRx: null, netTx: null };
    const v = cardView(bare, texts);
    expect(v.info).toBe('');
    expect(v.cpuSub).toBe('');
    expect(v.memSub).toBe('');
    expect(v.diskSub).toBe('—');
    expect(v.updates).toBe('—');
    expect(v.reboot).toBe('—');
  });

  it('hjelpere: f1, gbLabel, osShort, severityColor', () => {
    expect(f1(1.94)).toBe('1.9');
    expect(f1(2)).toBe('2.0');
    expect(gbLabel(8 * 1024 ** 3)).toBe('8');
    expect(gbLabel(7.8 * 1024 ** 3)).toBe('7.8');
    expect(gbLabel(null)).toBe('—');
    expect(osShort({ os: 'Ubuntu 24.04.3 LTS', versionId: '24.04' })).toBe('Ubuntu 24.04');
    expect(osShort({ os: 'Debian GNU/Linux 12', versionId: '12' })).toBe('Debian GNU/Linux 12');
    expect(severityColor({ activeAlerts: 0, status: 'up', alertSeverity: null })).toBe('transparent');
    expect(severityColor({ activeAlerts: 1, status: 'up', alertSeverity: 'critical' })).toBe('var(--color-crit)');
    expect(severityColor({ activeAlerts: 1, status: 'up', alertSeverity: 'warning' })).toBe('var(--color-warn)');
    expect(severityColor({ activeAlerts: 1, status: 'up', alertSeverity: 'info' })).toBe('var(--color-info)');
    expect(severityColor({ activeAlerts: 2, status: 'paused', alertSeverity: 'critical' })).toBe('transparent');
  });
});
