import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { SeatMapComponent } from '../../components/admin-shared.component';
import { AdminLiveService, LiveTrip, Manifest } from '../../services/admin-live.service';
import { AdminDataService } from '../../services/admin-data.service';
import { AdminToastService } from '../../services/admin-toast.service';
import { AppConfigService } from '../../../core/config/app-config.service';
import { RealtimeService } from '../../../core/realtime/realtime.service';
import { ApiError, errorMessage, newKey } from '../../../core/api/api.service';
import { ApiBooking, HoldInfo } from '../../../core/models/booking.models';
import { AdminClientUser } from '../../models/admin.models';
import { AriaryPipe, AdminDatePipe } from '../../pipes/admin.pipes';

interface Pax { seatNo: string; firstName: string; lastName: string; category: 'adult' | 'child' }
type Step = 1 | 2 | 3 | 4;

/**
 * Vente au guichet. Les sièges choisis sont verrouillés sur le serveur pendant la saisie (un client du site les voit
 * « en cours »), et la vente est enregistrée en une seule opération : impossible de vendre deux fois le même siège.
 */
@Component({
  selector: 'app-walkin',
  standalone: true,
  imports: [FormsModule, SeatMapComponent, AriaryPipe, AdminDatePipe],
  template: `
<div class="a-fade" style="max-width:1100px">
  <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px">
    <div style="font-size:18px;font-weight:700;letter-spacing:-.4px">Vente au guichet</div>
    <ol style="display:flex;gap:6px;list-style:none;margin:0;padding:0;font-size:11px" aria-label="Étapes">
      @for (s of steps; track s.n) {
        <li [style]="'padding:4px 10px;border-radius:20px;border:1px solid var(--a-border);' + (step() === s.n ? 'background:var(--a-cyan);color:#000;font-weight:700' : step() > s.n ? 'color:var(--a-green)' : 'color:var(--a-tx3)')"
            [attr.aria-current]="step() === s.n ? 'step' : null">{{ s.n }}. {{ s.label }}</li>
      }
    </ol>
  </div>

  <!-- 1. Départ -->
  @if (step() === 1) {
    <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:12px">
      @for (d of days; track d.date) { <button [class]="'a-btn sm ' + (date() === d.date ? 'primary' : 'ghost')" (click)="setDate(d.date)">{{ d.label }}</button> }
      <input type="date" [ngModel]="date()" (ngModelChange)="setDate($event)" [min]="cfg.today()" class="a-input" style="height:32px;width:150px;font-size:12px" aria-label="Autre date" />
      <input class="a-input" style="height:32px;max-width:220px;font-size:12px" placeholder="Filtrer par ville…" [ngModel]="filter()" (ngModelChange)="filter.set($event)" aria-label="Filtrer par ville" />
    </div>
    @if (loading()) { <div class="a-card" style="color:var(--a-tx3)">Chargement des départs…</div> }
    @if (error()) { <div class="a-card" role="alert" style="color:var(--a-red)">{{ error() }} <button class="a-btn ghost sm" (click)="loadTrips()">Réessayer</button></div> }
    @if (!loading() && !error() && !sellable().length) { <div class="a-card" style="text-align:center;padding:32px;color:var(--a-tx3)">Aucun départ en vente à cette date.</div> }
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,260px),1fr));gap:10px">
      @for (t of sellable(); track t.id) {
        <button type="button" class="a-card" style="text-align:left;cursor:pointer;padding:14px;color:inherit;font:inherit" [disabled]="t.capacity - t.seatsTaken <= 0" (click)="chooseTrip(t)">
          <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px">
            <span class="a-mono" style="font-size:20px;font-weight:700;color:var(--a-cyan)">{{ cfg.time(t.departure) }}</span>
            <span style="font-weight:700">{{ t.price | ariary }}</span>
          </div>
          <div style="font-weight:600;margin-top:4px">{{ t.fromCity }} → {{ t.toCity }}</div>
          <div style="font-size:11px;color:var(--a-tx3)">{{ t.vehicleName }} · arrivée {{ cfg.time(t.arrival) }}</div>
          <div style="margin-top:8px;font-size:12px;font-weight:600" [style.color]="t.capacity - t.seatsTaken > 5 ? 'var(--a-green)' : t.capacity - t.seatsTaken > 0 ? 'var(--a-amber)' : 'var(--a-red)'">
            {{ t.capacity - t.seatsTaken > 0 ? (t.capacity - t.seatsTaken) + ' place(s) libre(s)' : 'Complet' }}
          </div>
        </button>
      }
    </div>
  }

  <!-- 2. Sièges -->
  @if (step() === 2 && trip(); as t) {
    <div class="a-card">
      <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:12px">
        <div><div style="font-weight:700">{{ t.fromCity }} → {{ t.toCity }} · {{ cfg.time(t.departure) }}</div><div style="font-size:11px;color:var(--a-tx3)">{{ t.serviceDate | adminDate:'long' }} · {{ t.vehicleName }}</div></div>
        <button class="a-btn ghost sm" (click)="back()">← Changer de départ</button>
      </div>
      @if (manifest(); as m) {
        <div style="display:flex;gap:20px;flex-wrap:wrap;align-items:flex-start">
          <adm-seat-map [layout]="m.layout.code" [rows]="m.layout.rows" [booked]="booked()" [pending]="heldByOthers()" [selected]="seats()" [selectable]="!busy()" [size]="36" (seatClick)="toggleSeat($event)" />
          <div style="flex:1;min-width:220px">
            <div class="a-card-title">Sélection</div>
            @if (!seats().length) { <div style="font-size:12px;color:var(--a-tx3)">Touchez les sièges à vendre sur le plan.</div> }
            <div style="display:flex;gap:6px;flex-wrap:wrap">@for (s of seats(); track s) { <span class="a-badge a-mono" style="color:var(--a-cyan);font-size:13px">{{ s }}</span> }</div>
            @if (hold(); as h) { <div class="a-mono" style="font-size:11px;color:var(--a-amber);margin-top:10px" role="timer">Sièges retenus encore {{ remaining() }}</div> }
            <div style="margin-top:14px;font-size:13px">{{ seats().length }} × {{ t.price | ariary }}</div>
            <div style="font-size:20px;font-weight:800;color:var(--a-cyan)">{{ estimate().total | ariary }}</div>
            @if (estimate().fee) { <div style="font-size:10px;color:var(--a-tx3)">dont frais de service {{ estimate().fee | ariary }}</div> }
            <button class="a-btn primary" style="margin-top:14px;width:100%;justify-content:center" [disabled]="!seats().length || busy()" (click)="toPassengers()">Continuer</button>
          </div>
        </div>
      } @else { <div style="color:var(--a-tx3)">Chargement du plan des sièges…</div> }
    </div>
  }

  <!-- 3. Passagers et paiement -->
  @if (step() === 3 && trip(); as t) {
    <form class="a-card" (ngSubmit)="confirm()" style="display:grid;gap:16px">
      <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap">
        <div><div style="font-weight:700">{{ t.fromCity }} → {{ t.toCity }} · {{ cfg.time(t.departure) }}</div><div style="font-size:11px;color:var(--a-tx3)">Sièges {{ seats().join(', ') }} @if (hold()) { · retenus encore {{ remaining() }} }</div></div>
        <button type="button" class="a-btn ghost sm" (click)="step.set(2)">← Sièges</button>
      </div>

      <fieldset style="border:0;padding:0;margin:0;display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(200px,1fr))">
        <legend class="a-card-title">Client</legend>
        <div><label class="a-form-label" for="w-phone">Téléphone *</label>
          <input id="w-phone" name="phone" class="a-input" type="tel" inputmode="tel" autocomplete="off" [(ngModel)]="contact.phone" (ngModelChange)="lookup($event)" [placeholder]="cfg.locale().phonePrefix + ' …'" required /></div>
        <div><label class="a-form-label" for="w-first">Prénom *</label><input id="w-first" name="first" class="a-input" [(ngModel)]="contact.firstName" (ngModelChange)="syncNames()" required maxlength="60" /></div>
        <div><label class="a-form-label" for="w-last">Nom *</label><input id="w-last" name="last" class="a-input" [(ngModel)]="contact.lastName" (ngModelChange)="syncNames()" required maxlength="60" /></div>
        <div><label class="a-form-label" for="w-mail">E-mail (pour recevoir le billet)</label><input id="w-mail" name="email" class="a-input" type="email" [(ngModel)]="contact.email" /></div>
      </fieldset>
      @if (known(); as c) { <div style="font-size:12px;color:var(--a-green)">Client connu : {{ c.firstName }} {{ c.lastName }} · {{ c.bookingCount }} réservation(s)</div> }

      @if (pax().length > 1) {
        <fieldset style="border:0;padding:0;margin:0">
          <legend class="a-card-title">Passagers</legend>
          <label style="display:flex;gap:8px;align-items:center;font-size:12px;margin-bottom:8px"><input type="checkbox" name="same" [(ngModel)]="sameName" (ngModelChange)="syncNames()" /> Tous les billets au nom du client</label>
          @if (!sameName) {
            <div style="display:grid;gap:8px">
              @for (p of pax(); track p.seatNo; let i = $index) {
                <div style="display:grid;grid-template-columns:54px 1fr 1fr;gap:8px;align-items:center">
                  <span class="a-badge a-mono" style="color:var(--a-cyan);text-align:center">{{ p.seatNo }}</span>
                  <input class="a-input" [name]="'pf' + i" [(ngModel)]="p.firstName" placeholder="Prénom" [attr.aria-label]="'Prénom, siège ' + p.seatNo" required />
                  <input class="a-input" [name]="'pl' + i" [(ngModel)]="p.lastName" placeholder="Nom" [attr.aria-label]="'Nom, siège ' + p.seatNo" required />
                </div>
              }
            </div>
          }
        </fieldset>
      }
      @if (cfg.booking().child.enabled) {
        <div style="display:flex;gap:10px;flex-wrap:wrap;font-size:12px;align-items:center">Tarif enfant (jusqu'à {{ cfg.booking().child.maxAge }} ans, −{{ cfg.booking().child.discountPercent }} %) :
          @for (p of pax(); track p.seatNo; let i = $index) { <label style="display:flex;gap:4px;align-items:center"><input type="checkbox" [name]="'ch' + i" [checked]="p.category === 'child'" (change)="p.category = p.category === 'child' ? 'adult' : 'child'" /> {{ p.seatNo }}</label> }
        </div>
      }

      <fieldset style="border:0;padding:0;margin:0">
        <legend class="a-card-title">Paiement</legend>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          @for (m of methods(); track m.code) {
            <button type="button" [class]="'a-btn ' + (method() === m.code ? 'primary' : 'ghost')" (click)="method.set(m.code)" [attr.aria-pressed]="method() === m.code">{{ m.name }}</button>
          }
        </div>
        @if (method() === 'cash') {
          <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end;margin-top:10px">
            <div><label class="a-form-label" for="w-recv">Montant reçu (facultatif)</label><input id="w-recv" name="recv" class="a-input" type="number" inputmode="numeric" min="0" [(ngModel)]="received" style="max-width:180px" /></div>
            @if (received && received >= estimate().total) { <div style="font-size:14px;font-weight:700;color:var(--a-green);padding-bottom:8px">À rendre : {{ received - estimate().total | ariary }}</div> }
          </div>
        } @else {
          <div style="margin-top:10px;max-width:260px"><label class="a-form-label" for="w-payer">Numéro mobile à débiter</label>
            <input id="w-payer" name="payer" class="a-input" type="tel" inputmode="tel" [(ngModel)]="payerPhone" [placeholder]="contact.phone" /></div>
          <div style="font-size:11px;color:var(--a-tx3);margin-top:4px">Le client valide la demande sur son téléphone ; le billet est émis dès la confirmation de l'opérateur.</div>
        }
      </fieldset>

      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;border-top:1px solid var(--a-border);padding-top:14px">
        <div><div style="font-size:11px;color:var(--a-tx3)">Total à encaisser (estimation — le serveur calcule le montant exact)</div><div style="font-size:24px;font-weight:800;color:var(--a-cyan)">{{ estimate().total | ariary }}</div></div>
        <button type="submit" class="a-btn primary" style="font-size:14px;padding:12px 22px" [disabled]="busy()">{{ busy() ? 'Enregistrement…' : (method() === 'cash' ? 'Encaisser et émettre le billet' : 'Lancer le paiement') }}</button>
      </div>
      @if (formError()) { <div role="alert" style="color:var(--a-red);font-size:13px">{{ formError() }}</div> }
    </form>
  }

  <!-- 4. Résultat -->
  @if (step() === 4 && sold(); as b) {
    <div class="a-card" style="text-align:center;max-width:520px;margin:0 auto">
      @if (b.status === 'confirmed') {
        <div style="font-size:40px" aria-hidden="true">✅</div>
        <div style="font-size:18px;font-weight:800;margin-top:6px">Billet émis</div>
      } @else if (b.status === 'pending_payment') {
        <div style="font-size:40px" aria-hidden="true">⏳</div>
        <div style="font-size:18px;font-weight:800;margin-top:6px">En attente du paiement mobile</div>
        <div style="font-size:12px;color:var(--a-tx3)">Demandez au client de valider sur son téléphone. Cette page se met à jour toute seule.</div>
      } @else {
        <div style="font-size:40px" aria-hidden="true">❌</div>
        <div style="font-size:18px;font-weight:800;margin-top:6px">Paiement non abouti</div>
        <div style="font-size:12px;color:var(--a-tx3)">La réservation a été annulée et les sièges remis en vente.</div>
      }
      <div class="a-mono" style="font-size:22px;font-weight:700;color:var(--a-cyan);margin:14px 0;letter-spacing:1px">{{ b.reference }}</div>
      <div style="font-size:13px">{{ b.trip.fromCity }} → {{ b.trip.toCity }} · {{ b.trip.serviceDate | adminDate }} · {{ cfg.time(b.trip.departure) }}</div>
      <div style="font-size:13px;margin-top:4px">Sièges {{ b.seats.join(', ') }} · <strong>{{ b.total | ariary }}</strong></div>
      <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-top:18px">
        @if (b.status === 'confirmed') { <button class="a-btn primary" (click)="printTicket(b)" [disabled]="busy()">Imprimer le billet (PDF)</button> }
        <button class="a-btn ghost" (click)="reset()">Nouvelle vente</button>
      </div>
    </div>
  }
</div>`,
})
export class WalkinComponent implements OnInit, OnDestroy {
  private live = inject(AdminLiveService);
  private data = inject(AdminDataService);
  private toast = inject(AdminToastService);
  private realtime = inject(RealtimeService);
  private route = inject(ActivatedRoute);
  readonly cfg = inject(AppConfigService);

  readonly steps = [{ n: 1, label: 'Départ' }, { n: 2, label: 'Sièges' }, { n: 3, label: 'Client et paiement' }, { n: 4, label: 'Billet' }];
  readonly step = signal<Step>(1);
  readonly date = signal(this.cfg.today());
  readonly filter = signal('');
  readonly trips = signal<LiveTrip[]>([]);
  readonly trip = signal<LiveTrip | null>(null);
  readonly manifest = signal<Manifest | null>(null);
  readonly seats = signal<string[]>([]);
  readonly hold = signal<HoldInfo | null>(null);
  readonly pax = signal<Pax[]>([]);
  readonly method = signal('cash');
  readonly known = signal<AdminClientUser | null>(null);
  readonly sold = signal<ApiBooking | null>(null);
  readonly loading = signal(false);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly formError = signal<string | null>(null);
  readonly now = signal(Date.now());
  contact = { phone: '', firstName: '', lastName: '', email: '' };
  sameName = true; received: number | null = null; payerPhone = '';
  private saleKey = newKey();
  private offs: Array<() => void> = [];
  private clock: ReturnType<typeof setInterval> | null = null;
  private lookupTimer: ReturnType<typeof setTimeout> | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;

  readonly days = [0, 1, 2, 3, 4, 5, 6].map(n => { const d = this.cfg.today(n); return { date: d, label: n === 0 ? "Aujourd'hui" : n === 1 ? 'Demain' : this.cfg.date(d).slice(0, 5) }; });
  readonly sellable = computed(() => {
    const f = this.filter().trim().toLowerCase(), now = Date.now();
    return this.trips().filter(t => t.status === 'scheduled' && t.routeStatus === 'active' && new Date(t.departureAt).getTime() > now)
      .filter(t => !f || t.fromCity.toLowerCase().includes(f) || t.toCity.toLowerCase().includes(f));
  });
  readonly booked = computed(() => (this.manifest()?.seats ?? []).filter(s => s.status === 'booked').map(s => s.seat));
  readonly heldByOthers = computed(() => (this.manifest()?.seats ?? []).filter(s => s.status === 'held' && !this.seats().includes(s.seat)).map(s => s.seat));
  readonly methods = computed(() => [{ code: 'cash', name: 'Espèces' }, ...this.cfg.onlinePayments().map(p => ({ code: p.code, name: p.name }))]);
  readonly estimate = computed(() => {
    const t = this.trip(), c = this.cfg.booking().child;
    if (!t) return { subtotal: 0, fee: 0, total: 0 };
    const children = c.enabled ? this.pax().filter(p => p.category === 'child').length : 0;
    const base = this.cfg.estimate(t.price, this.seats().length);
    const discount = Math.round(children * t.price * c.discountPercent / 100);
    return { subtotal: base.subtotal - discount, fee: base.fee, total: base.total - discount };
  });
  readonly remaining = computed(() => {
    const h = this.hold(); if (!h) return '';
    const s = Math.max(0, Math.floor((new Date(h.expiresAt).getTime() - this.now()) / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  });

  async ngOnInit(): Promise<void> {
    const q = this.route.snapshot.queryParamMap;
    if (q.get('date')) this.date.set(q.get('date')!);
    await this.loadTrips();
    const wanted = q.get('trip') && this.trips().find(t => t.id === q.get('trip'));
    if (wanted) void this.chooseTrip(wanted);
    this.clock = setInterval(() => { this.now.set(Date.now()); this.checkHold(); }, 1000);
    const onSeat = (p: any) => { if (p?.tripId === this.trip()?.id) void this.refreshSeats(); };
    this.offs = ['seat.held', 'seat.released', 'seat.booked', 'trip.vehicle_changed', 'trip.cancelled'].map(ev => this.realtime.on(ev, onSeat));
    this.offs.push(this.realtime.onReconnect(() => { void this.refreshSeats(); }));
    window.addEventListener('pagehide', this.onLeave);
  }
  ngOnDestroy(): void {
    this.offs.forEach(off => off());
    if (this.clock) clearInterval(this.clock);
    if (this.poll) clearInterval(this.poll);
    window.removeEventListener('pagehide', this.onLeave);
    this.onLeave();
  }
  /** Abandon de la saisie : les sièges retenus sont rendus tout de suite. */
  private onLeave = (): void => {
    const h = this.hold(), t = this.trip();
    if (t) this.realtime.leaveTrip(t.id);
    if (h && this.step() < 4) { void this.live.release(h.tripId, h.token); this.hold.set(null); }
  };
  private checkHold(): void {
    const h = this.hold();
    if (h && new Date(h.expiresAt).getTime() <= Date.now() && this.step() < 4) {
      this.hold.set(null); this.seats.set([]); this.pax.set([]);
      this.toast.warn('Délai dépassé : les sièges ont été remis en vente'); this.step.set(2); void this.refreshSeats();
    }
  }

  setDate(d: string): void { if (!d) return; this.date.set(d); void this.loadTrips(); }
  async loadTrips(): Promise<void> {
    this.loading.set(true);
    try { this.trips.set((await this.live.trips(this.date(), this.date())).sort((a, b) => a.departureAt.localeCompare(b.departureAt))); this.error.set(null); }
    catch (e) { this.error.set(errorMessage(e, 'Chargement impossible')); }
    finally { this.loading.set(false); }
  }
  async chooseTrip(t: LiveTrip): Promise<void> {
    this.trip.set(t); this.seats.set([]); this.pax.set([]); this.hold.set(null); this.manifest.set(null); this.step.set(2);
    this.realtime.joinTrip(t.id);
    await this.refreshSeats();
  }
  private async refreshSeats(): Promise<void> {
    const t = this.trip(); if (!t || this.step() === 4) return;
    try { this.manifest.set(await this.live.manifest(t.id)); } catch (e) { this.toast.error(errorMessage(e)); }
  }
  back(): void { this.onLeave(); this.trip.set(null); this.seats.set([]); this.step.set(1); void this.loadTrips(); }

  /** Chaque clic met à jour le verrou sur le serveur (tout ou rien) : un siège pris entre-temps est refusé immédiatement. */
  async toggleSeat(seat: string): Promise<void> {
    const t = this.trip(); if (!t || this.busy()) return;
    const max = this.cfg.booking().maxPassengers;
    const next = this.seats().includes(seat) ? this.seats().filter(s => s !== seat) : [...this.seats(), seat];
    if (next.length > max) { this.toast.warn(`${max} passagers au maximum par réservation`); return; }
    this.busy.set(true);
    try {
      if (!next.length) { const h = this.hold(); if (h) await this.live.release(t.id, h.token); this.hold.set(null); }
      else this.hold.set(await this.live.hold(t.id, next, this.hold()?.token));
      this.seats.set(next);
    } catch (e) {
      this.toast.error(e instanceof ApiError && e.code === 'SEAT_TAKEN' ? `Le siège ${seat} vient d'être pris` : errorMessage(e));
      await this.refreshSeats();
    } finally { this.busy.set(false); }
  }
  toPassengers(): void {
    const old = new Map(this.pax().map(p => [p.seatNo, p]));
    this.pax.set(this.seats().map(s => old.get(s) ?? { seatNo: s, firstName: this.contact.firstName, lastName: this.contact.lastName, category: 'adult' as const }));
    this.saleKey = newKey(); this.formError.set(null); this.step.set(3);
  }
  syncNames(): void { if (this.sameName) this.pax.update(l => l.map(p => ({ ...p, firstName: this.contact.firstName, lastName: this.contact.lastName }))); }
  lookup(phone: string): void {
    if (this.lookupTimer) clearTimeout(this.lookupTimer);
    this.known.set(null);
    if (phone.replace(/\D/g, '').length < 8) return;
    this.lookupTimer = setTimeout(async () => {
      const c = await this.data.findClient(phone.replace(/[\s\-().]/g, ''));
      if (!c || this.contact.phone !== phone) return;
      this.known.set(c);
      if (!this.contact.firstName) this.contact.firstName = c.firstName;
      if (!this.contact.lastName) this.contact.lastName = c.lastName;
      if (!this.contact.email && c.email) this.contact.email = c.email;
      this.syncNames();
    }, 450);
  }

  async confirm(): Promise<void> {
    const t = this.trip(); if (!t || this.busy()) return;
    this.syncNames();
    const c = this.contact;
    if (!c.firstName.trim() || !c.lastName.trim()) { this.formError.set('Prénom et nom du client obligatoires'); return; }
    if (!this.cfg.phoneValid(c.phone)) { this.formError.set('Numéro de téléphone invalide'); return; }
    if (this.pax().some(p => !p.firstName.trim() || !p.lastName.trim())) { this.formError.set('Indiquez le nom de chaque passager'); return; }
    this.busy.set(true); this.formError.set(null);
    try {
      // la même clé est renvoyée en cas de double clic ou de coupure réseau : une seule vente est enregistrée
      const r = await this.live.walkin({
        tripId: t.id, holdToken: this.hold()?.token,
        passengers: this.pax().map(p => ({ seatNo: p.seatNo, firstName: p.firstName.trim(), lastName: p.lastName.trim(), category: p.category })),
        contact: { name: `${c.firstName.trim()} ${c.lastName.trim()}`, phone: c.phone.replace(/[\s\-().]/g, ''), email: c.email.trim() || undefined },
        paymentMethod: this.method(), payerPhone: this.method() === 'cash' ? undefined : (this.payerPhone || c.phone).replace(/[\s\-().]/g, ''),
        amountReceived: this.method() === 'cash' && this.received ? Math.round(this.received) : undefined, createAccount: !this.known(),
      }, this.saleKey);
      this.sold.set(r.booking); this.hold.set(null); this.step.set(4);
      if (r.booking.status === 'pending_payment') this.watch(r.booking.id);
    } catch (e) {
      this.formError.set(e instanceof ApiError && (e.code === 'SEAT_TAKEN' || e.code === 'HOLD_EXPIRED') ? 'Un siège n\'est plus disponible : reprenez la sélection.' : errorMessage(e));
      if (e instanceof ApiError && (e.code === 'SEAT_TAKEN' || e.code === 'HOLD_EXPIRED')) { this.hold.set(null); this.seats.set([]); this.step.set(2); await this.refreshSeats(); }
    } finally { this.busy.set(false); }
  }
  /** Paiement mobile au guichet : on relit la réservation jusqu'à la confirmation ou l'échec. */
  private watch(id: string): void {
    if (this.poll) clearInterval(this.poll);
    let tries = 0;
    this.poll = setInterval(async () => {
      tries++;
      try { const b = await this.live.booking(id); this.sold.set(b); if (b.status !== 'pending_payment' || tries > 120) { clearInterval(this.poll!); this.poll = null; } } catch { /* prochain essai */ }
    }, 3000);
  }
  async printTicket(b: ApiBooking): Promise<void> {
    this.busy.set(true);
    try { await this.live.ticketPdf(b.reference); } catch (e) { this.toast.error(errorMessage(e)); } finally { this.busy.set(false); }
  }
  reset(): void {
    if (this.poll) { clearInterval(this.poll); this.poll = null; }
    const t = this.trip(); if (t) this.realtime.leaveTrip(t.id);
    this.contact = { phone: '', firstName: '', lastName: '', email: '' }; this.sameName = true; this.received = null; this.payerPhone = '';
    this.trip.set(null); this.seats.set([]); this.pax.set([]); this.hold.set(null); this.sold.set(null); this.known.set(null); this.method.set('cash'); this.step.set(1);
    void this.loadTrips();
  }
}
