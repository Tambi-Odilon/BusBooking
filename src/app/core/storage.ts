/**
 * Stockage local du navigateur : uniquement des préférences et des jetons de reprise (langue, thème, sélection en cours).
 * Aucune donnée métier n'y est conservée : la source de vérité est l'API. Préfixe neutre, sans nom de société.
 */
const PREFIX = 'bb_';
function area(session: boolean): Storage | null { try { return session ? window.sessionStorage : window.localStorage; } catch { return null; } }
export const store = {
  get<T>(key: string, fallback: T, session = false): T {
    try { const raw = area(session)?.getItem(PREFIX + key); return raw == null ? fallback : JSON.parse(raw) as T; } catch { return fallback; }
  },
  set(key: string, value: unknown, session = false): void {
    try { area(session)?.setItem(PREFIX + key, JSON.stringify(value)); } catch { /* stockage plein ou désactivé : sans gravité */ }
  },
  remove(key: string, session = false): void { try { area(session)?.removeItem(PREFIX + key); } catch { /* idem */ } },
};
/** Supprime les anciennes clés laissées par les versions de démonstration (données locales désormais inutiles). */
export function purgeLegacyStorage(): void {
  try {
    for (const s of [window.localStorage, window.sessionStorage])
      for (const k of Object.keys(s)) if (/^soatrans_/i.test(k)) s.removeItem(k);
  } catch { /* sans gravité */ }
}
