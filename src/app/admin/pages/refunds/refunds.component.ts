import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { AdminDataService, Refund } from '../../services/admin-data.service';
import { AdminAuthService } from '../../services/admin-auth.service';
import { AdminToastService } from '../../services/admin-toast.service';
import { AppConfigService } from '../../../core/config/app-config.service';

const STATUS: Record<string, { label: string; color: string }> = {
  pending: { label: 'En attente', color: 'var(--a-amber)' }, processing: { label: 'En cours', color: 'var(--a-cyan)' },
  manual: { label: 'À faire à la main', color: 'var(--a-red)' }, succeeded: { label: 'Remboursé', color: 'var(--a-green)' }, failed: { label: 'Échec', color: 'var(--a-red)' },
};

/** Remboursements : ceux que l'opérateur a traités automatiquement et ceux qu'un agent doit effectuer à la main. */
@Component({
  selector: 'app-refunds',
  standalone: true,
  imports: [FormsModule, RouterLink],
  template: `
  <div class="a-fade">
    <div style="margin-bottom:18px">
      <h1 style="font-size:18px;font-weight:700;color:var(--a-tx1);margin:0">Remboursements</h1>
      <div class="a-mono" style="font-size:11px;color:var(--a-tx3);margin-top:3px">Annulations, voyages supprimés et paiements arrivés trop tard</div>
    </div>
    <div class="a-card" style="padding:12px 16px;margin-bottom:14px;font-size:12px;color:var(--a-tx2);line-height:1.6">
      Quand l'opérateur de paiement ne permet pas le remboursement automatique, la ligne passe « À faire à la main » :
      remboursez le voyageur (transfert mobile ou espèces), puis cliquez sur <strong>Marquer comme remboursé</strong> en indiquant la référence du transfert.
    </div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px">
      @for (f of filters; track f.id) {
        <button class="a-btn sm" [class.primary]="status() === f.id" [class.ghost]="status() !== f.id" (click)="status.set(f.id); load(1)">{{ f.label }}</button>
      }
    </div>
    <div class="a-card" style="padding:0;overflow:hidden">
      @if (loading()) { <div style="padding:28px;text-align:center;color:var(--a-tx3);font-size:12px" role="status">Chargement…</div> }
      @else if (error()) { <div style="padding:28px;text-align:center;color:var(--a-red);font-size:12px" role="alert">{{ error() }} <button class="a-btn ghost sm" (click)="load(page())">Réessayer</button></div> }
      @else if (!items().length) { <div style="padding:28px;text-align:center;color:var(--a-tx3);font-size:12px">Aucun remboursement dans cette liste.</div> }
      @else {
        <div class="a-table-wrap">
          <table class="a-table">
            <thead><tr><th>Date</th><th>Réservation</th><th>Voyageur</th><th>Moyen</th><th style="text-align:right">Montant</th><th>Motif</th><th>État</th><th></th></tr></thead>
            <tbody>
              @for (r of items(); track r.id) {
                <tr>
                  <td class="a-mono" style="font-size:11px;white-space:nowrap">{{ cfg.date(r.createdAt, { time: true }) }}</td>
                  <td><a class="a-mono" style="font-size:12px;color:var(--a-cyan)" routerLink="/admin/bookings" [queryParams]="{ search: r.reference }">{{ r.reference }}</a></td>
                  <td style="font-size:12px">{{ r.contactName }}<div class="a-mono" style="font-size:10px;color:var(--a-tx3)">{{ r.payerPhone }}</div></td>
                  <td style="font-size:11px">{{ r.method }}</td>
                  <td class="a-mono" style="text-align:right;font-weight:700;white-space:nowrap">{{ cfg.money(r.amount) }}</td>
                  <td style="font-size:11px;color:var(--a-tx2);white-space:normal;min-width:160px">{{ r.reason || '—' }}</td>
                  <td><span class="a-mono" style="font-size:9px;font-weight:700;padding:2px 8px;border-radius:4px;white-space:nowrap" [style.color]="st(r.status).color" [style.border]="'1px solid ' + st(r.status).color">{{ st(r.status).label }}</span></td>
                  <td>@if (r.status === 'manual' && auth.can('canRefund')) { <button class="a-btn primary sm" (click)="ask(r)">Marquer comme remboursé</button> }</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
    </div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-top:12px;font-size:11px;color:var(--a-tx3);gap:10px;flex-wrap:wrap">
      <span>{{ total() }} remboursement(s) · page {{ page() }} sur {{ pages() }}</span>
      <span style="display:flex;gap:6px">
        <button class="a-btn ghost sm" [disabled]="page() <= 1 || loading()" (click)="load(page() - 1)">Précédent</button>
        <button class="a-btn ghost sm" [disabled]="page() >= pages() || loading()" (click)="load(page() + 1)">Suivant</button>
      </span>
    </div>

    @if (target(); as r) {
      <div class="a-modal-overlay" (click)="target.set(null)">
        <div class="a-modal" style="max-width:440px" role="dialog" aria-modal="true" aria-labelledby="rf-title" (click)="$event.stopPropagation()">
          <div class="a-modal-header"><div class="a-modal-title" id="rf-title">Confirmer le remboursement</div></div>
          <div class="a-modal-body">
            <p style="font-size:13px;color:var(--a-tx2);line-height:1.6;margin:0 0 14px">Vous confirmez avoir remboursé <strong style="color:var(--a-tx1)">{{ cfg.money(r.amount) }}</strong> à {{ r.contactName }} pour la réservation {{ r.reference }}. Cette action est enregistrée dans le journal d'audit.</p>
            <label class="a-form-label" for="rf-ref">Référence du transfert (facultatif)</label>
            <input id="rf-ref" class="a-input" [(ngModel)]="providerRef" placeholder="Ex. numéro de transaction MVola" />
          </div>
          <div class="a-modal-footer">
            <button class="a-btn ghost sm" (click)="target.set(null)">Annuler</button>
            <button class="a-btn primary sm" [disabled]="busy()" (click)="confirm(r)">{{ busy() ? 'Enregistrement…' : 'Confirmer' }}</button>
          </div>
        </div>
      </div>
    }
  </div>`,
})
export class RefundsComponent implements OnInit {
  private data = inject(AdminDataService);
  readonly auth = inject(AdminAuthService);
  readonly cfg = inject(AppConfigService);
  private toast = inject(AdminToastService);
  readonly filters = [{ id: 'manual', label: 'À faire à la main' }, { id: 'pending', label: 'En attente' }, { id: 'succeeded', label: 'Remboursés' }, { id: '', label: 'Tous' }];
  readonly status = signal('manual');
  readonly items = signal<Refund[]>([]);
  readonly total = signal(0);
  readonly page = signal(1);
  readonly loading = signal(false);
  readonly error = signal('');
  readonly target = signal<Refund | null>(null);
  readonly busy = signal(false);
  providerRef = '';
  pages(): number { return Math.max(1, Math.ceil(this.total() / 25)); }
  st(s: string) { return STATUS[s] ?? { label: s, color: 'var(--a-tx3)' }; }

  ngOnInit(): void { void this.load(1); }
  async load(page: number): Promise<void> {
    this.loading.set(true); this.error.set('');
    try { const r = await this.data.refunds(this.status(), page); this.items.set(r.items); this.total.set(r.total); this.page.set(r.page); }
    catch { this.error.set('Chargement impossible.'); }
    finally { this.loading.set(false); }
  }
  ask(r: Refund): void { this.providerRef = ''; this.target.set(r); }
  async confirm(r: Refund): Promise<void> {
    this.busy.set(true);
    const error = await this.data.markRefundDone(r.id, this.providerRef.trim() || undefined);
    this.busy.set(false);
    if (error) { this.toast.error(error); return; }
    this.toast.success('Remboursement enregistré');
    this.target.set(null);
    void this.load(this.page());
  }
}
