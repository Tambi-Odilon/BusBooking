import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { ApiError, ApiService, errorMessage } from '../../core/api/api.service';
import { AppConfigService, applyPalette } from '../../core/config/app-config.service';
import { store } from '../../core/storage';
import { SettingsFormComponent } from '../../shared/settings/settings-form.component';
import { GROUP_META, SettingGroup } from '../../shared/settings/settings-schema';

interface PaymentDraft { code: string; name: string; kind: string; enabled: boolean; mode: 'test' | 'live'; publicConfig: Record<string, string>; secretFields: string[] }
interface Draft {
  identity: any; contact: any; legal: any; locale: any; booking: any; ticket: any; notifications: any; security: any;
  payments: PaymentDraft[]; admin: { firstName: string; lastName: string; email: string }; twoFactor: boolean; seed: 'empty' | 'demo'; step: number; skipped: string[];
}
type StepId = SettingGroup | 'payments' | 'admin' | 'seed' | 'review';
interface Step { id: StepId; title: string; intro: string; required?: boolean }

const STEPS: Step[] = [
  { id: 'identity', title: 'Identité', intro: GROUP_META.identity.intro, required: true },
  { id: 'contact', title: 'Contact', intro: GROUP_META.contact.intro },
  { id: 'legal', title: 'Légal et fiscal', intro: GROUP_META.legal.intro },
  { id: 'locale', title: 'Régionalisation', intro: GROUP_META.locale.intro },
  { id: 'payments', title: 'Paiements', intro: 'Choisissez les moyens de paiement proposés aux voyageurs. Les clés sont stockées chiffrées sur le serveur.' },
  { id: 'notifications', title: 'Notifications', intro: GROUP_META.notifications.intro },
  { id: 'booking', title: 'Réservation', intro: GROUP_META.booking.intro },
  { id: 'ticket', title: 'Billet', intro: GROUP_META.ticket.intro },
  { id: 'admin', title: 'Administrateur', intro: 'Le compte principal, qui a tous les droits. Vous créerez les autres comptes ensuite.', required: true },
  { id: 'seed', title: 'Données de départ', intro: 'Démarrez avec une application vide, ou avec un petit exemple pour faire vos essais.' },
  { id: 'review', title: 'Vérification', intro: 'Relisez l\'essentiel, puis terminez. Tout reste modifiable dans Société et réglages.' },
];
const SECRET_LABELS: Record<string, string> = { consumerKey: 'Consumer Key', consumerSecret: 'Consumer Secret', clientId: 'Client ID', clientSecret: 'Client Secret', merchantKey: 'Merchant Key' };
const PUBLIC_LABELS: Record<string, { label: string; placeholder: string; help?: string }> = {
  merchantNumber: { label: 'Numéro marchand', placeholder: 'Ex. 0343500003', help: 'Le numéro qui reçoit les paiements.' },
  partnerName: { label: 'Nom du partenaire', placeholder: 'Nom déclaré auprès de l\'opérateur' },
  prefixes: { label: 'Préfixes acceptés', placeholder: 'Ex. 034, 038', help: 'Affichés au voyageur pour l\'aider à choisir.' },
  currency: { label: 'Devise opérateur', placeholder: 'Ex. MGA' },
  country: { label: 'Pays opérateur', placeholder: 'Ex. MG' },
};
const deepMerge = (base: any, over: any): any => {
  if (Array.isArray(base) || Array.isArray(over) || typeof base !== 'object' || base === null) return over === undefined ? base : over;
  const out: any = { ...base };
  for (const [k, v] of Object.entries(over || {})) out[k] = k in base ? deepMerge(base[k], v) : v;
  return out;
};

/**
 * Assistant de première configuration. Accessible uniquement tant que l'application n'est pas initialisée :
 * une fois terminé, le serveur refuse définitivement ses appels et l'écran redirige vers la connexion.
 * Seuls le nom de la société et le compte administrateur sont obligatoires.
 */
@Component({
  selector: 'app-setup',
  standalone: true,
  imports: [FormsModule, SettingsFormComponent],
  templateUrl: './setup.component.html',
  styleUrl: './setup.component.scss',
})
export class SetupComponent implements OnInit, OnDestroy {
  private api = inject(ApiService);
  private cfg = inject(AppConfigService);
  private router = inject(Router);

  readonly steps = STEPS;
  readonly state = signal<'loading' | 'token' | 'form' | 'done' | 'error'>('loading');
  readonly loadError = signal('');
  readonly step = signal(0);
  readonly d = signal<Draft | null>(null);
  /** Incrémenté à chaque modification : déclenche l'aperçu et la sauvegarde du brouillon. */
  readonly rev = signal(0);
  readonly savedAt = signal<string | null>(null);
  readonly saveState = signal<'idle' | 'saving' | 'saved' | 'local'>('idle');
  readonly submitting = signal(false);
  readonly errors = signal<string[]>([]);
  readonly showPreview = signal(false);
  readonly showPwd = signal(false);
  readonly testState = signal<{ status: 'idle' | 'sending' | 'ok' | 'error'; message: string }>({ status: 'idle', message: '' });
  readonly secretLabels = SECRET_LABELS;
  readonly publicLabels = PUBLIC_LABELS;

  // Les secrets ne sont jamais enregistrés dans le brouillon : ils restent en mémoire jusqu'à la validation.
  token = '';
  tokenError = signal('');
  password = '';
  password2 = '';
  smtpPassword = '';
  smsApiKey = '';
  paymentSecrets: Record<string, Record<string, string>> = {};
  testTo = '';
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  readonly current = computed(() => this.steps[this.step()]);
  readonly progress = computed(() => Math.round((this.step() / (this.steps.length - 1)) * 100));
  readonly passwordChecks = computed(() => { this.rev(); const p = this.password; return [
    { ok: p.length >= 10, label: '10 caractères au moins' }, { ok: /[a-z]/.test(p), label: 'une minuscule' },
    { ok: /[A-Z]/.test(p), label: 'une majuscule' }, { ok: /\d/.test(p), label: 'un chiffre' } ]; });
  /** Ce qui manque pour pouvoir terminer (le strict minimum). */
  readonly missing = computed<{ step: number; label: string }[]>(() => {
    this.rev(); const d = this.d(); if (!d) return [];
    const out: { step: number; label: string }[] = [];
    const adminStep = this.steps.findIndex(s => s.id === 'admin');
    if (!d.identity.name?.trim()) out.push({ step: 0, label: 'Nom commercial de la société' });
    if (!d.admin.firstName.trim() || !d.admin.lastName.trim()) out.push({ step: adminStep, label: 'Prénom et nom de l\'administrateur' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(d.admin.email.trim())) out.push({ step: adminStep, label: 'E-mail de l\'administrateur' });
    if (this.passwordChecks().some(c => !c.ok)) out.push({ step: adminStep, label: 'Mot de passe fort' });
    else if (this.password !== this.password2) out.push({ step: adminStep, label: 'Confirmation du mot de passe' });
    return out;
  });
  readonly sample = computed(() => {
    this.rev(); const d = this.d(); if (!d) return null;
        const prefix = (d.identity.referencePrefix || (d.identity.name || 'Ma Compagnie').replace(/[^A-Za-z]/g, '').slice(0, 3)).toUpperCase();
    return { ref: (prefix ? prefix + '-' : '') + '7F3K2A', price: this.money(35000), date: this.sampleDate(d.locale.dateFormat), time: d.locale.timeFormat === 'h:mm a' ? '7:30 AM' : '07:30', fee: d.booking.serviceFee ? this.money(d.booking.serviceFee) : '',
      header: d.ticket.headerColor || d.identity.primaryColor, initials: (d.identity.name || 'M').split(/\s+/).filter(Boolean).slice(0, 2).map((w: string) => w[0]).join('').toUpperCase() };
  });

  ngOnInit(): void { this.token = store.get<string>('setup_token', '', true); void this.load(); }
  ngOnDestroy(): void { if (this.saveTimer) clearTimeout(this.saveTimer); this.cfg.applyBrand(); }

  private headers(): Record<string, string> { return this.token ? { 'x-setup-token': this.token } : {}; }

  async load(): Promise<void> {
    this.state.set('loading');
    try {
      const st = await this.api.get<any>('/setup/status', { scope: 'none', headers: this.headers() });
      if (st.completed) { await this.cfg.load(); void this.router.navigate(['/admin/login']); return; }
      if (st.tokenRequired && !this.token) { this.state.set('token'); return; }
      if (st.tokenRequired) {
        // le code est vérifié par un appel protégé : un mauvais code est refusé ici, pas à la dernière étape
        try { await this.api.put('/setup/draft', { draft: st.draft || {} }, { scope: 'none', headers: this.headers() }); }
        catch (e) { if ((e as ApiError).status === 401) { this.token = ''; store.remove('setup_token', true); this.tokenError.set('Code d\'installation incorrect.'); this.state.set('token'); return; } }
      }
      const local = store.get<Partial<Draft> | null>('setup_draft', null);
      const remote: Partial<Draft> = st.draft && Object.keys(st.draft).length ? st.draft : (local || {});
      const base: Draft = {
        ...st.defaults,
        payments: (st.paymentMethods as any[]).map(m => ({ code: m.code, name: m.name, kind: m.kind, enabled: m.enabled, mode: m.mode || 'test', publicConfig: { ...m.publicConfig }, secretFields: m.secretFields || [] })),
        admin: { firstName: '', lastName: '', email: '' }, twoFactor: true, seed: 'empty', step: 0, skipped: [],
      };
      const merged: Draft = deepMerge(base, remote);
      // les moyens de paiement suivent la liste du serveur (un brouillon ancien ne peut pas en inventer)
      merged.payments = base.payments.map(p => { const saved = (remote.payments || []).find(x => x.code === p.code); return saved ? { ...p, enabled: !!saved.enabled, mode: saved.mode === 'live' ? 'live' : 'test', publicConfig: { ...p.publicConfig, ...(saved.publicConfig || {}) } } : p; });
      this.d.set(merged);
      this.step.set(Math.min(Math.max(0, merged.step || 0), this.steps.length - 1));
      this.state.set('form');
      this.preview();
    } catch (e) {
      this.loadError.set(errorMessage(e, 'Le serveur ne répond pas. Vérifiez qu\'il est démarré, puis réessayez.'));
      this.state.set('error');
    }
  }
  submitToken(): void { this.token = this.token.trim(); if (!this.token) return; store.set('setup_token', this.token, true); this.tokenError.set(''); void this.load(); }

  // ── Navigation ───────────────────────────────────────────────────────────
  go(i: number): void {
    const d = this.d(); if (!d) return;
    this.step.set(Math.min(Math.max(0, i), this.steps.length - 1));
    d.step = this.step();
    this.errors.set([]);
    this.touch();
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  next(): void {
    const s = this.current();
    if (s.id === 'identity' && !this.d()!.identity.name?.trim()) { this.errors.set(['Indiquez le nom commercial de votre société pour continuer.']); return; }
    this.d()!.skipped = this.d()!.skipped.filter(x => x !== s.id);
    this.go(this.step() + 1);
  }
  later(): void { const d = this.d()!, id = this.current().id; if (!d.skipped.includes(id)) d.skipped.push(id); this.go(this.step() + 1); }
  stepState(i: number): 'done' | 'skipped' | 'current' | 'todo' {
    if (i === this.step()) return 'current';
    const d = this.d(); if (!d) return 'todo';
    if (d.skipped.includes(this.steps[i].id)) return 'skipped';
    // Une étape obligatoire incomplète n'est jamais affichée comme terminée.
    if (this.missing().some(m => m.step === i)) return 'todo';
    return i < this.step() ? 'done' : 'todo';
  }

  // ── Brouillon ────────────────────────────────────────────────────────────
  touch(): void {
    this.rev.update(n => n + 1);
    this.preview();
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.saveDraft(), 900);
  }
  private preview(): void { const d = this.d(); if (d && typeof document !== 'undefined') applyPalette(document.documentElement, d.identity.primaryColor, d.identity.accentColor); }
  private async saveDraft(): Promise<void> {
    const d = this.d(); if (!d || this.state() !== 'form') return;
    store.set('setup_draft', d);   // copie locale : le brouillon survit à une coupure de réseau (il ne contient aucun mot de passe)
    this.saveState.set('saving');
    try {
      await this.api.put('/setup/draft', { draft: d }, { scope: 'none', headers: this.headers(), retries: 1 });
      this.saveState.set('saved');
    } catch { this.saveState.set('local'); }
    this.savedAt.set(new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' }).format(new Date()));
  }

  // ── Aides ────────────────────────────────────────────────────────────────
  money(minor: number): string {
    const l = this.d()!.locale, n = Number(minor || 0) / Math.pow(10, l.currencyDecimals || 0);
    const [int, dec] = n.toFixed(l.currencyDecimals || 0).split('.');
    const txt = int.replace(/\B(?=(\d{3})+(?!\d))/g, l.thousandsSeparator === ' ' ? ' ' : l.thousandsSeparator) + (dec ? (l.thousandsSeparator === ',' ? '.' : ',') + dec : '');
    return l.currencyPosition === 'before' ? `${l.currencySymbol} ${txt}` : `${txt} ${l.currencySymbol}`;
  }
  private sampleDate(fmt: string): string { return fmt === 'MM/dd/yyyy' ? '03/14/2027' : fmt === 'yyyy-MM-dd' ? '2027-03-14' : fmt === 'd MMM yyyy' ? '14 mars 2027' : '14/03/2027'; }
  publicKeys(p: PaymentDraft): string[] { return Object.keys(p.publicConfig || {}); }
  secret(code: string, field: string): string { return this.paymentSecrets[code]?.[field] ?? ''; }
  setSecret(code: string, field: string, v: string): void { (this.paymentSecrets[code] ??= {})[field] = v; this.rev.update(n => n + 1); }
  hasAllSecrets(p: PaymentDraft): boolean { return p.secretFields.every(f => !!this.secret(p.code, f).trim()); }
  setMode(p: PaymentDraft, mode: 'test' | 'live'): void { p.mode = mode; this.touch(); }
  enabledPayments(): PaymentDraft[] { return (this.d()?.payments || []).filter(p => p.enabled); }
  uploader = async (file: File, kind: string): Promise<string> => {
    const form = new FormData(); form.append('file', file);
    return (await this.api.request<{ url: string }>('POST', '/setup/upload', { scope: 'none', headers: this.headers(), form, query: { kind } })).url;
  };

  async testEmail(): Promise<void> {
    const n = this.d()!.notifications.email;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(this.testTo.trim())) { this.testState.set({ status: 'error', message: 'Indiquez l\'adresse qui doit recevoir l\'e-mail de test.' }); return; }
    this.testState.set({ status: 'sending', message: '' });
    try {
      await this.api.post('/setup/test-email', { to: this.testTo.trim(), smtp: { host: n.host, port: Number(n.port) || 587, secure: !!n.secure, user: n.user, password: this.smtpPassword, fromName: n.fromName || this.d()!.identity.name, fromEmail: n.fromEmail } },
        { scope: 'none', headers: this.headers() });
      this.testState.set({ status: 'ok', message: `E-mail de test envoyé à ${this.testTo.trim()}. Vérifiez la boîte de réception (et les indésirables).` });
    } catch (e) { this.testState.set({ status: 'error', message: errorMessage(e, 'Envoi impossible.') }); }
  }

  // ── Validation finale ────────────────────────────────────────────────────
  async finish(): Promise<void> {
    const d = this.d()!;
    const missing = this.missing();
    if (missing.length) { this.errors.set(missing.map(m => m.label + ' : à compléter')); this.go(missing[0].step); this.errors.set(missing.map(m => m.label + ' : à compléter')); return; }
    const livePending = d.payments.filter(p => p.enabled && p.mode === 'live' && p.secretFields.length && !this.hasAllSecrets(p));
    if (livePending.length) { this.go(this.steps.findIndex(s => s.id === 'payments')); this.errors.set(livePending.map(p => `${p.name} : saisissez toutes les clés pour le mode production, ou restez en mode test.`)); return; }
    this.submitting.set(true); this.errors.set([]);
    const security = { ...d.security, require2faRoles: d.twoFactor ? Array.from(new Set([...(d.security.require2faRoles || []), 'admin'])) : (d.security.require2faRoles || []).filter((r: string) => r !== 'admin') };
    const body = {
      identity: d.identity, contact: d.contact, legal: d.legal, locale: d.locale, booking: d.booking, ticket: d.ticket, notifications: d.notifications, security,
      payments: d.payments.map(p => ({ code: p.code, enabled: p.enabled, mode: p.mode, publicConfig: p.publicConfig,
        secrets: Object.fromEntries(Object.entries(this.paymentSecrets[p.code] || {}).filter(([, v]) => v && v.trim()).map(([k, v]) => [k, v.trim()])) })),
      secrets: { ...(this.smtpPassword ? { smtpPassword: this.smtpPassword } : {}), ...(this.smsApiKey ? { smsApiKey: this.smsApiKey } : {}) },
      admin: { firstName: d.admin.firstName.trim(), lastName: d.admin.lastName.trim(), email: d.admin.email.trim(), password: this.password },
      seed: d.seed,
    };
    try {
      await this.api.post('/setup/complete', body, { scope: 'none', headers: this.headers() });
      store.remove('setup_draft'); store.remove('setup_token', true);
      this.password = this.password2 = this.smtpPassword = this.smsApiKey = ''; this.paymentSecrets = {};
      await this.cfg.load();
      this.state.set('done');
    } catch (e) {
      const err = e as ApiError;
      if (err.code === 'SETUP_ALREADY_COMPLETED') { await this.cfg.load(); void this.router.navigate(['/admin/login']); return; }
      const issues: { path: string; message: string }[] = Array.isArray(err.details?.issues) ? err.details.issues : [];
      if (issues.length) {
        // on ouvre l'étape qui contient la première erreur signalée par le serveur
        const first = issues[0].path.split('.')[0];
        const idx = this.steps.findIndex(s => s.id === first || (first === 'secrets' && s.id === 'notifications'));
        if (idx >= 0) this.go(idx);
        this.errors.set(issues.slice(0, 6).map(i => `${i.path} : ${i.message}`));
      } else this.errors.set([errorMessage(e, 'La configuration n\'a pas pu être enregistrée. Réessayez.')]);
    } finally { this.submitting.set(false); }
  }
  toLogin(): void { void this.router.navigate(['/admin/login']); }
}
