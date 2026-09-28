/** Request logs never contain OAuth queries or webhook path credentials, including malformed routes. */
export function safeRequestPath(raw: string | undefined): string | undefined {
  if (!raw) return raw;
  const path = raw.split('?')[0]!;
  let decoded = path;
  try { decoded = decodeURIComponent(path); } catch { /* redact malformed encoded hooks conservatively below */ }
  return /^\/api\/hooks(?:\/|$)/i.test(decoded) || /^\/api\/(?:hooks|%68%6f%6f%6b%73)/i.test(path)
    ? '/api/hooks/[redacted]' : path;
}
