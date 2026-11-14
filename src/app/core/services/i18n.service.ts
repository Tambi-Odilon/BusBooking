import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { BUILTIN_LANGS, LANG_META, Lang, LangMeta, TRANSLATIONS, Translations } from '../i18n/index';
import { AppConfigService } from '../config/app-config.service';
import { ApiService } from '../api/api.service';
import { store } from '../storage';

/** Applique des textes personnalisés (« section.cle » → valeur) sur un jeu de traductions, sans toucher aux fonctions. */
function withOverrides(base: Translations, overrides: Record<string, string>): Translations {
  if (!Object.keys(overrides).length) return base;
  const out: any = { ...base };
  for (const [path, value] of Object.entries(overrides)) {
    const [section, key] = path.split('.');
    if (!section || !key || typeof (base as any)[section]?.[key] !== 'string') continue;
    out[section] = { ...out[section], [key]: value };
  }
  return out;
}

@Injectable({ providedIn: 'root' })
export class I18nService {
  private cfg = inject(AppConfigService);
  private api = inject(ApiService);
  private readonly _lang = signal<Lang>(store.get<string>('lang', ''));
  private readonly overrides = signal<Record<string, Record<string, string>>>({});

  /** Langues proposées : celles activées dans les paramètres de la société (les langues ajoutées s'appuient sur une langue de base). */
  readonly langs = computed<LangMeta[]>(() => {
    const l = this.cfg.locale();
    return l.enabledLangs.map(code => LANG_META.find(m => m.code === code)
      ?? { code, label: l.customLangs.find(c => c.code === code)?.name ?? code.toUpperCase(), flag: '🌐' });
  });
  readonly lang = computed<Lang>(() => {
    const l = this.cfg.locale(), wanted = this._lang();
    return l.enabledLangs.includes(wanted) ? wanted : l.defaultLang;
  });
  readonly t = computed<Translations>(() => {
    const code = this.lang();
    const baseCode = BUILTIN_LANGS.includes(code) ? code : (this.cfg.locale().customLangs.find(c => c.code === code)?.baseLang || 'fr');
    return withOverrides(TRANSLATIONS[baseCode] ?? TRANSLATIONS['fr'], this.overrides()[code] ?? {});
  });

  constructor() {
    effect(() => {
      const code = this.lang();
      if (typeof document !== 'undefined') document.documentElement.lang = code;
      if (this.overrides()[code] === undefined) this.loadOverrides(code);
    });
  }
  setLang(lang: Lang): void { this._lang.set(lang); store.set('lang', lang); }

  private async loadOverrides(code: Lang): Promise<void> {
    this.overrides.update(o => ({ ...o, [code]: {} }));
    try {
      const o = await this.api.get<Record<string, string>>(`/public/i18n/${code}`, { scope: 'none', retries: 1 });
      if (o && Object.keys(o).length) this.overrides.update(all => ({ ...all, [code]: o }));
    } catch { /* textes par défaut */ }
  }
}
