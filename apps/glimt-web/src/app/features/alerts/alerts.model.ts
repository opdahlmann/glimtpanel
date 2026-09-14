import { I18nKey } from '@core/i18n.service';
import { ALERT_RULE_IDS, AlertDto, AlertRuleId, AlertSeverity, RuleInfoDto } from '@core/live.types';

export type AlertFilter = 'active' | 'resolved' | 'all';
export const ALERT_FILTERS: readonly AlertFilter[] = ['active', 'resolved', 'all'];

/** Ordboksnøkler per regel: navn (`r_*`) og standard (`d_*`). */
export function ruleNameKey(rule: AlertRuleId): I18nKey {
  return `r_${rule}` as I18nKey;
}

export function ruleDefaultKey(rule: AlertRuleId): I18nKey {
  return `d_${rule}` as I18nKey;
}

export function severityKey(severity: AlertSeverity): I18nKey {
  return severity === 'critical' ? 'critical' : severity === 'warning' ? 'warning' : 'info';
}

/** Prikkens farge: rød kritisk, oransje advarsel, nøytral info; grønn når løst. */
export function alertColor(alert: Pick<AlertDto, 'severity' | 'state'>): string {
  if (alert.state === 'resolved') return 'var(--color-ram)';
  return severityColor(alert.severity);
}

export function severityColor(severity: AlertSeverity): string {
  return severity === 'critical' ? 'var(--color-crit)' : severity === 'warning' ? 'var(--color-warn)' : 'var(--color-info)';
}

export function filterAlerts(alerts: AlertDto[], filter: AlertFilter): AlertDto[] {
  if (filter === 'all') return alerts;
  return alerts.filter((a) => (filter === 'active' ? a.state === 'firing' : a.state === 'resolved'));
}

/** Hvor et klikk på regelen går: tjenestefeil → loggene med enheten, ellers serversiden med panelet. */
export function alertLink(alert: Pick<AlertDto, 'rule' | 'serverId' | 'key'>): { path: string[]; query?: Record<string, string>; fragment?: string } {
  const server = ['/servers', alert.serverId];
  switch (alert.rule) {
    case 'svc_failed':
      return { path: ['/logs'], query: { server: alert.serverId, source: 'journal', unit: alert.key } };
    case 'disk_full':
      return { path: server, fragment: 'disk' };
    case 'mem_pressure':
      return { path: server, fragment: 'mem' };
    case 'cpu_sat':
      return { path: server, fragment: 'cpu' };
    case 'cont_restart':
      return { path: server, fragment: 'cont' };
    case 'reboot':
      return { path: server, fragment: 'maint' };
    default:
      return { path: server };
  }
}

/**
 * Standardteksten for regelseksjonen, bygget av delene så justerte terskler vises riktig («> 92 % on a mount»,
 * «> 90 % for 10 min»). Uten justering brukes ordbokens `d_*`-tekst som den er.
 */
export function ruleDefaultText(rule: RuleInfoDto, t: (key: I18nKey) => string, minLabel: string): string {
  const adjusted = rule.threshold !== rule.defaultThreshold || rule.durationSec !== rule.defaultDurationSec;
  if (!adjusted) return t(ruleDefaultKey(rule.id));
  const minutes = rule.durationSec === null ? null : Math.round(rule.durationSec / 60);
  switch (rule.id) {
    case 'server_down':
      return `${t('d_server_down_pre')} ${minutes} ${minLabel}`;
    case 'disk_full':
      return `> ${rule.threshold} % ${t('d_disk_full_post')}`;
    case 'mem_pressure':
    case 'cpu_sat':
      return `> ${rule.threshold} % ${t('d_for')} ${minutes} ${minLabel}`;
    case 'cont_restart':
      return `${t('d_cont_restart_pre')} > ${rule.threshold} ${t('d_cont_restart_post')} ${minutes} ${minLabel}`;
    default:
      return t(ruleDefaultKey(rule.id));
  }
}

/** Regler i fast rekkefølge (den hub og ordbok deler). */
export function orderRules<T extends { id: AlertRuleId }>(rules: T[]): T[] {
  return [...rules].sort((a, b) => ALERT_RULE_IDS.indexOf(a.id) - ALERT_RULE_IDS.indexOf(b.id));
}
