/** "Ole Petter Dahlmann" → "OD", "ole@kodetank.no" → "O", tomt → "?". */
export function initials(name: string | null | undefined, email?: string | null): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  const e = (email ?? '').trim();
  return e ? e[0].toUpperCase() : '?';
}
