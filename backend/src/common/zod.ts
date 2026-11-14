import { Body, PipeTransform, Query, applyDecorators } from '@nestjs/common';
import { ApiBody, ApiOperation } from '@nestjs/swagger';
import { z, ZodType } from 'zod';

export class ZodPipe implements PipeTransform {
  constructor(private schema: ZodType) {}
  transform(value: any) { return this.schema.parse(value ?? {}); }
}
/** Corps de requête validé strictement (les champs inconnus sont refusés par les schémas `strictObject`). */
export const ZBody = (schema: ZodType) => Body(new ZodPipe(schema));
/**
 * Corps d'un PATCH : tous les champs sont facultatifs et SEULS les champs réellement envoyés sont conservés
 * (les valeurs par défaut du schéma ne doivent jamais écraser une donnée existante).
 */
export class ZodPatchPipe implements PipeTransform {
  constructor(private schema: any) {}
  transform(value: any) {
    const input = value ?? {};
    const parsed = this.schema.partial().parse(input);
    const out: any = {};
    for (const k of Object.keys(input)) if (k in parsed) out[k] = parsed[k];
    return out;
  }
}
export const ZPatch = (schema: ZodType) => Body(new ZodPatchPipe(schema));
export const ZQuery = (schema: ZodType) => Query(new ZodPipe(schema));

/** Documente la route dans OpenAPI à partir du schéma zod. */
export function Api(summary: string, body?: ZodType) {
  const decs: any[] = [ApiOperation({ summary })];
  if (body) {
    try { decs.push(ApiBody({ schema: z.toJSONSchema(body, { unrepresentable: 'any', io: 'input' }) as any })); }
    catch { /* schéma non représentable : la route reste documentée sans corps */ }
  }
  return applyDecorators(...decs);
}

// ── Briques de validation réutilisées ────────────────────────────────────────
export const zId = z.uuid();
export const zText = (max = 200) => z.string().trim().min(1).max(max);
export const zOptText = (max = 500) => z.string().trim().max(max).optional();
export const zEmail = z.string().trim().toLowerCase().max(254).regex(/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/, 'E-mail invalide');
export const zPhone = z.string().trim().min(6).max(20).regex(/^\+?[0-9 ().-]{6,20}$/, 'Téléphone invalide');
export const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date attendue au format AAAA-MM-JJ')
  .refine(s => { const d = new Date(s + 'T00:00:00Z'); return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s; }, 'Date inexistante');
export const zTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Heure attendue au format HH:mm');
export const zMoney = z.number().int().min(0).max(1_000_000_000_000);
export const zColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Couleur attendue au format #RRGGBB');
export const zPassword = z.string().min(10, 'Au moins 10 caractères').max(128)
  .refine(p => /[a-z]/.test(p) && /[A-Z]/.test(p) && /\d/.test(p), 'Le mot de passe doit contenir une minuscule, une majuscule et un chiffre');
export const zSeat = z.string().regex(/^[A-Z]{1,2}\d{1,2}$/, 'Numéro de siège invalide');
export const normalizePhone = (p: string) => p.replace(/[\s().-]/g, '');
