import { Injectable, signal } from '@angular/core';

export type Scope = 'customer' | 'staff';
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: any) { super(message); }
  /** Erreur réseau ou serveur momentanément indisponible : l'action peut être retentée telle quelle. */
  get transient(): boolean { return this.status === 0 || this.status === 503 || this.status === 429 || this.status === 502 || this.status === 504; }
}
export interface RequestOptions {
  body?: unknown; query?: Record<string, string | number | boolean | null | undefined>;
  headers?: Record<string, string>;
  /** Jeton à utiliser. Par défaut : « staff » pour /admin et /tickets, « customer » sinon. `none` : requête anonyme. */
  scope?: Scope | 'none';
  /** Clé d'idempotence : la requête peut alors être rejouée sans risque de doublon. */
  idempotencyKey?: string;
  blob?: boolean; form?: FormData; retries?: number; keepalive?: boolean;
}
export interface Page<T> { items: T[]; total: number; page: number; limit: number }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
export const newKey = (): string => (crypto as any).randomUUID ? crypto.randomUUID() : 'k-' + Date.now() + '-' + Math.random().toString(36).slice(2);

/**
 * Point d'accès unique à l'API. Les jetons d'accès restent en mémoire (jamais dans le stockage du navigateur) ;
 * le jeton de renouvellement est un cookie httpOnly que le JavaScript ne peut pas lire.
 */
@Injectable({ providedIn: 'root' })
export class ApiService {
  readonly base = '/api/v1';
  private tokens: Record<Scope, string | null> = { customer: null, staff: null };
  private refreshing: Partial<Record<Scope, Promise<any>>> = {};
  private onSession: Partial<Record<Scope, (payload: any | null) => void>> = {};

  /** Faux quand le navigateur est hors ligne ou que le serveur ne répond plus. */
  readonly online = signal(typeof navigator === 'undefined' ? true : navigator.onLine);
  /** Nombre de requêtes en cours (indicateur de chargement global). */
  readonly pending = signal(0);

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => this.online.set(true));
      window.addEventListener('offline', () => this.online.set(false));
    }
  }
  token(scope: Scope): string | null { return this.tokens[scope]; }
  setToken(scope: Scope, t: string | null): void { this.tokens[scope] = t; }
  /** Les services d'authentification s'abonnent : appelés après un renouvellement (payload) ou une session perdue (null). */
  onSessionChange(scope: Scope, fn: (payload: any | null) => void): void { this.onSession[scope] = fn; }

  get<T>(path: string, o: RequestOptions = {}) { return this.request<T>('GET', path, o); }
  post<T>(path: string, body?: unknown, o: RequestOptions = {}) { return this.request<T>('POST', path, { ...o, body }); }
  put<T>(path: string, body?: unknown, o: RequestOptions = {}) { return this.request<T>('PUT', path, { ...o, body }); }
  patch<T>(path: string, body?: unknown, o: RequestOptions = {}) { return this.request<T>('PATCH', path, { ...o, body }); }
  delete<T>(path: string, o: RequestOptions = {}) { return this.request<T>('DELETE', path, o); }

  private scopeFor(path: string, o: RequestOptions): Scope | null {
    if (o.scope === 'none') return null;
    if (o.scope) return o.scope;
    return /^\/(admin|tickets)(\/|$|\?)/.test(path) ? 'staff' : 'customer';
  }
  url(path: string, query?: RequestOptions['query']): string {
    const q = Object.entries(query || {}).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');
    return this.base + path + (q ? (path.includes('?') ? '&' : '?') + q : '');
  }

  async request<T>(method: string, path: string, o: RequestOptions = {}): Promise<T> {
    const scope = this.scopeFor(path, o);
    // Une lecture, ou une écriture munie d'une clé d'idempotence, peut être rejouée sans risque.
    const replayable = method === 'GET' || !!o.idempotencyKey;
    const maxTries = o.retries ?? (replayable ? 4 : 1);
    this.pending.update(n => n + 1);
    try {
      for (let attempt = 1; ; attempt++) {
        try {
          return await this.once<T>(method, path, o, scope, true);
        } catch (e) {
          const err = e as ApiError;
          if (!(err instanceof ApiError) || !err.transient || attempt >= maxTries) throw err;
          const wait = Number(err.details?.retryAfter) > 0 ? Math.min(8000, Number(err.details.retryAfter) * 1000) : 400 * attempt * attempt;
          await sleep(wait + Math.random() * 250);
        }
      }
    } finally { this.pending.update(n => Math.max(0, n - 1)); }
  }

  private async once<T>(method: string, path: string, o: RequestOptions, scope: Scope | null, mayRefresh: boolean): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json', ...(o.headers || {}) };
    const token = scope ? this.tokens[scope] : null;
    if (token) headers['Authorization'] = 'Bearer ' + token;
    if (o.idempotencyKey) headers['Idempotency-Key'] = o.idempotencyKey;
    let body: BodyInit | undefined;
    if (o.form) body = o.form;
    else if (o.body !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(o.body); }
    let res: Response;
    try {
      res = await fetch(this.url(path, o.query), { method, headers, body, credentials: 'same-origin', keepalive: o.keepalive });
      this.online.set(true);
    } catch {
      this.online.set(false);
      throw new ApiError(0, 'NETWORK_ERROR', 'Connexion impossible. Vérifiez votre réseau.');
    }
    if (res.status === 401 && scope && mayRefresh && !path.startsWith('/auth/login') && !path.startsWith('/auth/refresh')) {
      // jeton d'accès expiré (ou permissions modifiées) : on le renouvelle une fois, puis on rejoue la requête
      if (await this.refresh(scope)) return this.once<T>(method, path, o, scope, false);
    }
    if (res.status === 204) return undefined as T;
    if (o.blob && res.ok) return await res.blob() as unknown as T;
    const text = await res.text();
    let data: any = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (res.ok) return data as T;
    const details = { ...(data?.details && typeof data.details === 'object' && !Array.isArray(data.details) ? data.details : { issues: data?.details }), retryAfter: res.headers.get('Retry-After') };
    throw new ApiError(res.status, data?.code || 'HTTP_' + res.status, data?.message || 'Une erreur est survenue', details);
  }

  /** Renouvelle le jeton d'accès à partir du cookie de session. Un seul appel à la fois par espace (client / personnel). */
  refresh(scope: Scope): Promise<boolean> {
    if (!this.refreshing[scope]) {
      this.refreshing[scope] = (async () => {
        try {
        for (let attempt = 1; ; attempt++) {
          try {
            const r = await this.once<any>('POST', '/auth/refresh', { body: { scope } }, null, false);
            this.tokens[scope] = r.accessToken;
            this.onSession[scope]?.(r);
            return true;
          } catch (e) {
            const err = e as ApiError;
            // un autre onglet vient de renouveler la session : le cookie contient déjà le nouveau jeton, on réessaie
            if (err.code === 'TOKEN_ROTATED' && attempt < 3) { await sleep(300 * attempt); continue; }
            if (err.status === 401 || err.status === 403) { this.tokens[scope] = null; this.onSession[scope]?.(null); }
            return false;
          }
        }
        } finally { setTimeout(() => { delete this.refreshing[scope]; }, 0); }
      })();
    }
    return this.refreshing[scope]!;
  }
}

/** Message lisible pour l'utilisateur à partir d'une erreur quelconque. */
export function errorMessage(e: unknown, fallback = 'Une erreur est survenue. Réessayez.'): string {
  if (e instanceof ApiError) {
    if (e.code === 'VALIDATION_ERROR' && Array.isArray(e.details?.issues) && e.details.issues.length)
      return e.details.issues.map((i: any) => (i.path ? i.path + ' : ' : '') + i.message).slice(0, 3).join(' · ');
    return e.message || fallback;
  }
  return fallback;
}
