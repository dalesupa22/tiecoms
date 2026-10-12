import { config } from './config.ts';
import { pool } from './db.ts';
import { buildHttp } from './http.ts';
import { migrate } from './migrate.ts';
import { createRealtime } from './realtime.ts';
import { startMemoryWatch } from './memory-watch.ts';

// Un error inesperado se registra; el proceso sigue atendiendo en vez de caerse.
process.on('unhandledRejection', (e: any) => console.error('[api] promesa sin manejar', e?.message ?? e));

async function main() {
  if (process.env.MIGRATE_ON_START !== 'false') await migrate();
  const app = await buildHttp();
  const rt = createRealtime(app.server);
  await app.listen({ host: '0.0.0.0', port: config.port });
  app.log.info({ instance: config.instanceId }, 'tiecoms api lista');

  let closing = false;
  const shutdown = async (sig: string, code = 0) => {
    if (closing) return;
    closing = true;
    app.log.info({ sig }, 'cerrando de forma ordenada');
    const force = setTimeout(() => process.exit(1), 15_000);
    force.unref();
    await rt.close().catch(() => {});
    await app.close().catch(() => {});
    await pool.end().catch(() => {});
    process.exit(code);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  // Antes de un «heap out of memory» se cierra ordenado y Docker lo vuelve a levantar (sale con 1 para que quede registrado).
  startMemoryWatch(() => void shutdown('memoria', 1));
}

main().catch((e) => {
  console.error('[api] no arrancó', e);
  process.exit(1);
});
