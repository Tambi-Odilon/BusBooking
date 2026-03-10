import { FR } from './fr';
import { EN } from './en';
import { MG } from './mg';
import { ZH } from './zh';

export type Lang = 'fr' | 'en' | 'mg' | 'zh';
export type Translations = typeof FR;

export const TRANSLATIONS: Record<Lang, Translations> = { fr: FR, en: EN, mg: MG, zh: ZH };

export const LANG_META: { code: Lang; label: string; flag: string }[] = [
  { code: 'fr', label: 'Français',  flag: '🇫🇷' },
  { code: 'en', label: 'English',   flag: '🇬🇧' },
  { code: 'mg', label: 'Malagasy',  flag: '🇲🇬' },
  { code: 'zh', label: '中文',       flag: '🇨🇳' },
];
