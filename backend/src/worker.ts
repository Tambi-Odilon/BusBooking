// Processus dédié aux tâches planifiées (APP_ROLE=worker) : même code que l'API, sans exposer de port public.
process.env.APP_ROLE = process.env.APP_ROLE || 'worker';
import { createApp } from './bootstrap';
import { logger } from './common/logger';

createApp({ swagger: false }).then(async app => { await app.init(); logger.info('worker démarré'); })
  .catch(e => { logger.fatal({ err: e?.message || e }, 'démarrage du worker impossible'); process.exit(1); });
