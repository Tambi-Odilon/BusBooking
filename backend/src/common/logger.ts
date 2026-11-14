import pino from 'pino';
import { env } from './env';
export const logger = pino({
  level: env().logLevel,
  redact: { paths: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.token', '*.secret'], remove: true },
  base: { service: 'bus-booking-api', role: env().role },
});
