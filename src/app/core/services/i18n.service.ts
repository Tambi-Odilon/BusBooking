import { Injectable, signal, computed } from '@angular/core';
import { Lang, TRANSLATIONS, Translations } from '../i18n/index';

const STORAGE_KEY = 'soatrans_lang';

@Injectable({ providedIn: 'root' })
export class I18nService {
  private readonly _lang = signal<Lang>(this.loadSaved());

  readonly lang    = this._lang.asReadonly();
  readonly t       = computed<Translations>(() => TRANSLATIONS[this._lang()]);

  setLang(lang: Lang): void {
    this._lang.set(lang);
    try { localStorage.setItem(STORAGE_KEY, lang); } catch { /* SSR safety */ }
  }

  private loadSaved(): Lang {
    try {
      const saved = localStorage.getItem(STORAGE_KEY) as Lang | null;
      if (saved && ['fr', 'en', 'mg', 'zh'].includes(saved)) return saved;
    } catch { /* SSR safety */ }
    return 'fr';
  }
}
