import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import { ZodError } from 'zod';
import { logger } from './logger';

/** Erreur métier : `code` stable (traduit côté frontend), `status` HTTP. */
export class AppError extends Error {
  constructor(public code: string, public status = 400, message?: string, public details?: any, public headers?: Record<string, string>) {
    super(message || code);
  }
}
export const notFound = (what = 'RESOURCE') => new AppError(`${what}_NOT_FOUND`, 404, 'Introuvable');
export const forbidden = (code = 'FORBIDDEN') => new AppError(code, 403, 'Accès refusé');
export const conflict = (code: string, message?: string, details?: any) => new AppError(code, 409, message, details);

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(e: any, host: ArgumentsHost) {
    if (host.getType() !== 'http') return;
    const reply = host.switchToHttp().getResponse();
    const request = host.switchToHttp().getRequest();
    let status = 500, body: any = { code: 'INTERNAL_ERROR', message: 'Erreur interne' };
    if (e instanceof AppError) {
      status = e.status; body = { code: e.code, message: e.message, details: e.details };
      if (e.headers) for (const [k, v] of Object.entries(e.headers)) reply.header(k, v);
    } else if (e instanceof ZodError) {
      status = 400;
      body = { code: 'VALIDATION_ERROR', message: 'Données invalides', details: e.issues.map(i => ({ path: i.path.join('.'), message: i.message })) };
    } else if (e instanceof HttpException) {
      status = e.getStatus();
      const r: any = e.getResponse();
      body = { code: status === 404 ? 'NOT_FOUND' : status === 413 ? 'PAYLOAD_TOO_LARGE' : 'HTTP_ERROR', message: typeof r === 'string' ? r : r?.message || e.message };
    } else if (e?.code === 'FST_ERR_CTP_BODY_TOO_LARGE' || e?.statusCode === 413) {
      status = 413; body = { code: 'PAYLOAD_TOO_LARGE', message: 'Requête trop volumineuse' };
    } else if (e?.statusCode && e.statusCode < 500) {
      status = e.statusCode; body = { code: 'BAD_REQUEST', message: e.message };
    } else if (/timeout exceeded when trying to connect|too many clients|remaining connection slots/i.test(String(e?.message || '')) || e?.code === '53300') {
      // base saturée : on demande au client de réessayer plutôt que de renvoyer une erreur interne
      status = 503; body = { code: 'SERVER_BUSY', message: 'Serveur très sollicité, réessayez dans quelques secondes' }; reply.header('Retry-After', '3');
    } else if (e?.code === '23505') {
      status = 409; body = { code: 'DUPLICATE', message: 'Cette valeur existe déjà', details: { constraint: e.constraint } };
    } else if (e?.code === '23503') {
      status = 409; body = { code: 'STILL_REFERENCED', message: 'Élément encore utilisé ailleurs', details: { constraint: e.constraint } };
    } else if (e?.code === '23P01') {
      status = 409; body = { code: 'VEHICLE_SCHEDULE_CONFLICT', message: 'Ce véhicule a déjà un voyage sur ce créneau' };
    } else if (e?.code === '22P02' || e?.code === '22007' || e?.code === '22008') {
      status = 400; body = { code: 'VALIDATION_ERROR', message: 'Format de donnée invalide' };
    }
    if (status === 503) logger.warn({ url: request?.url, method: request?.method }, 'délestage (503)');
    else if (status >= 500) logger.error({ err: e, url: request?.url, method: request?.method }, 'erreur non gérée');
    reply.status(status).send(body);
  }
}
