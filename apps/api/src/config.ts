import { readFileSync } from 'node:fs';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Falta la variable de entorno ${name}`);
  return v;
}

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 3020),
  instanceId: process.env.INSTANCE_ID ?? `${process.pid}`,
  databaseUrl: required('DATABASE_URL'),
  databaseSsl: process.env.DATABASE_SSL === 'true',
  /** CA de RDS (global-bundle.pem). Con él se verifica el certificado del servidor. */
  databaseCaPath: process.env.DATABASE_CA_PATH,
  dbPoolMax: Number(process.env.DB_POOL_MAX ?? 10),
  jwtSecret: required('JWT_SECRET'),
  accessTtlSeconds: 15 * 60,
  refreshTtlDays: 60,
  publicOrigin: process.env.PUBLIC_ORIGIN ?? 'http://localhost:5173',
  /** Orígenes extra permitidos (apps de escritorio/móvil con WebView). */
  extraOrigins: (process.env.EXTRA_ORIGINS ?? 'tauri://localhost,http://tauri.localhost,capacitor://localhost,https://localhost')
    .split(',').map((s) => s.trim()).filter(Boolean),
  cookieSecure: process.env.COOKIE_SECURE !== 'false',
  /** Origen público del API (para las redirect URI de Google/Microsoft). */
  apiPublicOrigin: process.env.API_PUBLIC_ORIGIN ?? process.env.PUBLIC_ORIGIN ?? 'http://localhost:3020',
  /** A dónde vuelve el navegador de las apps nativas y de escritorio. */
  nativeRedirect: process.env.SSO_NATIVE_REDIRECT ?? 'tiecoms://auth/callback',
  google: { clientId: process.env.GOOGLE_CLIENT_ID ?? '', clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '' },
  microsoft: { clientId: process.env.MICROSOFT_CLIENT_ID ?? '', clientSecret: process.env.MICROSOFT_CLIENT_SECRET ?? '' },
  trustProxy: process.env.TRUST_PROXY !== 'false',
  /** Remitente de los correos (Brevo). Debe estar verificado en la cuenta de Brevo. */
  mailFrom: process.env.MAIL_FROM ?? 'admin@tiecoms.com',
  mailFromName: process.env.MAIL_FROM_NAME ?? 'TieComs',
};

export function pgSsl() {
  if (!config.databaseSsl) return undefined;
  if (config.databaseCaPath) return { ca: readFileSync(config.databaseCaPath, 'utf8'), rejectUnauthorized: true };
  return { rejectUnauthorized: false };
}

if (config.jwtSecret.length < 32) throw new Error('JWT_SECRET debe tener al menos 32 caracteres');
