/** HTML-renderere i innstillingsgridene (steg 8.3–8.4) bygger streng-HTML; alt fra data escapes. */
export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}
