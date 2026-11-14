import { Injectable, computed, signal } from '@angular/core';
import { AdminAuditEntry, AdminPermissions, AuditCategory, AuditDiff } from '../models/admin.models';
import { RemoteStore } from './admin-store';
import { Page } from '../../core/api/api.service';

const toEntry = (e: any): AdminAuditEntry => ({
  id: String(e.id), adminId: e.actorId ?? '', adminPublicId: e.actorPublicId ?? undefined, adminName: e.actorName ?? undefined, category: e.category, action: e.action,
  details: e.details ?? undefined, diff: Array.isArray(e.diff) ? e.diff : undefined, targetId: e.targetId ?? undefined, targetName: e.targetName ?? undefined,
  severity: e.severity, ipHint: e.ip ?? undefined, createdAt: e.createdAt,
});
export interface AuditQuery { category?: string; severity?: string; search?: string; actorId?: string; page?: number; limit?: number }

/**
 * Journal d'audit. Il est écrit par le serveur à chaque action (jamais par le navigateur), en ajout seul :
 * aucune entrée ne peut être modifiée ni supprimée, et la chaîne de hachage permet de le vérifier.
 */
@Injectable({ providedIn: 'root' })
export class AdminAuditService extends RemoteStore {
  protected readonly needs: (keyof AdminPermissions)[] = [];
  private readonly _entries = signal<AdminAuditEntry[]>([]);
  private readonly byActor = signal<Record<string, AdminAuditEntry[]>>({});
  private requested = new Set<string>();
  /** Dernières actions : tout le journal si le rôle y a accès, sinon uniquement les miennes. */
  readonly entries = this._entries.asReadonly();
  readonly canViewAll = computed(() => this.session.can('canViewAudit'));

  protected async fetch(): Promise<void> {
    const me = this.session.user()?.id ?? '';
    const r = await this.api.get<Page<any>>(this.canViewAll() ? '/admin/audit' : '/admin/audit/mine', { query: { limit: 100 } });
    this._entries.set(r.items.map(e => toEntry(this.canViewAll() ? e : { ...e, actorId: me })));
    this.requested.clear(); this.byActor.set({});
  }
  protected reset(): void { this._entries.set([]); this.byActor.set({}); this.requested.clear(); }

  /** Recherche paginée dans tout le journal (permission « Consulter le journal d'audit »). */
  async search(q: AuditQuery): Promise<Page<AdminAuditEntry>> {
    const r = await this.api.get<Page<any>>('/admin/audit', { query: { ...q } });
    return { ...r, items: r.items.map(toEntry) };
  }
  verify(): Promise<{ entries: number; intact: boolean; firstBrokenId: number | null }> { return this.api.get('/admin/audit/verify'); }

  /** Les écritures sont faites par le serveur : cet appel, conservé pour les écrans existants, ne fait que rafraîchir l'affichage. */
  log(..._ignored: unknown[]): void { this.scheduleReload(1200); }

  getForAdmin(adminId: string): AdminAuditEntry[] {
    if (adminId === this.session.user()?.id && !this.canViewAll()) return this._entries();
    const cached = this.byActor()[adminId];
    if (cached) return cached;
    if (this.canViewAll() && !this.requested.has(adminId)) {
      this.requested.add(adminId);
      void this.search({ actorId: adminId, limit: 100 }).then(r => this.byActor.update(m => ({ ...m, [adminId]: r.items })), () => undefined);
    }
    return this._entries().filter(e => e.adminId === adminId);
  }
  getByCategory(adminId: string, cat: AuditCategory): AdminAuditEntry[] { return this.getForAdmin(adminId).filter(e => e.category === cat); }
  getAll(): AdminAuditEntry[] { return this._entries(); }
  countForAdmin(adminId: string): number { return this.getForAdmin(adminId).length; }

  // ── Helpers visuels ─────────────────────────────────────────────────────
  categoryIcon(cat: AuditCategory): string {
    const icons: Record<AuditCategory, string> = {
      auth:     '🔑', profile:  '👤', security: '🔒',
      users:    '👥', roles:    '🎭', trips:    '🚌',
      fleet:    '🚐', routes:   '🗺️', bookings: '🎫',
      ads:      '📢', settings: '⚙️', schedule: '📅',
    };
    return icons[cat] ?? '📋';
  }

  categoryLabel(cat: AuditCategory): string {
    const labels: Record<AuditCategory, string> = {
      auth:     'Authentification', profile:  'Profil',    security: 'Sécurité',
      users:    'Utilisateurs',     roles:    'Rôles',     trips:    'Voyages',
      fleet:    'Flotte',           routes:   'Itinéraires', bookings: 'Réservations',
      ads:      'Publicités',       settings: 'Paramètres', schedule: 'Emploi du temps',
    };
    return labels[cat] ?? cat;
  }

  severityColor(s: AdminAuditEntry['severity']): string {
    return { info:'var(--a-cyan)', success:'var(--a-green)', warning:'var(--a-amber)', danger:'var(--a-red)' }[s];
  }

  readonly categories: AuditCategory[] = [
    'auth','profile','security','users','roles','trips',
    'fleet','routes','bookings','ads','settings','schedule',
  ];

  // ── Utilitaires diff avant/après ─────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  diffObjects(before: any, after: any, labels: Record<string, string> = {}): AuditDiff[] {
    const diffs: AuditDiff[] = [];
    for (const key of Object.keys(after)) {
      const bVal = before?.[key];
      const aVal = after[key];
      if (JSON.stringify(bVal) === JSON.stringify(aVal)) continue;
      if (bVal === undefined && aVal === undefined) continue;
      diffs.push({
        field:  key,
        label:  labels[key] ?? key,
        before: this.serializeVal(bVal),
        after:  this.serializeVal(aVal),
      });
    }
    return diffs;
  }

  private serializeVal(v: unknown): string {
    if (v === undefined || v === null) return '—';
    if (typeof v === 'boolean') return v ? 'Oui' : 'Non';
    if (typeof v === 'number') return String(v);
    if (typeof v === 'string') return v || '—';
    if (Array.isArray(v)) {
      if (v.length === 0) return '(vide)';
      // Array of numbers → could be days of week
      if (v.every((x: unknown) => typeof x === 'number')) {
        const days = ['Dim','Lun','Mar','Mer','Jeu','Ven','Sam'];
        if (v.every((x: unknown) => (x as number) >= 0 && (x as number) <= 6)) {
          return v.map((d: unknown) => days[d as number]).join(', ');
        }
        return v.join(', ');
      }
      return v.join(', ');
    }
    if (typeof v === 'object') {
      // Flatten simple objects like priceByLayout
      const entries = Object.entries(v as Record<string, unknown>)
        .filter(([, val]) => val !== undefined && val !== null)
        .map(([k, val]) => k + ': ' + val);
      return entries.length ? entries.join(' | ') : '(objet vide)';
    }
    return String(v);
  }

}
