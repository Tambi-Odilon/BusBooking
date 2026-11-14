import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AdminAuditService } from '../../services/admin-audit.service';
import { AdminToastService } from '../../services/admin-toast.service';
import { AdminAuditEntry } from '../../models/admin.models';
import { AppConfigService } from '../../../core/config/app-config.service';

/** Journal d'audit global : lecture seule, paginé, avec contrôle d'intégrité de la chaîne de hachage. */
@Component({
  selector: 'app-audit',
  standalone: true,
  imports: [FormsModule],
  template: `
  <div class="a-fade">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;margin-bottom:18px">
      <div>
        <h1 style="font-size:18px;font-weight:700;color:var(--a-tx1);margin:0">Journal d'audit</h1>
        <div class="a-mono" style="font-size:11px;color:var(--a-tx3);margin-top:3px">Toutes les actions sensibles, conservées sans modification ni suppression possible</div>
      </div>
      <button class="a-btn ghost sm" [disabled]="verifying()" (click)="verify()">{{ verifying() ? 'Vérification…' : '🔒 Vérifier l\\'intégrité' }}</button>
    </div>

    @if (integrity(); as r) {
      <div role="status" class="a-card" style="padding:12px 16px;margin-bottom:14px;font-size:12px"
           [style.border-color]="r.intact ? 'rgba(16,185,129,.4)' : 'rgba(239,68,68,.5)'" [style.color]="r.intact ? 'var(--a-green)' : 'var(--a-red)'">
        @if (r.intact) { Journal intact : {{ r.entries }} entrées vérifiées, chaîne de hachage cohérente. }
        @else { Anomalie détectée à partir de l'entrée n° {{ r.firstBrokenId }} : le journal a été modifié en dehors de l'application. Prévenez votre technicien. }
      </div>
    }

    <div class="a-card" style="padding:14px 16px;margin-bottom:14px;display:flex;gap:10px;flex-wrap:wrap;align-items:center">
      <input class="a-input" style="flex:1 1 220px" placeholder="Rechercher (action, personne, élément…)" aria-label="Rechercher dans le journal" [(ngModel)]="search" (keyup.enter)="load(1)" />
      <select class="a-select" aria-label="Catégorie" [(ngModel)]="category" (ngModelChange)="load(1)">
        <option value="">Toutes les catégories</option>
        @for (c of svc.categories; track c) { <option [value]="c">{{ svc.categoryLabel(c) }}</option> }
      </select>
      <select class="a-select" aria-label="Gravité" [(ngModel)]="severity" (ngModelChange)="load(1)">
        <option value="">Toutes les gravités</option>
        <option value="info">Information</option><option value="success">Succès</option><option value="warning">Avertissement</option><option value="danger">Critique</option>
      </select>
      <button class="a-btn primary sm" (click)="load(1)">Filtrer</button>
    </div>

    <div class="a-card" style="padding:0;overflow:hidden">
      @if (loading()) { <div style="padding:28px;text-align:center;color:var(--a-tx3);font-size:12px" role="status">Chargement…</div> }
      @else if (error()) { <div style="padding:28px;text-align:center;color:var(--a-red);font-size:12px" role="alert">{{ error() }} <button class="a-btn ghost sm" (click)="load(page())">Réessayer</button></div> }
      @else if (!items().length) { <div style="padding:28px;text-align:center;color:var(--a-tx3);font-size:12px">Aucune entrée ne correspond à ces critères.</div> }
      @else {
        <div class="a-table-wrap">
          <table class="a-table">
            <thead><tr><th>Date</th><th>Auteur</th><th>Catégorie</th><th>Action</th><th>Élément concerné</th><th></th></tr></thead>
            <tbody>
              @for (e of items(); track e.id) {
                <tr style="cursor:pointer" (click)="open.set(open()?.id === e.id ? null : e)">
                  <td class="a-mono" style="font-size:11px;white-space:nowrap">{{ cfg.date(e.createdAt, { time: true }) }}</td>
                  <td style="font-size:12px">{{ $any(e).adminName || 'Système' }}<div class="a-mono" style="font-size:9px;color:var(--a-tx3)">{{ e.adminPublicId }}</div></td>
                  <td style="font-size:11px;white-space:nowrap">{{ svc.categoryIcon(e.category) }} {{ svc.categoryLabel(e.category) }}</td>
                  <td style="font-size:12px;font-weight:600" [style.color]="svc.severityColor(e.severity)">{{ e.action }}</td>
                  <td style="font-size:12px;color:var(--a-tx2)">{{ e.targetName || '—' }}</td>
                  <td style="font-size:11px;color:var(--a-cyan);white-space:nowrap">{{ open()?.id === e.id ? 'Fermer' : 'Détail' }}</td>
                </tr>
                @if (open()?.id === e.id) {
                  <tr><td colspan="6" style="background:var(--a-bg3);white-space:normal">
                    @if (e.details) { <div style="font-size:12px;color:var(--a-tx2);margin-bottom:8px">{{ e.details }}</div> }
                    @if (e.diff?.length) {
                      <table style="font-size:11px;border-collapse:collapse">
                        @for (d of e.diff; track d.field) {
                          <tr><td style="padding:3px 12px 3px 0;color:var(--a-tx3)">{{ d.label }}</td>
                              <td class="a-mono" style="padding:3px 12px 3px 0;color:var(--a-red);text-decoration:line-through">{{ d.before }}</td>
                              <td class="a-mono" style="padding:3px 0;color:var(--a-green)">{{ d.after }}</td></tr>
                        }
                      </table>
                    }
                    <div class="a-mono" style="font-size:10px;color:var(--a-tx3);margin-top:8px">Entrée n° {{ e.id }}@if (e.ipHint) { · adresse {{ e.ipHint }} }@if (e.targetId) { · identifiant {{ e.targetId }} }</div>
                  </td></tr>
                }
              }
            </tbody>
          </table>
        </div>
      }
    </div>

    <div style="display:flex;justify-content:space-between;align-items:center;margin-top:12px;font-size:11px;color:var(--a-tx3);gap:10px;flex-wrap:wrap">
      <span>{{ total() }} entrée(s) · page {{ page() }} sur {{ pages() }}</span>
      <span style="display:flex;gap:6px">
        <button class="a-btn ghost sm" [disabled]="page() <= 1 || loading()" (click)="load(page() - 1)">Précédent</button>
        <button class="a-btn ghost sm" [disabled]="page() >= pages() || loading()" (click)="load(page() + 1)">Suivant</button>
      </span>
    </div>
  </div>`,
})
export class AuditComponent implements OnInit {
  readonly svc = inject(AdminAuditService);
  readonly cfg = inject(AppConfigService);
  private toast = inject(AdminToastService);
  search = ''; category = ''; severity = '';
  readonly items = signal<AdminAuditEntry[]>([]);
  readonly total = signal(0);
  readonly page = signal(1);
  readonly loading = signal(false);
  readonly error = signal('');
  readonly open = signal<AdminAuditEntry | null>(null);
  readonly verifying = signal(false);
  readonly integrity = signal<{ entries: number; intact: boolean; firstBrokenId: number | null } | null>(null);
  private readonly limit = 30;
  pages(): number { return Math.max(1, Math.ceil(this.total() / this.limit)); }

  ngOnInit(): void { void this.load(1); }
  async load(page: number): Promise<void> {
    this.loading.set(true); this.error.set('');
    try {
      const r = await this.svc.search({ search: this.search.trim(), category: this.category, severity: this.severity, page, limit: this.limit });
      this.items.set(r.items); this.total.set(r.total); this.page.set(r.page); this.open.set(null);
    } catch { this.error.set('Chargement impossible.'); }
    finally { this.loading.set(false); }
  }
  async verify(): Promise<void> {
    this.verifying.set(true);
    try { this.integrity.set(await this.svc.verify()); } catch { this.toast.error('Vérification impossible pour le moment'); }
    finally { this.verifying.set(false); }
  }
}
