import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, errorMessage } from '../../../core/api/api.service';
import { AppConfigService, applyPalette } from '../../../core/config/app-config.service';
import { BUILTIN_LANGS, LANG_META, TRANSLATIONS } from '../../../core/i18n/index';
import { SettingsFormComponent } from '../../../shared/settings/settings-form.component';
import { GROUP_META, SettingGroup } from '../../../shared/settings/settings-schema';
import { AdminAuthService } from '../../services/admin-auth.service';
import { AdminRolesService } from '../../services/admin-roles.service';
import { AdminToastService } from '../../services/admin-toast.service';
import { TEMPLATE_LABELS } from '../../services/admin-email.service';

type Tab = SettingGroup | 'payments' | 'templates' | 'texts';
interface PayMethod { code: string; name: string; kind: string; online: boolean; enabled: boolean; mode: 'test' | 'live'; sortOrder: number; publicConfig: Record<string, string>; secretFields: string[] }
interface TemplateInfo { code: string; variables: string[]; defaults: Record<string, { subject: string; body: string; sms?: string }>; custom: { code: string; lang: string; subject: string; bodyHtml: string; bodyText: string }[] }
const SECRET_LABELS: Record<string, string> = { consumerKey: 'Consumer Key', consumerSecret: 'Consumer Secret', clientId: 'Client ID', clientSecret: 'Client Secret', merchantKey: 'Merchant Key' };
const PUBLIC_LABELS: Record<string, string> = { merchantNumber: 'Numéro marchand', partnerName: 'Nom du partenaire', prefixes: 'Préfixes acceptés', currency: 'Devise opérateur', country: 'Pays opérateur' };
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

/**
 * Société et réglages : tout ce que l'assistant de première configuration a demandé reste modifiable ici,
 * avec les mêmes formulaires. Les secrets (clés API, mot de passe SMTP) ne sont jamais relus : on ne peut que les remplacer.
 */
@Component({
  selector: 'app-company-settings',
  standalone: true,
  imports: [FormsModule, SettingsFormComponent],
  templateUrl: './company-settings.component.html',
})
export class CompanySettingsComponent implements OnInit, OnDestroy {
  private api = inject(ApiService);
  readonly cfg = inject(AppConfigService);
  readonly auth = inject(AdminAuthService);
  private rolesSvc = inject(AdminRolesService);
  private toast = inject(AdminToastService);

  readonly tabs: { id: Tab; label: string }[] = [
    { id: 'identity', label: 'Identité' }, { id: 'contact', label: 'Contact' }, { id: 'legal', label: 'Légal et fiscal' }, { id: 'locale', label: 'Régionalisation' },
    { id: 'payments', label: 'Paiements' }, { id: 'notifications', label: 'Notifications' }, { id: 'templates', label: 'Modèles d\'e-mails' },
    { id: 'booking', label: 'Réservation' }, { id: 'ticket', label: 'Billet' }, { id: 'texts', label: 'Textes et langues' }, { id: 'security', label: 'Sécurité' },
  ];
  readonly meta = GROUP_META;
  readonly secretLabels = SECRET_LABELS;
  readonly publicLabels = PUBLIC_LABELS;
  readonly templateLabels = TEMPLATE_LABELS;
  readonly tab = signal<Tab>('identity');
  readonly loading = signal(true);
  readonly loadError = signal('');
  readonly saving = signal(false);
  readonly rev = signal(0);
  readonly canEdit = computed(() => this.auth.can('canManageSettings'));
  readonly roleChoices = computed(() => this.rolesSvc.roles().map(r => ({ id: r.id, name: r.name })));

  private original: Record<string, any> = {};
  model: Record<string, any> = {};
  hints = signal<Record<string, string>>({});
  methods = signal<PayMethod[]>([]);
  secretInput: Record<string, string> = {};
  testTo = '';
  readonly testState = signal<{ status: 'idle' | 'sending' | 'ok' | 'error'; message: string }>({ status: 'idle', message: '' });

  readonly group = computed<SettingGroup | null>(() => (this.tab() in GROUP_META ? this.tab() as SettingGroup : null));
  readonly dirty = computed(() => { this.rev(); const g = this.group(); return !!g && JSON.stringify(this.model[g]) !== JSON.stringify(this.original[g]); });

  ngOnInit(): void { void this.load(); }
  ngOnDestroy(): void { this.cfg.applyBrand(); }

  async load(): Promise<void> {
    this.loading.set(true); this.loadError.set('');
    try {
      const r = await this.api.get<any>('/admin/settings');
      this.original = r.settings; this.model = clone(r.settings);
      this.hints.set(r.secrets || {}); this.methods.set(r.paymentMethods || []);
      this.rev.update(n => n + 1);
    } catch (e) { this.loadError.set(errorMessage(e, 'Chargement impossible.')); }
    finally { this.loading.set(false); }
  }
  select(t: Tab): void {
    if (this.dirty() && !confirm('Des modifications ne sont pas enregistrées dans cet onglet. Les abandonner ?')) return;
    const g = this.group(); if (g) { this.model[g] = clone(this.original[g]); this.cfg.applyBrand(); }
    this.tab.set(t); this.rev.update(n => n + 1);
    if (t === 'templates' && !this.templates().length) void this.loadTemplates();
    if (t === 'texts') void this.loadTexts();
  }
  onChange(): void {
    this.rev.update(n => n + 1);
    if (this.tab() === 'identity') applyPalette(document.documentElement, this.model['identity'].primaryColor, this.model['identity'].accentColor);   // aperçu immédiat
  }
  cancel(): void { const g = this.group(); if (g) { this.model[g] = clone(this.original[g]); this.cfg.applyBrand(); this.rev.update(n => n + 1); } }
  async save(): Promise<void> {
    const g = this.group(); if (!g || !this.canEdit()) return;
    this.saving.set(true);
    try {
      const value = await this.api.put<any>(`/admin/settings/${g}`, this.model[g]);
      this.original[g] = value; this.model[g] = clone(value);
      await this.cfg.load();   // le site et le back-office reprennent tout de suite le nouveau nom, les couleurs, la devise…
      this.toast.success('Réglages enregistrés');
      this.rev.update(n => n + 1);
    } catch (e) { this.toast.error(errorMessage(e)); }
    finally { this.saving.set(false); }
  }
  uploader = async (file: File, kind: string): Promise<string> => {
    const form = new FormData(); form.append('file', file);
    try { return (await this.api.request<{ url: string }>('POST', '/admin/files', { form, query: { kind } })).url; }
    catch (e) { throw new Error(errorMessage(e)); }
  };

  // ── Secrets ──────────────────────────────────────────────────────────────
  hint(key: string): string { return this.hints()[key] || ''; }
  async saveSecret(key: string): Promise<void> {
    const value = (this.secretInput[key] || '').trim();
    if (!value) return;
    try { const r = await this.api.put<any>('/admin/secrets', { key, value }); this.hints.set(r.hints || {}); this.secretInput[key] = ''; this.toast.success('Clé enregistrée (chiffrée)'); }
    catch (e) { this.toast.error(errorMessage(e)); }
  }
  async clearSecret(key: string): Promise<void> {
    if (!confirm('Effacer cette clé ? Le service concerné cessera de fonctionner tant qu\'une nouvelle clé n\'est pas saisie.')) return;
    try { const r = await this.api.put<any>('/admin/secrets', { key, value: '' }); this.hints.set(r.hints || {}); this.toast.warn('Clé effacée'); }
    catch (e) { this.toast.error(errorMessage(e)); }
  }

  // ── Moyens de paiement ───────────────────────────────────────────────────
  publicKeys(m: PayMethod): string[] { return Object.keys(m.publicConfig || {}); }
  configured(m: PayMethod): boolean { return m.secretFields.every(f => !!this.hint(`${m.code}.${f}`)); }
  async saveMethod(m: PayMethod): Promise<void> {
    try {
      const r = await this.api.put<PayMethod>(`/admin/payment-methods/${m.code}`, { enabled: m.enabled, mode: m.mode, publicConfig: m.publicConfig });
      this.methods.update(l => l.map(x => x.code === m.code ? { ...x, ...r, secretFields: x.secretFields } : x));
      await this.cfg.load();
      this.toast.success(`${m.name} : enregistré`);
    } catch (e) { this.toast.error(errorMessage(e)); void this.load(); }
  }

  // ── E-mail de test ───────────────────────────────────────────────────────
  async testEmail(): Promise<void> {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(this.testTo.trim())) { this.testState.set({ status: 'error', message: 'Indiquez l\'adresse qui doit recevoir l\'e-mail de test.' }); return; }
    const n = this.model['notifications'].email;
    this.testState.set({ status: 'sending', message: '' });
    try {
      // on teste ce qui est affiché à l'écran, même si ce n'est pas encore enregistré ; le mot de passe déjà enregistré est repris par le serveur
      const smtp: any = { host: n.host, port: Number(n.port) || 587, secure: !!n.secure, user: n.user, fromName: n.fromName, fromEmail: n.fromEmail };
      if ((this.secretInput['smtp.password'] || '').trim()) smtp.password = this.secretInput['smtp.password'].trim();
      await this.api.post('/admin/settings/test-email', { to: this.testTo.trim(), smtp });
      this.testState.set({ status: 'ok', message: `E-mail de test envoyé à ${this.testTo.trim()}.` });
    } catch (e) { this.testState.set({ status: 'error', message: errorMessage(e, 'Envoi impossible.') }); }
  }

  // ── Modèles d'e-mails ────────────────────────────────────────────────────
  readonly templates = signal<TemplateInfo[]>([]);
  readonly tplCode = signal('booking_confirmed');
  readonly tplLang = signal('fr');
  readonly tplPreview = signal<{ subject: string; html: string } | null>(null);
  tpl = { subject: '', bodyHtml: '', bodyText: '' };
  readonly tplCustom = signal(false);
  readonly langs = computed(() => this.cfg.locale().enabledLangs);
  langLabel(code: string): string { return LANG_META.find(l => l.code === code)?.label ?? this.cfg.locale().customLangs.find(c => c.code === code)?.name ?? code; }
  current(): TemplateInfo | undefined { return this.templates().find(t => t.code === this.tplCode()); }
  async loadTemplates(): Promise<void> {
    try { this.templates.set(await this.api.get<TemplateInfo[]>('/admin/email-templates')); this.pickTemplate(); }
    catch (e) { this.toast.error(errorMessage(e)); }
  }
  pickTemplate(): void {
    const t = this.current(); if (!t) return;
    const lang = this.tplLang();
    const custom = t.custom.find(c => c.lang === lang);
    const def = t.defaults[lang] ?? t.defaults['fr'] ?? Object.values(t.defaults)[0];
    this.tpl = custom ? { subject: custom.subject, bodyHtml: custom.bodyHtml, bodyText: custom.bodyText || '' } : { subject: def?.subject || '', bodyHtml: def?.body || '', bodyText: def?.sms || '' };
    this.tplCustom.set(!!custom); this.tplPreview.set(null);
  }
  insertVar(v: string): void { this.tpl.bodyHtml += `{{${v}}}`; }
  async saveTemplate(): Promise<void> {
    if (!this.tpl.subject.trim() || !this.tpl.bodyHtml.trim()) { this.toast.error('L\'objet et le contenu sont obligatoires'); return; }
    try {
      const r = await this.api.put<any>(`/admin/email-templates/${this.tplCode()}/${this.tplLang()}`, { subject: this.tpl.subject.trim(), bodyHtml: this.tpl.bodyHtml, bodyText: this.tpl.bodyText });
      this.tplPreview.set(r.preview ? { subject: r.preview.subject, html: r.preview.html } : null);
      this.toast.success('Modèle enregistré');
      this.templates.set(await this.api.get<TemplateInfo[]>('/admin/email-templates')); this.tplCustom.set(true);
    } catch (e) { this.toast.error(errorMessage(e)); }
  }
  async resetTemplate(): Promise<void> {
    if (!confirm('Revenir au modèle fourni par défaut pour cette langue ?')) return;
    try { await this.api.post(`/admin/email-templates/${this.tplCode()}/${this.tplLang()}/reset`); await this.loadTemplates(); this.toast.success('Modèle par défaut rétabli'); }
    catch (e) { this.toast.error(errorMessage(e)); }
  }

  // ── Textes et langues ────────────────────────────────────────────────────
  readonly textLang = signal('fr');
  readonly textSearch = signal('');
  readonly overrides = signal<Record<string, string>>({});
  edits: Record<string, string> = {};
  readonly textsRev = signal(0);
  /** Tous les textes du site client, à plat : « section.cle » → texte de la langue de base. */
  readonly baseTexts = computed<{ key: string; base: string }[]>(() => {
    const code = this.textLang();
    const baseCode = BUILTIN_LANGS.includes(code) ? code : (this.cfg.locale().customLangs.find(c => c.code === code)?.baseLang || 'fr');
    const src: any = TRANSLATIONS[baseCode] ?? TRANSLATIONS['fr'];
    const out: { key: string; base: string }[] = [];
    for (const [section, entries] of Object.entries(src)) if (entries && typeof entries === 'object')
      for (const [k, v] of Object.entries(entries as any)) if (typeof v === 'string') out.push({ key: `${section}.${k}`, base: v });
    return out;
  });
  readonly shownTexts = computed(() => {
    this.textsRev();
    const q = this.textSearch().trim().toLowerCase(), o = this.overrides();
    const all = this.baseTexts().filter(t => !q || t.key.toLowerCase().includes(q) || t.base.toLowerCase().includes(q) || (o[t.key] || '').toLowerCase().includes(q));
    return { rows: all.slice(0, 80), total: all.length };
  });
  readonly editCount = computed(() => { this.textsRev(); return Object.keys(this.edits).length; });
  isCustomLang(): boolean { return !BUILTIN_LANGS.includes(this.textLang()); }
  translatedCount(): number { return Object.keys(this.overrides()).length; }
  async loadTexts(): Promise<void> {
    this.edits = {}; this.textsRev.update(n => n + 1);
    try { this.overrides.set(await this.api.get<Record<string, string>>(`/public/i18n/${this.textLang()}`, { scope: 'none' }) || {}); } catch { this.overrides.set({}); }
  }
  textValue(key: string): string { return key in this.edits ? this.edits[key] : (this.overrides()[key] ?? ''); }
  setText(key: string, v: string): void { if (v === (this.overrides()[key] ?? '')) delete this.edits[key]; else this.edits[key] = v; this.textsRev.update(n => n + 1); }
  async saveTexts(): Promise<void> {
    if (!Object.keys(this.edits).length) return;
    try { await this.api.put(`/admin/i18n/${this.textLang()}`, { entries: this.edits }); this.toast.success('Textes enregistrés. Ils apparaissent au prochain chargement du site.'); await this.loadTexts(); }
    catch (e) { this.toast.error(errorMessage(e)); }
  }
}
