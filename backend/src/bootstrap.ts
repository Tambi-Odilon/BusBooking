import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { IoAdapter } from '@nestjs/platform-socket.io';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import compress from '@fastify/compress';
import { randomUUID } from 'crypto';
import { AppModule } from './app.module';
import { env } from './common/env';
import { logger } from './common/logger';
import { Db } from './common/db';
import { runMigrations } from './migrate';
import { SettingsService } from './modules/settings/settings.service';
import { httpDuration } from './modules/health/health.controller';

export async function createApp(opts: { migrate?: boolean; swagger?: boolean } = {}): Promise<NestFastifyApplication> {
  const e = env();
  const adapter = new FastifyAdapter({ trustProxy: e.trustProxy, bodyLimit: 1_500_000, genReqId: () => randomUUID() });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, { logger: e.nodeEnv === 'test' ? false : ['error', 'warn'] });
  const fastify = app.getHttpAdapter().getInstance();

  await app.register(cookie as any);
  await app.register(helmet as any, { contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' }, hsts: e.isProd ? { maxAge: 31536000, includeSubDomains: true } : false });
  await app.register(multipart as any, { limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 5 } });
  await app.register(compress as any, { threshold: 1024, encodings: ['br', 'gzip'] });
  app.enableCors({ origin: (origin, cb) => cb(null, !origin || e.corsOrigins.includes(origin) || !e.isProd), credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Booking-Token', 'X-Setup-Token'], exposedHeaders: ['Retry-After'], maxAge: 600 });

  fastify.addHook('onRequest', async (req: any, reply: any) => {
    reply.header('X-Request-Id', req.id);
    if (!req.url.startsWith('/api/docs')) reply.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    reply.header('Cache-Control', 'no-store');
    // Défense CSRF en profondeur : une requête d'écriture venant d'un navigateur doit provenir d'une origine autorisée.
    // (Les callbacks des opérateurs sont des appels serveur à serveur, sans en-tête Origin.)
    const origin = req.headers.origin;
    if (origin && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && e.isProd && !e.corsOrigins.includes(origin))
      return reply.status(403).send({ code: 'CSRF_ORIGIN', message: 'Origine non autorisée' });
  });
  fastify.addHook('onResponse', async (req: any, reply: any) => {
    const route = req.routeOptions?.url || 'unknown';
    const sec = reply.elapsedTime / 1000;
    httpDuration.observe({ method: req.method, route, status: String(reply.statusCode) }, sec);
    if (!route.startsWith('/health') && route !== '/metrics')
      logger[reply.statusCode === 503 ? 'warn' : reply.statusCode >= 500 ? 'error' : 'info']({ reqId: req.id, method: req.method, url: route, status: reply.statusCode, ms: Math.round(reply.elapsedTime), ip: req.ip }, 'requête');
  });

  app.setGlobalPrefix('api/v1', { exclude: ['health/live', 'health/ready', 'metrics'] });
  app.useWebSocketAdapter(new IoAdapter(app));
  app.enableShutdownHooks();

  if (opts.migrate !== false) {
    const applied = await runMigrations(app.get(Db).pool);
    if (applied.length) logger.info({ applied }, 'migrations appliquées');
    await app.get(SettingsService).ensureReferenceData();
  }
  if (opts.swagger !== false) {
    const config = new DocumentBuilder().setTitle('API de réservation de billets de bus').setDescription('API REST. Authentification par jeton Bearer (15 min) renouvelé via /auth/refresh. Temps réel : Socket.IO sur /socket.io.')
      .setVersion(e.version).addBearerAuth().build();
    SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, config), { jsonDocumentUrl: 'api/docs/openapi.json' });
  }
  return app;
}
