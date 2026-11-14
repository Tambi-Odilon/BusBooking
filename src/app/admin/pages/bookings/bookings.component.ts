import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { AdminDataService, BookingQuery } from '../../services/admin-data.service';
import { AdminAuthService } from '../../services/admin-auth.service';
import { AdminToastService } from '../../services/admin-toast.service';
import { AdminLiveService } from '../../services/admin-live.service';
import { AppConfigService } from '../../../core/config/app-config.service';
import { RealtimeService } from '../../../core/realtime/realtime.service';
import { errorMessage } from '../../../core/api/api.service';
import { ApiBooking } from '../../../core/models/booking.models';
import { AdminBooking } from '../../models/admin.models';
import { AriaryPipe, AdminDatePipe } from '../../pipes/admin.pipes';
import { ChangeBookingComponent } from '../../../features/ticket/change-booking.component';

const STATUS: Record<string, { label: string; color: string }> = {
  pending_payment: { label: 'Paiement en attente', color: 'var(--a-amber)' }, pending: { label: 'Paiement en attente', color: 'var(--a-amber)' }, confirmed: { label: 'Confirmée', color: 'var(--a-green)' },
  cancelled: { label: 'Annulée', color: 'var(--a-red)' }, expired: { label: 'Expirée', color: 'var(--a-tx3)' }, completed: { label: 'Voyage effectué', color: 'var(--a-cyan)' }, no_show: { label: 'Absent', color: 'var(--a-tx3)' },
};
const PAY: Record<string, string> = { unpaid: 'Non payé', pending: 'En attente', paid: 'Payé', refund_pending: 'Remboursement en cours', partially_refunded: 'Remboursé en partie', refunded: 'Remboursé' };
export const METHOD_LABELS: Record<string, string> = { cash: 'Espèces', mvola: 'MVola', orange_money: 'Orange Money', airtel_money: 'Airtel Money' };

/** Réservations : recherche et filtres côté serveur, pagination, détail, annulation avec remboursement, absents. */
@Component({
  selector: 'app-bookings',
  standalone: true,
  imports: [FormsModule, RouterLink, AriaryPipe, AdminDatePipe, ChangeBookingComponent],
  template: `
<div class="a-fade">
  <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:flex-start;margin-bottom:14px">
    <div><div style="font-size:18px;font-weight:700;letter-spacing:-.4px">Réservations</div>
      <div class="a-mono" style="font-size:11px;color:var(--a-tx3);margin-top:3px">{{ total() }} résultat(s) · page {{ q.page }} / {{ pages() }}</div></div>
    @if (auth.can('canSellWalkin')) { <a routerLink="/admin/walkin" class="a-btn primary sm">+ Vente au guichet</a> }
  </div>

  <form (ngSubmit)="search()" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;align-items:flex-end">
    <div style="flex:1;min-width:200px"><label class="a-form-label" for="bq">Référence, nom, téléphone ou e-mail</label><input id="bq" name="q" class="a-input" [(ngModel)]="q.search" placeholder="Rechercher…" /></div>
    <div><label class="a-form-label" for="bs">Statut</label>
      <select id="bs" name="st" class="a-select" [(ngModel)]="q.status" (ngModelChange)="search()">
        <option value="">Tous</option><option value="confirmed">Confirmées</option><option value="pending_payment">Paiement en attente</option><option value="cancelled">Annulées</option><option value="expired">Expirées</option><option value="completed">Effectuées</option><option value="no_show">Absents</option>
      </select></div>
    <div><label class="a-form-label" for="bc">Canal</label>
      <select id="bc" name="ch" class="a-select" [(ngModel)]="q.channel" (ngModelChange)="search()"><option value="">Tous</option><option value="web">Site</option><option value="counter">Guichet</option></select></div>
    <div><label class="a-form-label" for="bf">Voyage du</label><input id="bf" name="from" type="date" class="a-input" [(ngModel)]="q.from" (ngModelChange)="search()" /></div>
    <div><label class="a-form-label" for="bt">au</label><input id="bt" name="to" type="date" class="a-input" [(ngModel)]="q.to" (ngModelChange)="search()" /></div>
    <label style="display:flex;gap:6px;align-items:center;font-size:12px;height:36px"><input type="checkbox" name="att" [(ngModel)]="q.attention" (ngModelChange)="search()" /> À traiter</label>
    <button type="submit" class="a-btn ghost">Rechercher</button>
  </form>

  @if (error()) { <div class="a-card" role="alert" style="color:var(--a-red);margin-bottom:10px">{{ error() }} <button class="a-btn ghost sm" (click)="load()">Réessayer</button></div> }
  <div class="a-card" style="padding:0">
    <div class="a-table-wrap">
      <table class="a-table">
        <thead><tr><th>Référence</th><th>Client</th><th>Voyage</th><th>Sièges</th><th>Montant</th><th>Paiement</th><th>Statut</th><th>Créée le</th></tr></thead>
        <tbody>
          @for (b of rows(); track b.id) {
            <tr (click)="open(b)" (keydown.enter)="open(b)" tabindex="0" style="cursor:pointer" [style.background]="detail()?.id === b.id ? 'var(--a-bg3)' : ''">
              <td class="a-mono" style="font-weight:700;color:var(--a-cyan)">{{ b.reference }} @if (b.needsAttention) { <span title="À traiter" style="color:var(--a-amber)">⚠</span> }</td>
              <td>{{ b.userName }}<div class="a-mono" style="font-size:10px;color:var(--a-tx3)">{{ b.phone }}</div></td>
              <td>{{ b.from }} → {{ b.to }}<div style="font-size:10px;color:var(--a-tx3)">{{ b.date | adminDate }} · {{ b.departure | adminDate:'time' }}</div></td>
              <td class="a-mono">{{ b.seats.join(', ') || '—' }}</td>
              <td class="a-mono" style="font-weight:600">{{ b.totalAmount | ariary }}</td>
              <td style="font-size:11px">{{ method(b.paymentMethod) }}<div style="font-size:10px;color:var(--a-tx3)">{{ b.channel === 'counter' ? 'Guichet' + (b.soldByName ? ' · ' + b.soldByName : '') : 'Site' }}</div></td>
              <td><span class="a-badge" [style.color]="st(b.status).color">{{ st(b.status).label }}</span></td>
              <td style="font-size:11px">{{ b.createdAt | adminDate:'datetime' }}</td>
            </tr>
          }
          @if (!loading() && !rows().length) { <tr><td colspan="8" style="text-align:center;padding:28px;color:var(--a-tx3)">Aucune réservation ne correspond à ces critères.</td></tr> }
          @if (loading() && !rows().length) { <tr><td colspan="8" style="text-align:center;padding:28px;color:var(--a-tx3)">Chargement…</td></tr> }
        </tbody>
      </table>
    </div>
  </div>
  <div style="display:flex;justify-content:center;gap:8px;margin-top:12px;align-items:center">
    <button class="a-btn ghost sm" [disabled]="q.page! <= 1 || loading()" (click)="go(q.page! - 1)">← Précédent</button>
    <span class="a-mono" style="font-size:11px">{{ q.page }} / {{ pages() }}</span>
    <button class="a-btn ghost sm" [disabled]="q.page! >= pages() || loading()" (click)="go(q.page! + 1)">Suivant →</button>
  </div>

  @if (detail(); as d) {
    <div class="a-modal-overlay" (click)="close()">
      <div class="a-modal" role="dialog" aria-modal="true" aria-labelledby="bk-title" (click)="$event.stopPropagation()" style="max-width:640px;width:100%;max-height:90vh;overflow:auto">
        <div class="a-modal-header"><div class="a-modal-title" id="bk-title"><span class="a-mono">{{ d.reference }}</span> · <span [style.color]="st(d.status).color">{{ st(d.status).label }}</span></div>
          <button class="a-btn ghost sm" (click)="close()" aria-label="Fermer">✕</button></div>
        <div class="a-modal-body" style="display:grid;gap:12px;font-size:13px">
          @if (d.needsAttention) { <div role="alert" style="background:rgba(245,158,11,.12);border:1px solid rgba(245,158,11,.4);border-radius:8px;padding:10px">
            <strong>À traiter :</strong> {{ d.attentionNote || 'vérifiez cette réservation avec le client.' }}
            @if (auth.can('canManageBookings')) { <button class="a-btn ghost sm" style="margin-left:8px" (click)="resolve(d)">Marquer comme traité</button> }</div> }
          <div><strong>{{ d.trip.fromCity }} → {{ d.trip.toCity }}</strong> · {{ d.trip.serviceDate | adminDate:'long' }} · {{ cfg.time(d.trip.departure) }}<div style="font-size:11px;color:var(--a-tx3)">{{ d.trip.vehicleName }}</div></div>
          <div>Contact : {{ d.contact.name }} · <span class="a-mono">{{ d.contact.phone }}</span> @if (d.contact.email) { · {{ d.contact.email }} }</div>
          <div class="a-table-wrap"><table class="a-table">
            <thead><tr><th></th><th>Siège</th><th>Passager</th><th>Billet</th><th>Prix</th><th>État</th></tr></thead>
            <tbody>@for (p of d.passengers; track p.id) {
              <tr [style.opacity]="p.status === 'cancelled' ? .5 : 1">
                <td>@if (p.status === 'active' && canAct(d)) { <input type="checkbox" [checked]="picked().includes(p.id)" (change)="pick(p.id)" [attr.aria-label]="'Sélectionner ' + p.firstName + ' ' + p.lastName" /> }</td>
                <td class="a-mono" style="font-weight:700">{{ p.seatNo }}</td><td>{{ p.firstName }} {{ p.lastName }}</td><td class="a-mono" style="font-size:10px">{{ p.ticketNumber || '—' }}</td>
                <td class="a-mono">{{ p.price | ariary }}</td><td style="font-size:11px">{{ paxStatus(p.status) }}</td>
              </tr> }</tbody>
          </table></div>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px">
            <div>Total<div class="a-mono" style="font-weight:700;font-size:15px">{{ d.total | ariary }}</div></div>
            <div>Paiement<div style="font-weight:600">{{ payLabel(d.payment.status) }} @if (d.payment.method) { · {{ method(d.payment.method) }} }</div></div>
            @if (d.payment.refundedAmount) { <div>Remboursé<div class="a-mono">{{ d.payment.refundedAmount | ariary }}</div></div> }
            @if (d.payment.refundPendingAmount) { <div>À rembourser<div class="a-mono" style="color:var(--a-amber)">{{ d.payment.refundPendingAmount | ariary }}</div></div> }
          </div>
          @if (d.cancelReason) { <div style="font-size:12px;color:var(--a-tx3)">Motif d'annulation : {{ d.cancelReason }}</div> }

          @if (d.status === 'confirmed' && auth.can('canManageBookings')) {
            @if (changing()) {
              <div style="border:1px solid var(--a-border);border-radius:8px;padding:12px">
                <app-change-booking [booking]="d" [staff]="true" (changed)="onChanged($event)" (closed)="changing.set(false)" />
              </div>
            } @else {
              <div><button class="a-btn ghost sm" (click)="changing.set(true)">Changer de siège ou de départ</button></div>
            }
          }
          @if (canAct(d) && !changing()) {
            <fieldset style="border:1px solid var(--a-border);border-radius:8px;padding:12px;display:grid;gap:8px">
              <legend style="font-size:11px;font-weight:700;padding:0 6px">Annuler {{ picked().length ? picked().length + ' passager(s)' : 'toute la réservation' }}</legend>
              <input class="a-input" [(ngModel)]="reason" placeholder="Motif (facultatif)" maxlength="300" aria-label="Motif" />
              <label style="font-size:12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">Remboursement :
                <select class="a-select" style="width:auto" [(ngModel)]="refundMode" aria-label="Remboursement">
                  <option value="policy">selon la politique ({{ d.refundPercent }} %)</option><option value="100">100 %</option><option value="50">50 %</option><option value="0">aucun</option>
                </select></label>
              <div style="display:flex;gap:8px;flex-wrap:wrap">
                <button class="a-btn danger sm" [disabled]="busy()" (click)="cancel(d)">Confirmer l'annulation</button>
                <button class="a-btn ghost sm" [disabled]="busy()" (click)="noShow(d)">Marquer absent(s)</button>
              </div>
            </fieldset>
          }
          @if (actionError()) { <div role="alert" style="color:var(--a-red)">{{ actionError() }}</div> }
        </div>
        <div class="a-modal-footer">
          @if (d.status === 'confirmed' || d.status === 'completed') { <button class="a-btn ghost sm" (click)="pdf(d)">Billet PDF</button> }
          <button class="a-btn primary sm" (click)="close()">Fermer</button>
        </div>
      </div>
    </div>
  }
</div>`,
})
export class BookingsComponent implements OnInit, OnDestroy {
  private data = inject(AdminDataService);
  private live = inject(AdminLiveService);
  private toast = inject(AdminToastService);
  private realtime = inject(RealtimeService);
  readonly auth = inject(AdminAuthService);
  readonly cfg = inject(AppConfigService);

  q: BookingQuery = { search: '', status: '', channel: '', from: '', to: '', attention: false, page: 1, limit: 25 };
  readonly rows = signal<AdminBooking[]>([]);
  readonly total = signal(0);
  readonly pages = signal(1);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly detail = signal<ApiBooking | null>(null);
  readonly changing = signal(false);
  readonly picked = signal<string[]>([]);
  readonly busy = signal(false);
  readonly actionError = signal<string | null>(null);
  reason = ''; refundMode = 'policy';
  private offs: Array<() => void> = [];
  private seq = 0;

  ngOnInit(): void {
    void this.load();
    this.offs = ['booking.created', 'booking.updated'].map(ev => this.realtime.on(ev, () => { if (this.q.page === 1 && !this.detail()) void this.load(true); }));
  }
  ngOnDestroy(): void { this.offs.forEach(off => off()); }
  search(): void { this.q.page = 1; void this.load(); }
  go(page: number): void { this.q.page = page; void this.load(); }
  async load(quiet = false): Promise<void> {
    const mine = ++this.seq;
    if (!quiet) this.loading.set(true);
    try {
      const r = await this.data.searchBookings({ ...this.q, search: this.q.search?.trim(), from: this.q.from || undefined, to: this.q.to || undefined });
      if (mine !== this.seq) return;
      this.rows.set(r.items); this.total.set(r.total); this.pages.set(Math.max(1, Math.ceil(r.total / r.limit))); this.error.set(null);
    } catch (e) { if (mine === this.seq && !quiet) this.error.set(errorMessage(e, 'Chargement impossible')); }
    finally { if (mine === this.seq) this.loading.set(false); }
  }
  async open(b: AdminBooking): Promise<void> {
    this.changing.set(false);
    this.picked.set([]); this.reason = ''; this.refundMode = 'policy'; this.actionError.set(null);
    try { this.detail.set(await this.data.bookingDetail(b.id)); } catch (e) { this.toast.error(errorMessage(e)); }
  }
  close(): void { this.detail.set(null); this.changing.set(false); }
  async onChanged(fresh: ApiBooking): Promise<void> {
    this.changing.set(false); this.toast.success('Réservation modifiée');
    try { this.detail.set(await this.data.bookingDetail(fresh.id)); } catch { this.detail.set(fresh); }
    void this.load(true);
  }
  pick(id: string): void { this.picked.update(l => l.includes(id) ? l.filter(x => x !== id) : [...l, id]); }
  canAct(d: ApiBooking): boolean { return this.auth.can('canManageBookings') && (d.status === 'confirmed' || d.status === 'pending_payment'); }
  private async after(err: string | null, id: string, ok: string): Promise<void> {
    this.busy.set(false);
    if (err) { this.actionError.set(err); return; }
    this.toast.success(ok); this.picked.set([]);
    try { this.detail.set(await this.data.bookingDetail(id)); } catch { this.detail.set(null); }
    void this.load(true);
  }
  async cancel(d: ApiBooking): Promise<void> {
    this.busy.set(true); this.actionError.set(null);
    const err = await this.data.cancelBooking(d.id, { reason: this.reason.trim() || undefined, passengerIds: this.picked().length ? this.picked() : undefined,
      refundPercent: this.refundMode === 'policy' ? undefined : Number(this.refundMode) });
    await this.after(err, d.id, 'Annulation enregistrée');
  }
  async noShow(d: ApiBooking): Promise<void> {
    this.busy.set(true); this.actionError.set(null);
    await this.after(await this.data.markNoShow(d.id, this.picked().length ? this.picked() : undefined), d.id, 'Absence enregistrée');
  }
  async resolve(d: ApiBooking): Promise<void> { this.busy.set(true); await this.after(await this.data.resolveAttention(d.id), d.id, 'Signalement levé'); }
  async pdf(d: ApiBooking): Promise<void> { try { await this.live.ticketPdf(d.reference); } catch (e) { this.toast.error(errorMessage(e)); } }
  st(s: string) { return STATUS[s] ?? { label: s, color: 'var(--a-tx2)' }; }
  payLabel(s: string): string { return PAY[s] ?? s; }
  method(m: string | null | undefined): string { return m ? (METHOD_LABELS[m] ?? this.cfg.config().payments.find(p => p.code === m)?.name ?? m) : '—'; }
  paxStatus(s: string): string { return ({ active: 'Valide', cancelled: 'Annulé', boarded: 'Embarqué', no_show: 'Absent' } as Record<string, string>)[s] ?? s; }
}
