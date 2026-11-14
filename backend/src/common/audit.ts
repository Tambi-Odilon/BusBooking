import { Injectable } from '@nestjs/common';
import { Db, Queryable } from './db';
import type { AuthUser } from './auth';

export interface AuditDiff { field: string; label: string; before: string; after: string }
export interface AuditEntry {
  actor?: AuthUser | null; category: string; action: string;
  severity?: 'info' | 'success' | 'warning' | 'danger';
  targetType?: string; targetId?: string; targetName?: string; details?: string; diff?: AuditDiff[]; ip?: string;
}
const fmt = (v: any) => v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);

@Injectable()
export class Audit {
  constructor(private db: Db) {}
  /** Écrit dans le journal en ajout seul. Passer la transaction en cours pour que l'entrée suive le sort de l'opération. */
  async log(e: AuditEntry, t?: Queryable) {
    await (t ?? this.db).q(
      `INSERT INTO audit_log (actor_id, actor_public_id, actor_name, category, action, severity, target_type, target_id, target_name, details, diff, ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [e.actor?.id ?? null, e.actor?.publicId ?? null, e.actor ? `${e.actor.firstName} ${e.actor.lastName}`.trim() : null,
       e.category, e.action, e.severity ?? 'info', e.targetType ?? null, e.targetId ?? null, e.targetName ?? null,
       e.details ?? null, e.diff?.length ? JSON.stringify(e.diff) : null, e.ip ?? null]);
  }
  /** Différences champ par champ entre l'état avant et le correctif appliqué. */
  diff(before: Record<string, any>, patch: Record<string, any>, labels: Record<string, string> = {}): AuditDiff[] {
    const out: AuditDiff[] = [];
    for (const k of Object.keys(patch)) {
      if (patch[k] === undefined) continue;
      const a = fmt(before?.[k]), b = fmt(patch[k]);
      if (a !== b) out.push({ field: k, label: labels[k] ?? k, before: a, after: b });
    }
    return out;
  }
}
