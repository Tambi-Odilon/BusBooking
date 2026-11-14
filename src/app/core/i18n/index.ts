import { FR } from './fr';
import { EN } from './en';
import { MG } from './mg';
import { ZH } from './zh';

/** Code de langue. Les quatre langues livrées sont complètes ; une société peut en ajouter d'autres dans ses paramètres. */
export type Lang = string;
export type Translations = typeof FR;

export const TRANSLATIONS: Record<string, Translations> = { fr: FR, en: EN, mg: MG, zh: ZH };
export const BUILTIN_LANGS = ['fr', 'en', 'mg', 'zh'];

export interface LangMeta { code: Lang; label: string; flag: string }
export const LANG_META: LangMeta[] = [
  { code: 'fr', label: 'Français',  flag: '🇫🇷' },
  { code: 'en', label: 'English',   flag: '🇬🇧' },
  { code: 'mg', label: 'Malagasy',  flag: '🇲🇬' },
  { code: 'zh', label: '中文',       flag: '🇨🇳' },
];
