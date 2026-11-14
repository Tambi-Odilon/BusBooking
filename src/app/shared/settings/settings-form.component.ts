import { Component, EventEmitter, Input, Output, ViewEncapsulation, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { COUNTRY_PRESETS, FIELDS, Field, SettingGroup, getPath, setPath } from './settings-schema';
import { LANG_META } from '../../core/i18n/index';

let uid = 0;

/**
 * Formulaire d'un groupe de paramètres, généré à partir de la description des champs (settings-schema.ts).
 * Utilisé par l'assistant de première configuration et par l'écran « Société et réglages ».
 */
@Component({
  selector: 'app-settings-form',
  standalone: true,
  imports: [FormsModule],
  encapsulation: ViewEncapsulation.None,
  template: `
  <div class="sf">
    @if (group === 'locale') {
      <div class="sf-row sf-full">
        <label class="sf-label" [for]="id + '-preset'">Préréglage par pays</label>
        <select class="sf-input" [id]="id + '-preset'" (change)="applyPreset($any($event.target).value); $any($event.target).value = ''" [disabled]="readonly">
          <option value="">Choisir un pays pour remplir la devise, le fuseau et l'indicatif…</option>
          @for (p of presets; track p.country) { <option [value]="p.country">{{ p.country }} · {{ p.currencyCode }}</option> }
        </select>
        <p class="sf-help">Facultatif. Tous les champs restent modifiables ensuite.</p>
      </div>
    }
    @for (f of fields; track f.key || f.label; let i = $index) {
      @if (!f.showIf || f.showIf(model)) {
        @switch (f.type) {
          @case ('heading') {
            <div class="sf-row sf-full sf-heading">
              <h3>{{ f.label }}</h3>
              @if (f.help) { <p class="sf-help">{{ f.help }}</p> }
            </div>
          }
          @case ('toggle') {
            <div class="sf-row sf-full">
              <label class="sf-toggle">
                <input type="checkbox" [checked]="!!get(f)" (change)="set(f, $any($event.target).checked)" [disabled]="readonly" />
                <span class="sf-switch" aria-hidden="true"></span>
                <span>{{ f.label }}</span>
              </label>
              @if (f.help) { <p class="sf-help">{{ f.help }}</p> }
            </div>
          }
          @case ('textarea') {
            <div class="sf-row sf-full">
              <label class="sf-label" [for]="id + i">{{ f.label }}</label>
              <textarea class="sf-input" [id]="id + i" [rows]="f.rows || 3" [attr.maxlength]="f.maxLength || null" [placeholder]="f.placeholder || ''"
                        [ngModel]="get(f)" (ngModelChange)="set(f, $event)" [name]="id + i" [disabled]="readonly"></textarea>
              @if (f.help) { <p class="sf-help">{{ f.help }}</p> }
            </div>
          }
          @case ('select') {
            <div class="sf-row" [class.sf-full]="!f.half">
              <label class="sf-label" [for]="id + i">{{ f.label }}</label>
              <select class="sf-input" [id]="id + i" [ngModel]="get(f)" (ngModelChange)="set(f, $event)" [name]="id + i" [disabled]="readonly">
                @for (o of f.options; track o.value) { <option [ngValue]="o.value">{{ o.label }}</option> }
              </select>
              @if (f.help) { <p class="sf-help">{{ f.help }}</p> }
            </div>
          }
          @case ('color') {
            <div class="sf-row" [class.sf-full]="!f.half">
              <label class="sf-label" [for]="id + i">{{ f.label }}</label>
              <div class="sf-color">
                <input type="color" [id]="id + i + 'p'" [value]="get(f) || '#1d4ed8'" (input)="set(f, $any($event.target).value)" [disabled]="readonly" [attr.aria-label]="f.label + ' : sélecteur'" />
                <input class="sf-input" [id]="id + i" [ngModel]="get(f)" (ngModelChange)="setColor(f, $event)" [name]="id + i" placeholder="#1d4ed8" maxlength="7" [disabled]="readonly" />
                @if (f.optionalColor && get(f)) { <button type="button" class="sf-mini" (click)="set(f, '')" [disabled]="readonly">Par défaut</button> }
              </div>
              @if (f.help) { <p class="sf-help">{{ f.help }}</p> }
            </div>
          }
          @case ('number') {
            <div class="sf-row" [class.sf-full]="!f.half">
              <label class="sf-label" [for]="id + i">{{ f.label }}</label>
              <div class="sf-unit">
                <input class="sf-input" type="number" inputmode="decimal" [id]="id + i" [min]="f.min ?? null" [max]="f.max ?? null" [step]="f.step ?? 1" [placeholder]="f.placeholder || ''"
                       [ngModel]="get(f)" (ngModelChange)="setNumber(f, $event)" [name]="id + i" [disabled]="readonly" />
                @if (f.unit) { <span>{{ f.unit }}</span> }
              </div>
              @if (f.help) { <p class="sf-help">{{ f.help }}</p> }
            </div>
          }
          @case ('money') {
            <div class="sf-row" [class.sf-full]="!f.half">
              <label class="sf-label" [for]="id + i">{{ f.label }}</label>
              <div class="sf-unit">
                <input class="sf-input" type="number" inputmode="decimal" min="0" [step]="decimals ? 0.01 : 1" [id]="id + i" [placeholder]="f.placeholder || ''"
                       [ngModel]="toMajor(get(f))" (ngModelChange)="set(f, toMinor($event))" [name]="id + i" [disabled]="readonly" />
                <span>{{ currencySymbol }}</span>
              </div>
              @if (f.help) { <p class="sf-help">{{ f.help }}</p> }
            </div>
          }
          @case ('list') {
            <div class="sf-row sf-full">
              <span class="sf-label">{{ f.label }}</span>
              @for (item of list(f); track $index; let j = $index) {
                <div class="sf-inline">
                  <input class="sf-input" [attr.aria-label]="f.label + ' ' + (j + 1)" [placeholder]="f.placeholder || ''" [ngModel]="item" (ngModelChange)="setItem(f, j, $event)" [name]="id + i + '-' + j" [disabled]="readonly" />
                  <button type="button" class="sf-mini" (click)="removeItem(f, j)" [disabled]="readonly" [attr.aria-label]="'Retirer la ligne ' + (j + 1)">Retirer</button>
                </div>
              }
              @if (list(f).length < (f.max || 10)) { <button type="button" class="sf-mini sf-add" (click)="addItem(f, '')" [disabled]="readonly">+ Ajouter</button> }
              @if (f.help) { <p class="sf-help">{{ f.help }}</p> }
            </div>
          }
          @case ('pairs') {
            <div class="sf-row sf-full">
              <span class="sf-label">{{ f.label }}</span>
              @for (item of list(f); track $index; let j = $index) {
                <div class="sf-inline">
                  <input class="sf-input sf-short" aria-label="Libellé" placeholder="Ex. NIF" [ngModel]="item.label" (ngModelChange)="setPair(f, j, 'label', $event)" [name]="id + i + '-l' + j" [disabled]="readonly" />
                  <input class="sf-input" aria-label="Numéro" placeholder="Ex. 3000123456" [ngModel]="item.value" (ngModelChange)="setPair(f, j, 'value', $event)" [name]="id + i + '-v' + j" [disabled]="readonly" />
                  <button type="button" class="sf-mini" (click)="removeItem(f, j)" [disabled]="readonly" [attr.aria-label]="'Retirer la ligne ' + (j + 1)">Retirer</button>
                </div>
              }
              @if (list(f).length < (f.max || 8)) { <button type="button" class="sf-mini sf-add" (click)="addItem(f, { label: '', value: '' })" [disabled]="readonly">+ Ajouter un numéro</button> }
              @if (f.help) { <p class="sf-help">{{ f.help }}</p> }
            </div>
          }
          @case ('upload') {
            <div class="sf-row" [class.sf-full]="!f.half">
              <span class="sf-label">{{ f.label }}</span>
              <div class="sf-upload">
                @if (get(f)) { <img [src]="get(f)" [alt]="f.label" /> } @else { <div class="sf-noimg" aria-hidden="true">Aucune image</div> }
                <div>
                  <label class="sf-mini sf-filebtn">
                    {{ uploading() === f.key ? 'Envoi…' : (get(f) ? 'Remplacer' : 'Choisir un fichier') }}
                    <input type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/x-icon" (change)="onFile(f, $event)" [disabled]="readonly || uploading() !== null" />
                  </label>
                  @if (get(f)) { <button type="button" class="sf-mini" (click)="set(f, '')" [disabled]="readonly">Retirer</button> }
                </div>
              </div>
              @if (uploadError()[f.key]) { <p class="sf-error" role="alert">{{ uploadError()[f.key] }}</p> }
              @if (f.help) { <p class="sf-help">{{ f.help }}</p> }
            </div>
          }
          @case ('timezone') {
            <div class="sf-row" [class.sf-full]="!f.half">
              <label class="sf-label" [for]="id + i">{{ f.label }}</label>
              <input class="sf-input" [id]="id + i" [attr.list]="id + '-tz'" [placeholder]="f.placeholder || ''" [ngModel]="get(f)" (ngModelChange)="set(f, $event)" [name]="id + i" [disabled]="readonly" autocomplete="off" />
              <datalist [id]="id + '-tz'">@for (z of timezones; track z) { <option [value]="z"></option> }</datalist>
              @if (f.help) { <p class="sf-help">{{ f.help }}</p> }
            </div>
          }
          @case ('langs') {
            <div class="sf-row sf-full">
              <span class="sf-label">{{ f.label }}</span>
              <div class="sf-chips">
                @for (l of builtinLangs; track l.code) {
                  <label class="sf-chip" [class.on]="langOn(l.code)">
                    <input type="checkbox" [checked]="langOn(l.code)" (change)="toggleLang(l.code)" [disabled]="readonly" /> {{ l.flag }} {{ l.label }}
                  </label>
                }
                @for (c of model.customLangs || []; track c.code) {
                  <span class="sf-chip on">🌐 {{ c.name }} ({{ c.code }}) <button type="button" class="sf-x" (click)="removeCustomLang(c.code)" [disabled]="readonly" [attr.aria-label]="'Retirer ' + c.name">×</button></span>
                }
              </div>
              <div class="sf-inline" style="margin-top:10px">
                <input class="sf-input sf-short" aria-label="Code de la langue à ajouter" placeholder="Code (ex. ar)" maxlength="5" [(ngModel)]="newLang.code" [name]="id + 'nlc'" [disabled]="readonly" />
                <input class="sf-input" aria-label="Nom de la langue à ajouter" placeholder="Nom (ex. العربية)" maxlength="40" [(ngModel)]="newLang.name" [name]="id + 'nln'" [disabled]="readonly" />
                <select class="sf-input sf-short" aria-label="Langue de base" [(ngModel)]="newLang.baseLang" [name]="id + 'nlb'" [disabled]="readonly">
                  @for (l of builtinLangs; track l.code) { <option [value]="l.code">Base : {{ l.label }}</option> }
                </select>
                <button type="button" class="sf-mini" (click)="addCustomLang()" [disabled]="readonly">Ajouter</button>
              </div>
              @if (langError()) { <p class="sf-error" role="alert">{{ langError() }}</p> }
              @if (f.help) { <p class="sf-help">{{ f.help }}</p> }
            </div>
            <div class="sf-row">
              <label class="sf-label" [for]="id + 'dl'">Langue par défaut</label>
              <select class="sf-input" [id]="id + 'dl'" [ngModel]="model.defaultLang" (ngModelChange)="model.defaultLang = $event; touched()" [name]="id + 'dl'" [disabled]="readonly">
                @for (code of model.enabledLangs || []; track code) { <option [value]="code">{{ langName(code) }}</option> }
              </select>
            </div>
          }
          @case ('roles') {
            <div class="sf-row sf-full">
              <span class="sf-label">{{ f.label }}</span>
              <div class="sf-chips">
                @for (r of roles; track r.id) {
                  <label class="sf-chip" [class.on]="list(f).includes(r.id)">
                    <input type="checkbox" [checked]="list(f).includes(r.id)" (change)="toggleInList(f, r.id)" [disabled]="readonly" /> {{ r.name }}
                  </label>
                }
              </div>
              @if (f.help) { <p class="sf-help">{{ f.help }}</p> }
            </div>
          }
          @default {
            <div class="sf-row" [class.sf-full]="!f.half">
              <label class="sf-label" [for]="id + i">{{ f.label }}@if (f.required) { <span class="sf-req" aria-hidden="true"> *</span> }</label>
              <input class="sf-input" [id]="id + i" [type]="f.type === 'email' ? 'email' : f.type === 'tel' ? 'tel' : f.type === 'url' ? 'url' : 'text'"
                     [attr.inputmode]="f.type === 'tel' ? 'tel' : f.type === 'email' ? 'email' : f.type === 'url' ? 'url' : null"
                     [attr.maxlength]="f.maxLength || null" [placeholder]="f.placeholder || ''" [required]="!!f.required" [attr.aria-required]="f.required ? 'true' : null"
                     [ngModel]="get(f)" (ngModelChange)="set(f, $event)" [name]="id + i" [disabled]="readonly" autocomplete="off" />
              @if (f.help) { <p class="sf-help">{{ f.help }}</p> }
            </div>
          }
        }
      }
    }
  </div>`,
  styles: [`
    .sf { --sf-field:#f8fafc; --sf-border:#cbd5e1; --sf-text:#0f172a; --sf-muted:#64748b; --sf-accent:var(--brand, #1d4ed8); --sf-on:rgb(var(--brand-50, 241 244 253));
      display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:16px 18px; color:var(--sf-text); }
    .admin-root .sf { --sf-field:var(--a-bg3); --sf-border:var(--a-border2); --sf-text:var(--a-tx1); --sf-muted:var(--a-tx3); --sf-accent:var(--a-cyan); --sf-on:rgba(6,182,212,.12); }
    .sf-row { min-width:0; } .sf-full { grid-column:1 / -1; }
    @media (max-width: 640px) { .sf { grid-template-columns:1fr; } .sf-row { grid-column:1 / -1; } }
    .sf-label { display:block; font-size:13px; font-weight:600; margin-bottom:6px; color:var(--sf-text); }
    .sf-req { color:#dc2626; }
    .sf-input { width:100%; min-height:44px; padding:9px 12px; border:1px solid var(--sf-border); border-radius:10px; background:var(--sf-field); color:var(--sf-text); font:inherit; font-size:16px; }
    .sf-input:focus-visible, .sf-mini:focus-visible, .sf-toggle input:focus-visible + .sf-switch, .sf-chip:focus-within { outline:2px solid var(--sf-accent); outline-offset:2px; }
    textarea.sf-input { min-height:0; resize:vertical; line-height:1.5; }
    .sf-help { font-size:12px; color:var(--sf-muted); margin:6px 0 0; line-height:1.5; }
    .sf-error { font-size:12px; color:#dc2626; margin:6px 0 0; }
    .sf-heading { margin-top:8px; padding-top:14px; border-top:1px solid var(--sf-border); }
    .sf-heading h3 { font-size:14px; font-weight:700; margin:0; }
    .sf-toggle { display:flex; align-items:center; gap:10px; cursor:pointer; font-size:14px; font-weight:500; min-height:32px; }
    .sf-toggle input { position:absolute; opacity:0; width:1px; height:1px; }
    .sf-switch { flex:none; width:42px; height:24px; border-radius:12px; background:var(--sf-border); position:relative; transition:background .15s; }
    .sf-switch::after { content:''; position:absolute; top:3px; left:3px; width:18px; height:18px; border-radius:50%; background:#fff; transition:left .15s; box-shadow:0 1px 3px rgba(0,0,0,.25); }
    .sf-toggle input:checked + .sf-switch { background:var(--sf-accent); } .sf-toggle input:checked + .sf-switch::after { left:21px; }
    .sf-color { display:flex; gap:8px; align-items:center; } .sf-color input[type=color] { flex:none; width:48px; height:44px; padding:2px; border:1px solid var(--sf-border); border-radius:10px; background:var(--sf-field); cursor:pointer; }
    .sf-unit { display:flex; align-items:center; gap:8px; } .sf-unit span { font-size:13px; color:var(--sf-muted); white-space:nowrap; }
    .sf-inline { display:flex; gap:8px; margin-bottom:8px; align-items:center; flex-wrap:wrap; } .sf-inline .sf-input { flex:1 1 160px; } .sf-inline .sf-short { flex:0 1 150px; }
    .sf-mini { min-height:36px; padding:6px 12px; border:1px solid var(--sf-border); border-radius:8px; background:transparent; color:var(--sf-text); font-size:13px; font-weight:600; cursor:pointer; white-space:nowrap; }
    .sf-mini:hover:not(:disabled) { border-color:var(--sf-accent); color:var(--sf-accent); } .sf-mini:disabled { opacity:.5; cursor:not-allowed; }
    .sf-add { border-style:dashed; }
    .sf-upload { display:flex; gap:12px; align-items:center; flex-wrap:wrap; } .sf-upload img, .sf-noimg { width:96px; height:60px; border-radius:10px; border:1px solid var(--sf-border); background:var(--sf-field); object-fit:contain; }
    .sf-noimg { display:flex; align-items:center; justify-content:center; font-size:11px; color:var(--sf-muted); text-align:center; }
    .sf-upload > div { display:flex; gap:8px; flex-wrap:wrap; } .sf-filebtn { display:inline-flex; align-items:center; position:relative; } .sf-filebtn input { position:absolute; inset:0; opacity:0; cursor:pointer; }
    .sf-chips { display:flex; gap:8px; flex-wrap:wrap; }
    .sf-chip { display:inline-flex; align-items:center; gap:6px; min-height:36px; padding:6px 12px; border:1px solid var(--sf-border); border-radius:999px; font-size:13px; cursor:pointer; }
    .sf-chip.on { border-color:var(--sf-accent); background:var(--sf-on); } .sf-chip input { accent-color:var(--sf-accent); }
    .sf-x { border:none; background:none; color:inherit; font-size:16px; line-height:1; cursor:pointer; padding:0 2px; }
    @media (prefers-reduced-motion: reduce) { .sf-switch, .sf-switch::after { transition:none; } }
  `],
})
export class SettingsFormComponent {
  @Input({ required: true }) group!: SettingGroup;
  /** Valeurs du groupe : l'objet est modifié en place. */
  @Input({ required: true }) model: any = {};
  @Input() readonly = false;
  @Input() decimals = 0;
  @Input() currencySymbol = '';
  @Input() roles: { id: string; name: string }[] = [];
  /** Envoi d'une image : renvoie son adresse. Fourni par l'écran hôte (assistant ou paramètres). */
  @Input() uploader?: (file: File, kind: string) => Promise<string>;
  @Output() changed = new EventEmitter<{ key: string; value: any }>();

  readonly id = 'sf' + (++uid) + '-';
  readonly presets = COUNTRY_PRESETS;
  readonly builtinLangs = LANG_META;
  readonly timezones: string[] = (() => { try { return (Intl as any).supportedValuesOf('timeZone'); } catch { return []; } })();
  readonly uploading = signal<string | null>(null);
  readonly uploadError = signal<Record<string, string>>({});
  readonly langError = signal('');
  newLang = { code: '', name: '', baseLang: 'fr' };

  get fields(): Field[] { return FIELDS[this.group] ?? []; }
  get(f: Field): any { return getPath(this.model, f.key); }
  set(f: Field, value: any): void { setPath(this.model, f.key, value); this.changed.emit({ key: f.key, value }); }
  touched(): void { this.changed.emit({ key: '*', value: null }); }
  setNumber(f: Field, v: any): void { this.set(f, v === '' || v === null || isNaN(Number(v)) ? 0 : Number(v)); }
  setColor(f: Field, v: string): void { const c = (v || '').trim(); this.set(f, c && !c.startsWith('#') ? '#' + c : c); }
  toMajor(minor: any): number { return Number(minor || 0) / Math.pow(10, this.decimals); }
  toMinor(major: any): number { return Math.max(0, Math.round(Number(major || 0) * Math.pow(10, this.decimals))); }

  list(f: Field): any[] { const v = this.get(f); return Array.isArray(v) ? v : []; }
  addItem(f: Field, item: any): void { this.set(f, [...this.list(f), item]); }
  removeItem(f: Field, i: number): void { this.set(f, this.list(f).filter((_, j) => j !== i)); }
  setItem(f: Field, i: number, v: string): void { const l = [...this.list(f)]; l[i] = v; this.set(f, l); }
  setPair(f: Field, i: number, k: 'label' | 'value', v: string): void { const l = this.list(f).map(x => ({ ...x })); l[i][k] = v; this.set(f, l); }
  toggleInList(f: Field, v: string): void { const l = this.list(f); this.set(f, l.includes(v) ? l.filter(x => x !== v) : [...l, v]); }

  applyPreset(country: string): void {
    const p = COUNTRY_PRESETS.find(x => x.country === country);
    if (!p) return;
    Object.assign(this.model, p);
    this.touched();
  }

  // ── Langues ──────────────────────────────────────────────────────────────
  langOn(code: string): boolean { return (this.model.enabledLangs || []).includes(code); }
  langName(code: string): string { return LANG_META.find(l => l.code === code)?.label ?? (this.model.customLangs || []).find((c: any) => c.code === code)?.name ?? code; }
  toggleLang(code: string): void {
    const cur: string[] = this.model.enabledLangs || [];
    if (cur.includes(code)) {
      if (cur.length === 1) { this.langError.set('Au moins une langue doit rester activée.'); return; }
      this.model.enabledLangs = cur.filter(c => c !== code);
      if (this.model.defaultLang === code) this.model.defaultLang = this.model.enabledLangs[0];
    } else this.model.enabledLangs = [...cur, code];
    this.langError.set(''); this.touched();
  }
  addCustomLang(): void {
    const code = this.newLang.code.trim(), name = this.newLang.name.trim();
    if (!/^[a-z]{2}(-[A-Z]{2})?$/.test(code)) { this.langError.set('Code de langue attendu : deux lettres minuscules (ex. ar, pt, es) ou la forme pt-BR.'); return; }
    if (!name) { this.langError.set('Indiquez le nom de la langue tel qu\'il sera affiché.'); return; }
    if (this.langOn(code) || LANG_META.some(l => l.code === code)) { this.langError.set('Cette langue existe déjà.'); return; }
    this.model.customLangs = [...(this.model.customLangs || []), { code, name, baseLang: this.newLang.baseLang }];
    this.model.enabledLangs = [...(this.model.enabledLangs || []), code];
    this.newLang = { code: '', name: '', baseLang: 'fr' };
    this.langError.set(''); this.touched();
  }
  removeCustomLang(code: string): void {
    this.model.customLangs = (this.model.customLangs || []).filter((c: any) => c.code !== code);
    this.model.enabledLangs = (this.model.enabledLangs || []).filter((c: string) => c !== code);
    if (this.model.defaultLang === code) this.model.defaultLang = this.model.enabledLangs[0] || 'fr';
    this.touched();
  }

  // ── Images ───────────────────────────────────────────────────────────────
  async onFile(f: Field, ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file || !this.uploader) return;
    this.uploadError.update(e => ({ ...e, [f.key]: '' }));
    if (file.size > 2 * 1024 * 1024) { this.uploadError.update(e => ({ ...e, [f.key]: 'Fichier trop volumineux : 2 Mo maximum.' })); return; }
    this.uploading.set(f.key);
    try { this.set(f, await this.uploader(file, f.uploadKind || 'logo')); }
    catch (e: any) { this.uploadError.update(x => ({ ...x, [f.key]: e?.message || 'Envoi impossible. Réessayez.' })); }
    finally { this.uploading.set(null); }
  }
}
