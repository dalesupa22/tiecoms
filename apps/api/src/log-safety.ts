/** Request logs never contain OAuth queries or webhook path credentials, including malformed routes. */
export function safeRequestPath(raw: string | undefined): string | undefined {
  if (!raw) return raw;
  const path = raw.split('?')[0]!;
  // Decode valid ASCII escape pairs independently. A malformed escape in the secret
  // suffix must not prevent recognizing an encoded /api/hooks prefix.
  const decoded = path.replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  return /^(?:https?:\/\/[^/]+)?\/api\/hooks(?:\/|$)/i.test(decoded)
    ? '/api/hooks/[redacted]' : path;
}
