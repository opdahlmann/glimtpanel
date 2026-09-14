/**
 * Snuttene fra `POST /api/servers` (steg 12.10) med de valgfrie feltene fylt inn: huben skriver de valgfrie
 * variablene som kommenterte linjer (`# GLIMT_HEALTH_URL: …`), og dialogen erstatter dem med brukerens verdier.
 */
export type SnippetVariant = 'compose' | 'dockerfile';

export interface SnippetOptions {
  healthUrl: string;
  checks: string;
  logPaths: string;
}

const OPTIONAL: { key: keyof SnippetOptions; env: string }[] = [
  { key: 'healthUrl', env: 'GLIMT_HEALTH_URL' },
  { key: 'checks', env: 'GLIMT_CHECKS' },
  { key: 'logPaths', env: 'GLIMT_LOG_PATHS' },
];

export function applyOptions(snippet: string, variant: SnippetVariant, opts: SnippetOptions): string {
  const set = OPTIONAL.map((o) => ({ ...o, value: opts[o.key].trim() })).filter((o) => o.value);
  if (variant === 'compose') {
    let out = snippet;
    for (const o of set) {
      const line = new RegExp(`^(\\s*)# ${o.env}: .*$`, 'm');
      out = line.test(out) ? out.replace(line, `$1${o.env}: ${o.value}`) : out.trimEnd() + `\n      ${o.env}: ${o.value}\n`;
    }
    return out;
  }
  if (set.length === 0) return snippet;
  const env = set.map((o) => `${o.env}=${quote(o.value)}`).join(' ');
  const lines = snippet.split('\n');
  const i = lines.findIndex((l) => l.startsWith('ENV GLIMT_HUB='));
  lines.splice(i < 0 ? lines.length : i + 1, 0, `ENV ${env}`);
  return lines.join('\n');
}

function quote(v: string): string {
  return /\s/.test(v) ? `"${v.replace(/"/g, '\\"')}"` : v;
}
