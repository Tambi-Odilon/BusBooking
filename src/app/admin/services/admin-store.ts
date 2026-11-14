import { effect, inject, signal, untracked } from '@angular/core';
import { ApiService, errorMessage } from '../../core/api/api.service';
import { AdminSession } from './admin-session.service';
import { AdminToastService } from './admin-toast.service';
import { AdminPermissions } from '../models/admin.models';

/**
 * Base des services du back-office : l'état affiché est une copie de ce que renvoie l'API.
 * - Lecture : chargée à la connexion (si le rôle en a le droit), rechargée après chaque écriture.
 * - Écriture : l'écran est mis à jour tout de suite, la requête part dans une file (ordre conservé) ; si le serveur
 *   refuse, un message s'affiche et l'état réel est rechargé. Le serveur reste la seule source de vérité.
 */
export abstract class RemoteStore {
  protected api = inject(ApiService);
  protected toast = inject(AdminToastService);
  protected session = inject(AdminSession);

  readonly loading = signal(false);
  readonly loaded = signal(false);
  readonly loadError = signal<string | null>(null);

  private chain: Promise<unknown> = Promise.resolve();
  private realIds = new Map<string, Promise<string | undefined>>();
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;
  private seq = 0;

  /** Permissions dont l'une suffit pour lire ces données. */
  protected abstract readonly needs: (keyof AdminPermissions)[];
  protected abstract fetch(): Promise<void>;
  protected abstract reset(): void;

  constructor() {
    effect(() => {
      const u = this.session.user();
      untracked(() => { if (u && this.allowed()) void this.load(); else { this.reset(); this.loaded.set(false); } });
    });
  }
  protected allowed(): boolean { return this.needs.length === 0 || this.needs.some(p => this.session.can(p)); }

  async load(): Promise<void> {
    if (!this.session.user() || !this.allowed()) return;
    const mine = ++this.seq;
    this.loading.set(true);
    try { await this.fetch(); if (mine === this.seq) { this.loaded.set(true); this.loadError.set(null); } }
    catch (e) { if (mine === this.seq) this.loadError.set(errorMessage(e, 'Chargement impossible')); }
    finally { if (mine === this.seq) this.loading.set(false); }
  }
  protected scheduleReload(delay = 150): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => { this.reloadTimer = null; void this.load(); }, delay);
  }
  /** Met une écriture en file. Renvoie le résultat, ou `undefined` si le serveur l'a refusée (message déjà affiché). */
  protected write<T>(fn: () => Promise<T>, also: Array<{ load(): Promise<void> }> = []): Promise<T | undefined> {
    const p = this.chain.then(fn);
    this.chain = p.then(() => undefined, () => undefined);
    return p.then(
      r => { this.scheduleReload(); also.forEach(s => void s.load()); return r; },
      e => { this.toast.error(errorMessage(e)); this.scheduleReload(0); return undefined; });
  }
  /** Identifiant provisoire d'un élément créé à l'écran avant la réponse du serveur. */
  protected tempId(created: Promise<{ id: string } | undefined>): string {
    const id = 'tmp-' + Math.random().toString(36).slice(2, 10);
    this.realIds.set(id, created.then(r => r?.id));
    return id;
  }
  /** Identifiant serveur (attend la création en cours si l'identifiant est provisoire). */
  protected async real(id: string): Promise<string> {
    const pending = this.realIds.get(id);
    if (!pending) return id;
    const real = await pending;
    if (!real) throw new Error('Élément non enregistré');
    return real;
  }
}
/** Retire les clés à `undefined` et convertit '' en null pour les champs facultatifs. */
export function clean<T extends Record<string, any>>(o: T, nullable: string[] = []): Partial<T> {
  const out: any = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined) continue;
    out[k] = nullable.includes(k) && (v === '' || v === '—') ? null : v;
  }
  return out;
}
