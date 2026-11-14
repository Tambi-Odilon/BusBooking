import { Injectable, computed, inject, signal } from '@angular/core';
import { ApiService } from '../api/api.service';
import { store } from '../storage';

export interface PaymentMethodInfo { code: string; name: string; kind: 'mobile_money' | 'cash' | string; online: boolean; mode: 'test' | 'live'; info: { merchantNumber: string; prefixes: string } }
export interface PublicConfig {
  setupCompleted: boolean;
  identity: { name: string; legalName: string; slogan: string; description: string; logoUrl: string; logoDarkUrl: string; faviconUrl: string; primaryColor: string; accentColor: string; referencePrefix: string };
  contact: { email: string; ticketsEmail: string; phones: string[]; whatsapp: string; address: string; city: string; country: string; openingHours: string; website: string; social: Record<string, string> };
  legal: { registrationNumbers: { label: string; value: string }[]; taxEnabled: boolean; taxName: string; taxRatePercent: number; taxIncluded: boolean; termsText: string; cancellationPolicyText: string; privacyText: string; ticketLegalNotice: string };
  locale: { country: string; currencyCode: string; currencySymbol: string; currencyPosition: 'before' | 'after'; currencyDecimals: number; thousandsSeparator: string; timezone: string; dateFormat: string; timeFormat: string; defaultLang: string; enabledLangs: string[]; customLangs: { code: string; name: string; baseLang: string }[]; phonePrefix: string };
  booking: { seatHoldMinutes: number; paymentTimeoutMinutes: number; maxPassengers: number; serviceFee: number; serviceFeeMode: 'per_booking' | 'per_seat'; salesCloseMinutes: number; salesHorizonDays: number; allowGuestCheckout: boolean;
    cancellation: { enabled: boolean; deadlineHours: number; refundPercent: number; refundServiceFee: boolean }; change: { enabled: boolean; deadlineHours: number }; child: { enabled: boolean; maxAge: number; discountPercent: number }; baggage: { includedKg: number; note: string } };
  ticket: { headerColor: string; showLogo: boolean; footerText: string; instructions: string[]; qrFormat: string; boardingMinutesBefore: number };
  payments: PaymentMethodInfo[];
  version: string; serverTime: string;
}

/** Valeurs neutres utilisées tant que le serveur n'a pas répondu : aucun nom de société n'est écrit en dur dans l'application. */
export const NEUTRAL_CONFIG: PublicConfig = {
  setupCompleted: true,
  identity: { name: 'Ma Compagnie', legalName: '', slogan: '', description: '', logoUrl: '', logoDarkUrl: '', faviconUrl: '', primaryColor: '#1d4ed8', accentColor: '#f59e0b', referencePrefix: 'MAC' },
  contact: { email: '', ticketsEmail: '', phones: [], whatsapp: '', address: '', city: '', country: '', openingHours: '', website: '', social: {} },
  legal: { registrationNumbers: [], taxEnabled: false, taxName: 'TVA', taxRatePercent: 0, taxIncluded: true, termsText: '', cancellationPolicyText: '', privacyText: '', ticketLegalNotice: '' },
  locale: { country: '', currencyCode: 'MGA', currencySymbol: 'Ar', currencyPosition: 'after', currencyDecimals: 0, thousandsSeparator: ' ', timezone: 'Indian/Antananarivo', dateFormat: 'dd/MM/yyyy', timeFormat: 'HH:mm', defaultLang: 'fr', enabledLangs: ['fr', 'en', 'mg', 'zh'], customLangs: [], phonePrefix: '' },
  booking: { seatHoldMinutes: 10, paymentTimeoutMinutes: 5, maxPassengers: 6, serviceFee: 0, serviceFeeMode: 'per_booking', salesCloseMinutes: 30, salesHorizonDays: 60, allowGuestCheckout: true,
    cancellation: { enabled: true, deadlineHours: 2, refundPercent: 100, refundServiceFee: false }, change: { enabled: true, deadlineHours: 2 }, child: { enabled: false, maxAge: 11, discountPercent: 50 }, baggage: { includedKg: 20, note: '' } },
  ticket: { headerColor: '', showLogo: true, footerText: '', instructions: [], qrFormat: 'signed', boardingMinutesBefore: 15 },
  payments: [], version: '', serverTime: '',
};

// ── Couleurs : une palette complète (50 → 900) est calculée à partir de la couleur principale ─────────────
type Rgb = [number, number, number];
export function hexToRgb(hex: string): Rgb {
  const h = /^#?([0-9a-f]{6})$/i.exec(hex || '')?.[1] || '1d4ed8';
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [0, 1, 2].map(i => Math.round(a[i] + (b[i] - a[i]) * t)) as Rgb;
/** Nuances Tailwind (50…900) dérivées d'une couleur ; la couleur choisie correspond à la nuance 600. */
export function palette(hex: string): Record<string, Rgb> {
  const base = hexToRgb(hex), white: Rgb = [255, 255, 255], black: Rgb = [0, 0, 0];
  return { 50: mix(base, white, 0.94), 100: mix(base, white, 0.87), 200: mix(base, white, 0.74), 300: mix(base, white, 0.56), 400: mix(base, white, 0.34), 500: mix(base, white, 0.14),
    600: base, 700: mix(base, black, 0.16), 800: mix(base, black, 0.32), 900: mix(base, black, 0.46) };
}
export function applyPalette(el: HTMLElement, primary: string, accent: string): void {
  for (const [k, v] of Object.entries(palette(primary))) el.style.setProperty(`--brand-${k}`, v.join(' '));
  for (const [k, v] of Object.entries(palette(accent))) el.style.setProperty(`--accent-${k}`, v.join(' '));
  el.style.setProperty('--brand', primary); el.style.setProperty('--accent', accent);
}

@Injectable({ providedIn: 'root' })
export class AppConfigService {
  private api = inject(ApiService);
  private readonly _config = signal<PublicConfig>(store.get<PublicConfig | null>('config', null) ?? NEUTRAL_CONFIG);
  readonly config = this._config.asReadonly();
  /** `ready` : le serveur a répondu. `degraded` : on affiche la dernière configuration connue (serveur injoignable). */
  readonly state = signal<'loading' | 'ready' | 'degraded' | 'unreachable'>('loading');

  readonly identity = computed(() => this._config().identity);
  readonly name = computed(() => this._config().identity.name);
  readonly locale = computed(() => this._config().locale);
  readonly booking = computed(() => this._config().booking);
  readonly contact = computed(() => this._config().contact);
  readonly onlinePayments = computed(() => this._config().payments.filter(p => p.online));
  readonly setupCompleted = computed(() => this._config().setupCompleted);
  readonly initials = computed(() => this.name().split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '•');
  readonly year = new Date().getFullYear();

  /** Chargée avant le premier affichage (voir app.config.ts). Ne rejette jamais : l'application s'affiche toujours. */
  async load(): Promise<void> {
    try {
      const c = await this.api.get<PublicConfig>('/public/config', { scope: 'none', retries: 2 });
      this._config.set(c);
      store.set('config', c);
      this.state.set('ready');
    } catch {
      this.state.set(store.get<PublicConfig | null>('config', null) ? 'degraded' : 'unreachable');
    }
    this.applyBrand();
  }
  /** Aperçu en direct (assistant de configuration, paramètres) sans enregistrer. */
  preview(patch: Partial<PublicConfig['identity']>): void { applyPalette(document.documentElement, patch.primaryColor || this.identity().primaryColor, patch.accentColor || this.identity().accentColor); }

  applyBrand(): void {
    if (typeof document === 'undefined') return;
    const id = this.identity();
    applyPalette(document.documentElement, id.primaryColor, id.accentColor);
    document.title = id.slogan ? `${id.name} — ${id.slogan}` : id.name;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', id.primaryColor);
    document.querySelector('meta[name="description"]')?.setAttribute('content', id.description || id.slogan || id.name);
    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.appendChild(link); }
    link.href = id.faviconUrl || this.letterIcon();
  }
  /** Favicon par défaut : l'initiale de la société sur la couleur principale (aucune image fournie n'est nécessaire). */
  private letterIcon(): string {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${this.identity().primaryColor}"/><text x="32" y="43" font-family="Arial,sans-serif" font-size="30" font-weight="700" text-anchor="middle" fill="#fff">${this.initials().slice(0, 2).replace(/[<&>]/g, '')}</text></svg>`;
    return 'data:image/svg+xml,' + encodeURIComponent(svg);
  }

  // ── Formats ──────────────────────────────────────────────────────────────────────────────────────────
  /** Montant en unités mineures (entier) → texte selon la devise configurée. Ex. 37000 → « 37 000 Ar ». */
  money(minor: number | null | undefined, withSymbol = true): string {
    const l = this.locale();
    const n = Number(minor || 0) / Math.pow(10, l.currencyDecimals);
    const [int, dec] = Math.abs(n).toFixed(l.currencyDecimals).split('.');
    const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, l.thousandsSeparator === ' ' ? ' ' : l.thousandsSeparator);
    const decSep = l.thousandsSeparator === ',' ? '.' : ',';
    const txt = (n < 0 ? '-' : '') + grouped + (dec ? decSep + dec : '');
    if (!withSymbol) return txt;
    return l.currencyPosition === 'before' ? `${l.currencySymbol} ${txt}` : `${txt} ${l.currencySymbol}`;
  }
  /** Date (ISO ou AAAA-MM-JJ) → texte au format configuré, dans le fuseau de la société. */
  date(value: string | Date | null | undefined, opts: { time?: boolean; long?: boolean; lang?: string } = {}): string {
    if (!value) return '';
    const l = this.locale();
    const dateOnly = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
    const d = dateOnly ? new Date(value + 'T12:00:00Z') : new Date(value);
    if (isNaN(d.getTime())) return String(value);
    const tz = dateOnly ? 'UTC' : l.timezone;
    if (opts.long) return new Intl.DateTimeFormat(opts.lang || l.defaultLang, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: tz }).format(d);
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d).map(x => [x.type, x.value]));
    const months = new Intl.DateTimeFormat(opts.lang || l.defaultLang, { month: 'short', timeZone: tz }).format(d);
    const day = l.dateFormat === 'MM/dd/yyyy' ? `${p['month']}/${p['day']}/${p['year']}` : l.dateFormat === 'yyyy-MM-dd' ? `${p['year']}-${p['month']}-${p['day']}`
      : l.dateFormat === 'd MMM yyyy' ? `${Number(p['day'])} ${months} ${p['year']}` : `${p['day']}/${p['month']}/${p['year']}`;
    return opts.time && !dateOnly ? `${day} ${this.time(`${p['hour']}:${p['minute']}`)}` : day;
  }
  /** Heure « HH:mm » → format configuré (24 h ou 12 h). */
  time(hhmm: string | null | undefined): string {
    if (!hhmm) return '';
    if (this.locale().timeFormat !== 'h:mm a') return hhmm;
    const [h, m] = hhmm.split(':').map(Number);
    return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
  }
  /** Date du jour (AAAA-MM-JJ) dans le fuseau de la société : c'est elle qui borne le calendrier de recherche. */
  today(offsetDays = 0): string {
    const d = new Date(Date.now() + offsetDays * 86400000);
    return new Intl.DateTimeFormat('en-CA', { timeZone: this.locale().timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  }
  /** Numéro de téléphone plausible (format international ou local). La validation stricte est faite par le serveur. */
  phoneValid(phone: string): boolean { return /^\+?\d{8,15}$/.test((phone || '').replace(/[\s\-().]/g, '')); }
  /** Estimation affichée avant la création de la réservation ; le montant facturé est toujours celui calculé par le serveur. */
  estimate(unitPrice: number, seats: number): { subtotal: number; fee: number; total: number } {
    const b = this.booking();
    const subtotal = unitPrice * seats;
    const fee = seats ? (b.serviceFeeMode === 'per_seat' ? b.serviceFee * seats : b.serviceFee) : 0;
    const l = this._config().legal;
    const tax = l.taxEnabled && !l.taxIncluded ? Math.round((subtotal + fee) * l.taxRatePercent / 100) : 0;
    return { subtotal, fee, total: subtotal + fee + tax };
  }
}
