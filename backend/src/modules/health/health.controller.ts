import { Controller, Get, Headers, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import * as client from 'prom-client';
import { Public } from '../../common/auth';
import { Db } from '../../common/db';
import { RedisService } from '../../common/redis';
import { AppError } from '../../common/errors';
import { env } from '../../common/env';
import { safeEqual } from '../../common/crypto';
import { RealtimeGateway } from '../realtime/realtime.gateway';

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });
export const httpDuration = new client.Histogram({ name: 'http_request_duration_seconds', help: 'Durée des requêtes HTTP', labelNames: ['method', 'route', 'status'], buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10], registers: [registry] });

@ApiTags('Supervision')
@Controller()
export class HealthController {
  constructor(private db: Db, private redis: RedisService, private gateway: RealtimeGateway) {
    const g = (name: string, help: string, collect: () => number) => { if (!registry.getSingleMetric(name)) new client.Gauge({ name, help, registers: [registry], collect() { this.set(collect()); } }); };
    g('db_pool_total', 'Connexions PostgreSQL ouvertes', () => this.db.pool.totalCount);
    g('db_pool_waiting', 'Requêtes en attente d\'une connexion', () => this.db.pool.waitingCount);
    g('ws_connections', 'Clients temps réel connectés', () => this.gateway.connections);
  }
  @Public() @Get('health/live') live() { return { status: 'ok', version: env().version, uptime: Math.round(process.uptime()) }; }
  @Public() @Get('health/ready')
  async ready(@Res({ passthrough: true }) res: any) {
    const checks: Record<string, string> = {};
    try { await this.db.pool.query('SELECT 1'); checks.database = 'ok'; } catch { checks.database = 'down'; }
    try { checks.redis = (await this.redis.client.ping()) === 'PONG' ? 'ok' : 'down'; } catch { checks.redis = 'down'; }
    const ok = checks.database === 'ok';   // sans Redis l'API reste utilisable (mode dégradé : pas de limitation de débit ni de diffusion entre instances)
    if (!ok) res.status(503);
    return { status: ok ? (checks.redis === 'ok' ? 'ok' : 'degraded') : 'down', checks };
  }
  /** Métriques Prometheus, protégées par METRICS_TOKEN. */
  @Public() @Get('metrics')
  async metrics(@Headers('authorization') auth: string, @Res() res: any) {
    const token = process.env.METRICS_TOKEN || '';
    if (!token || !safeEqual(String(auth || ''), `Bearer ${token}`)) throw new AppError('NOT_FOUND', 404);
    res.header('Content-Type', registry.contentType).send(await registry.metrics());
  }
}
