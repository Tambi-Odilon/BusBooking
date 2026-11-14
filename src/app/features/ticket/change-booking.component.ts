import { Component, EventEmitter, Input, OnInit, Output, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, errorMessage } from '../../core/api/api.service';
import { AppConfigService } from '../../core/config/app-config.service';
import { I18nService } from '../../core/services/i18n.service';
import { ApiBooking, SeatRowDef, SeatState } from '../../core/models/booking.models';

interface Slot { tripId: string; departure: string; arrival: string; busName: string; price: number; seatsAvailable: number }

/**
 * Modification d'une réservation confirmée : changer de siège sur le même départ, ou passer sur un autre départ du même itinéraire.
 * Utilisé par le voyageur (« Retrouver mon billet ») et par le back-office (Réservations). Le serveur revérifie tout :
 * délai, disponibilité des sièges (un seul gagnant), écart de prix.
 */
@Component({
  selector: 'app-change-booking',
  standalone: true,
  imports: [FormsModule],
  template: `
  <section class="cb" aria-labelledby="cb-title">
    <h2 id="cb-title" class="cb-title">{{ x().changeTitle }}</h2>

    <div class="cb-tabs" role="group" [attr.aria-label]="x().changeTitle">
      <button type="button" [class.on]="!otherTrip()" [attr.aria-pressed]="!otherTrip()" (click)="useCurrent()">{{ x().changeSameTrip }}</button>
      <button type="button" [class.on]="otherTrip()" [attr.aria-pressed]="otherTrip()" (click)="otherTrip.set(true); search()">{{ x().changeOtherTrip }}</button>
    </div>

    @if (otherTrip()) {
      <label class="cb-label" for="cb-date">{{ x().changeDate }}</label>
      <input id="cb-date" class="cb-input" type="date" [min]="today" [(ngModel)]="date" (change)="search()" />
      @if (searching()) { <p class="cb-muted">{{ x().loading }}</p> }
      @else if (!slots().length) { <p class="cb-muted" role="status">{{ x().changeNoTrips }}</p> }
      @else {
        <ul class="cb-slots">
          @for (s of slots(); track s.tripId) {
            <li>
              <button type="button" [class.on]="tripId() === s.tripId" [attr.aria-pressed]="tripId() === s.tripId" (click)="pickTrip(s)">
                <strong>{{ cfg.time(s.departure) }} → {{ cfg.time(s.arrival) }}</strong>
                <span>{{ s.busName }} · {{ cfg.money(s.price) }} · {{ s.seatsAvailable }} {{ x().changeSeatsLeft }}</span>
              </button>
            </li>
          }
        </ul>
      }
    }

    @if (rows().length) {
      <p class="cb-label">{{ x().changePick }} <strong>{{ currentName() }}</strong></p>
      <div class="cb-pax">
        @for (p of pax(); track p.id; let i = $index) {
          <button type="button" [class.on]="current() === i" [attr.aria-pressed]="current() === i" (click)="current.set(i)">
            {{ p.firstName }} : <b>{{ chosen()[p.id] || '—' }}</b>
          </button>
        }
      </div>
      <div class="cb-map" role="group" [attr.aria-label]="x().changePick">
        @for (r of rows(); track r.rowId) {
          <div class="cb-row">
            @for (s of r.seats; track s; let j = $index) {
              <button type="button" class="cb-seat" [class.taken]="isTaken(s)" [class.sel]="isChosen(s)" [disabled]="isTaken(s)"
                      [attr.aria-label]="s + (isTaken(s) ? ' — ' + x().changeTaken : '')" [attr.aria-pressed]="isChosen(s)" (click)="pickSeat(s)">{{ s }}</button>
              @if (r.aisleAfter && j + 1 === r.aisleAfter) { <span class="cb-aisle" aria-hidden="true"></span> }
            }
          </div>
        }
      </div>
    }

    @if (staff && priceUp()) {
      <label class="cb-check"><input type="checkbox" [(ngModel)]="collect" /> {{ x().changeCollect }} ({{ cfg.money(priceDiff()) }})</label>
    } @else if (priceUp()) {
      <p class="cb-warn" role="status">{{ x().changePriceUp }}</p>
    } @else if (priceDiff() < 0) {
      <p class="cb-muted" role="status">{{ x().changePriceDown }} {{ cfg.money(-priceDiff()) }}</p>
    }
    @if (error()) { <p class="cb-err" role="alert">{{ error() }}</p> }

    <div class="cb-actions">
      <button type="button" class="cb-btn ghost" (click)="closed.emit()">{{ x().changeBack }}</button>
      <button type="button" class="cb-btn" [disabled]="busy() || !ready()" (click)="submit()">{{ busy() ? x().loading : x().changeConfirm }}</button>
    </div>
  </section>`,
  styles: [`
    .cb { display: grid; gap: 12px; text-align: left; }
    .cb-title { font-size: 17px; font-weight: 700; margin: 0; }
    .cb-tabs, .cb-pax { display: flex; flex-wrap: wrap; gap: 8px; }
    .cb-tabs button, .cb-pax button, .cb-slots button { min-height: 44px; padding: 8px 12px; border-radius: 10px; border: 1px solid rgba(100,116,139,.4); background: transparent; color: inherit; font: inherit; font-size: 14px; cursor: pointer; }
    .cb-tabs button.on, .cb-pax button.on, .cb-slots button.on { border-color: var(--brand, #1d4ed8); box-shadow: inset 0 0 0 1px var(--brand, #1d4ed8); font-weight: 600; }
    .cb-label { font-size: 14px; font-weight: 600; margin: 4px 0 0; }
    .cb-input { height: 44px; padding: 0 12px; border-radius: 10px; border: 1px solid rgba(100,116,139,.4); background: transparent; color: inherit; font: inherit; max-width: 220px; }
    .cb-slots { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
    .cb-slots button { width: 100%; display: flex; flex-direction: column; align-items: flex-start; gap: 2px; text-align: left; }
    .cb-slots span, .cb-muted { font-size: 13px; opacity: .75; margin: 0; }
    .cb-map { display: grid; gap: 6px; justify-content: center; padding: 12px; border-radius: 12px; border: 1px solid rgba(100,116,139,.3); overflow-x: auto; }
    .cb-row { display: flex; gap: 6px; justify-content: center; }
    .cb-aisle { width: 18px; }
    .cb-seat { width: 44px; height: 44px; border-radius: 8px; border: 2px solid rgba(100,116,139,.45); background: transparent; color: inherit; font: 600 12px/1 inherit; cursor: pointer; }
    .cb-seat.taken { opacity: .35; cursor: not-allowed; text-decoration: line-through; }
    .cb-seat.sel { background: var(--brand, #1d4ed8); border-color: var(--brand, #1d4ed8); color: #fff; }
    .cb-check { font-size: 14px; display: flex; gap: 8px; align-items: center; }
    .cb-warn { font-size: 13px; color: #b45309; margin: 0; }
    .cb-err { font-size: 13px; color: #dc2626; margin: 0; }
    .cb-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
    .cb-btn { min-height: 44px; padding: 0 18px; border-radius: 10px; border: 1px solid var(--brand, #1d4ed8); background: var(--brand, #1d4ed8); color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
    .cb-btn.ghost { background: transparent; color: inherit; border-color: rgba(100,116,139,.4); }
    .cb-btn:disabled { opacity: .5; cursor: not-allowed; }
    button:focus-visible, input:focus-visible { outline: 2px solid var(--brand, #1d4ed8); outline-offset: 2px; }
  `],
})
export class ChangeBookingComponent implements OnInit {
  private api = inject(ApiService);
  readonly cfg = inject(AppConfigService);
  private i18n = inject(I18nService);
  readonly x = computed(() => this.i18n.t().x);

  @Input({ required: true }) booking!: ApiBooking;
  /** true dans le back-office : pas de limite de délai, complément encaissable en espèces. */
  @Input() staff = false;
  @Output() changed = new EventEmitter<ApiBooking>();
  @Output() closed = new EventEmitter<void>();

  readonly today = new Date().toISOString().slice(0, 10);
  date = '';
  collect = true;
  readonly otherTrip = signal(false);
  readonly searching = signal(false);
  readonly slots = signal<Slot[]>([]);
  readonly tripId = signal('');
  readonly tripPrice = signal(0);
  readonly rows = signal<SeatRowDef[]>([]);
  readonly states = signal<SeatState[]>([]);
  readonly chosen = signal<Record<string, string>>({});
  readonly current = signal(0);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);

  readonly pax = computed(() => this.booking.passengers.filter(p => p.status === 'active'));
  readonly currentName = computed(() => { const p = this.pax()[this.current()]; return p ? `${p.firstName} ${p.lastName}` : ''; });
  private readonly sameTrip = computed(() => this.tripId() === this.booking.trip.tripId);
  /** Écart de prix estimé (le serveur calcule le montant exact, tarif enfant compris). */
  readonly priceDiff = computed(() => this.sameTrip() ? 0 : (this.tripPrice() - this.booking.trip.price) * this.pax().length);
  readonly priceUp = computed(() => this.priceDiff() > 0);
  readonly ready = computed(() => {
    const c = this.chosen(), p = this.pax();
    if (!this.tripId() || p.some(x => !c[x.id])) return false;
    return !this.sameTrip() || p.some(x => c[x.id] !== x.seatNo);
  });

  ngOnInit(): void { this.date = this.booking.trip.serviceDate; void this.useCurrent(); }

  async useCurrent(): Promise<void> {
    this.otherTrip.set(false);
    this.tripPrice.set(this.booking.trip.price);
    await this.loadSeats(this.booking.trip.tripId, Object.fromEntries(this.pax().map(p => [p.id, p.seatNo])));
  }
  async search(): Promise<void> {
    this.searching.set(true); this.error.set(null); this.rows.set([]); this.tripId.set('');
    try {
      const r = await this.api.get<any>('/search', { query: { from: this.booking.trip.fromCity, to: this.booking.trip.toCity, date: this.date, passengers: this.pax().length }, scope: 'none' });
      this.slots.set(r.status === 'available' ? (r.slots as any[]).filter(s => s.tripId !== this.booking.trip.tripId).map(s => ({ tripId: s.tripId, departure: s.departure, arrival: s.arrival, busName: s.busName ?? s.vehicleName ?? '', price: s.price, seatsAvailable: s.seatsAvailable })) : []);
    } catch (e) { this.slots.set([]); this.error.set(errorMessage(e)); }
    finally { this.searching.set(false); }
  }
  pickTrip(s: Slot): void { this.tripPrice.set(s.price); void this.loadSeats(s.tripId, {}); }

  private async loadSeats(tripId: string, initial: Record<string, string>): Promise<void> {
    this.error.set(null);
    try {
      const r = await this.api.get<any>(`/trips/${tripId}/seats`, { scope: 'none' });
      this.tripId.set(tripId); this.rows.set(r.layout.rows); this.states.set(r.seats); this.chosen.set(initial); this.current.set(0);
    } catch (e) { this.error.set(errorMessage(e)); }
  }
  /** Occupé par quelqu'un d'autre (les sièges actuels de cette réservation restent sélectionnables). */
  isTaken(seat: string): boolean {
    if (!this.states().some(s => s.seat === seat)) return false;
    return !(this.sameTrip() && this.booking.passengers.some(p => p.status === 'active' && p.seatNo === seat));
  }
  isChosen(seat: string): boolean { return Object.values(this.chosen()).includes(seat); }
  pickSeat(seat: string): void {
    const p = this.pax()[this.current()]; if (!p || this.isTaken(seat)) return;
    const c = { ...this.chosen() };
    // si un autre passager de la réservation avait ce siège, on échange
    const other = Object.keys(c).find(id => c[id] === seat && id !== p.id);
    if (other) { if (c[p.id]) c[other] = c[p.id]; else delete c[other]; }
    c[p.id] = seat; this.chosen.set(c);
    const next = this.pax().findIndex(q => !c[q.id]);
    if (next >= 0) this.current.set(next); else if (this.current() < this.pax().length - 1) this.current.set(this.current() + 1);
  }

  async submit(): Promise<void> {
    this.busy.set(true); this.error.set(null);
    const b = this.booking;
    const body: any = { seats: this.pax().map(p => ({ passengerId: p.id, seatNo: this.chosen()[p.id] })) };
    if (!this.sameTrip()) body.tripId = this.tripId();
    try {
      let fresh: ApiBooking;
      if (this.staff) { if (this.priceUp() && this.collect) body.collectDifference = true; fresh = await this.api.post<ApiBooking>(`/admin/bookings/${b.id}/change`, body, { scope: 'staff' }); }
      else fresh = await this.api.post<ApiBooking>(`/bookings/${b.reference}/change`, body, { headers: b.accessToken ? { 'x-booking-token': b.accessToken } : {}, scope: 'customer' });
      this.changed.emit(fresh);
    } catch (e) {
      this.error.set(errorMessage(e));
      await this.loadSeats(this.tripId(), this.chosen()).catch(() => {});   // l'état des sièges a pu changer : on le relit
    } finally { this.busy.set(false); }
  }
}
