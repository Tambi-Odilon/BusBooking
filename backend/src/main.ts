import { createApp } from './bootstrap';
import { env } from './common/env';
import { logger } from './common/logger';

async function main() {
  const app = await createApp();
  await app.listen(env().port, env().host);
  logger.info({ port: env().port, role: env().role, version: env().version }, 'API démarrée');
}
process.on('unhandledRejection', (e: any) => logger.error({ err: e?.message || e }, 'promesse rejetée non gérée'));
main().catch(e => { logger.fatal({ err: e?.message || e }, 'démarrage impossible'); process.exit(1); });
