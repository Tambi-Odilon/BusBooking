import { Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { env } from './env';
import { AppError } from './errors';

@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly client: Redis;
  constructor() {
    this.client = new Redis(env().redisUrl, { maxRetriesPerRequest: 2, enableOfflineQueue: true, lazyConnect: false });
    this.client.on('error', () => { /* reconnexion automatique */ });
  }
  duplicate() { const c = this.client.duplicate(); c.on('error', () => {}); return c; }
  async getJson<T>(key: string): Promise<T | null> { try { const v = await this.client.get(key); return v ? JSON.parse(v) : null; } catch { return null; } }
  async setJson(key: string, value: any, ttlSec: number) { try { await this.client.set(key, JSON.stringify(value), 'EX', ttlSec); } catch { /* le cache est facultatif */ } }
  async del(...keys: string[]) { try { if (keys.length) await this.client.del(...keys); } catch { /* idem */ } }
  async onModuleDestroy() { try { await this.client.quit(); } catch { this.client.disconnect(); } }
}

/** Limitation de débit à fenêtre fixe. Si Redis est indisponible, on laisse passer (la base reste protégée par le délestage). */
@Injectable()
export class RateLimiter {
  factor = env().rateLimitFactor;
  constructor(private redis: RedisService) {}
  async hit(bucket: string, id: string, limit: number, windowSec: number): Promise<void> {
    const max = Math.max(1, Math.floor(limit * this.factor));
    const key = `rl:${bucket}:${id}:${Math.floor(Date.now() / 1000 / windowSec)}`;
    let n: number;
    try {
      const r = await this.redis.client.multi().incr(key).expire(key, windowSec + 1).exec();
      n = Number(r?.[0]?.[1] ?? 0);
    } catch { return; }
    if (n > max) {
      const retry = windowSec - (Math.floor(Date.now() / 1000) % windowSec);
      throw new AppError('RATE_LIMITED', 429, 'Trop de requêtes, réessayez dans un instant', { retryAfter: retry }, { 'Retry-After': String(retry) });
    }
  }
}
