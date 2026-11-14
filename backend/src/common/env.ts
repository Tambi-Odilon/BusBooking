import { createHash } from 'crypto';

function req(name: string, devDefault: string): string {
  const v = process.env[name];
  if (v && v.length > 0) return v;
  if (process.env.NODE_ENV === 'production') throw new Error(`Variable d'environnement manquante : ${name}`);
  return devDefault;
}
function strongSecret(name: string, devDefault: string): string {
  const v = req(name, devDefault);
  if (process.env.NODE_ENV === 'production' && v.length < 32) throw new Error(`${name} doit contenir au moins 32 caractères`);
  return v;
}

export interface Env {
  nodeEnv: string; isProd: boolean; port: number; host: string;
  databaseUrl: string; dbPoolMax: number; dbMaxWaiting: number;
  redisUrl: string; jwtSecret: string; encryptionKey: Buffer;
  publicUrl: string; apiPublicUrl: string; corsOrigins: string[];
  uploadDir: string; setupToken: string; cookieSecure: boolean; trustProxy: boolean;
  rateLimitFactor: number; logLevel: string; role: 'api' | 'worker' | 'all';
  webhookSecret: string; version: string;
}

let cached: Env | null = null;
export function env(): Env {
  if (cached) return cached;
  const nodeEnv = process.env.NODE_ENV || 'development';
  const publicUrl = (process.env.PUBLIC_URL || 'http://localhost:4200').replace(/\/$/, '');
  cached = {
    nodeEnv, isProd: nodeEnv === 'production',
    port: Number(process.env.PORT || 3000), host: process.env.HOST || '0.0.0.0',
    databaseUrl: req('DATABASE_URL', 'postgres://postgres@127.0.0.1:5432/bb_dev'),
    dbPoolMax: Number(process.env.DB_POOL_MAX || 20),
    dbMaxWaiting: Number(process.env.DB_MAX_WAITING || 500),
    redisUrl: req('REDIS_URL', 'redis://127.0.0.1:6379'),
    jwtSecret: strongSecret('JWT_SECRET', 'dev-only-jwt-secret-change-me-0123456789'),
    // La clé maîtresse est dérivée par SHA-256 : n'importe quelle chaîne longue convient.
    encryptionKey: createHash('sha256').update(strongSecret('APP_ENCRYPTION_KEY', 'dev-only-encryption-key-change-me-012345')).digest(),
    publicUrl,
    apiPublicUrl: (process.env.API_PUBLIC_URL || publicUrl).replace(/\/$/, ''),
    corsOrigins: (process.env.CORS_ORIGINS || publicUrl).split(',').map(s => s.trim()).filter(Boolean),
    uploadDir: process.env.UPLOAD_DIR || './uploads',
    setupToken: process.env.SETUP_TOKEN || '',
    cookieSecure: (process.env.COOKIE_SECURE ?? (nodeEnv === 'production' ? 'true' : 'false')) === 'true',
    trustProxy: (process.env.TRUST_PROXY ?? 'true') === 'true',
    rateLimitFactor: Number(process.env.RATE_LIMIT_FACTOR || 1),
    logLevel: process.env.LOG_LEVEL || (nodeEnv === 'test' ? 'silent' : 'info'),
    role: (process.env.APP_ROLE as any) || 'all',
    webhookSecret: strongSecret('WEBHOOK_SECRET', 'dev-only-webhook-secret-change-me-012345'),
    version: process.env.APP_VERSION || '1.0.0',
  };
  return cached;
}
export function resetEnvCache() { cached = null; }
