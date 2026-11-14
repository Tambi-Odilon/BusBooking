import { Component, Input, Output, EventEmitter, OnChanges, SimpleChanges, ChangeDetectionStrategy } from '@angular/core';
import { SeatRowDef } from '../../core/models/booking.models';
import { CommonModule } from '@angular/common';

/* ── Stat Card ── */
@Component({
  selector: 'adm-stat',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="a-stat a-fade" [ngClass]="color">
      <div class="a-stat-label">{{ label }}</div>
      <div class="a-stat-val" [class.sm]="small">{{ value }}</div>
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
        <span *ngIf="sub" style="font-size:11px;color:var(--a-tx2)">{{ sub }}</span>
        <span *ngIf="growth !== null && growth !== undefined"
              [class]="'a-mono' + (growth >= 0 ? ' badge-up' : ' badge-dn')"
              style="font-size:10px;font-weight:700;padding:1px 6px;border-radius:5px">
          {{ growth >= 0 ? '+' : '' }}{{ growth }}%
        </span>
      </div>
    </div>`,
  styles: [`
    .badge-up{background:rgba(16,185,129,.12);color:var(--a-green)}
    .badge-dn{background:rgba(239,68,68,.12);color:var(--a-red)}
  `],
  imports: [CommonModule],
})
export class StatCardComponent {
  @Input() label = '';
  @Input() value: string | number = '';
  @Input() sub = '';
  @Input() color = 'a-cyan';
  @Input() small = false;
  @Input() growth: number | null = null;
}

/* ── Bar Chart ── */
@Component({
  selector: 'adm-bar-chart',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
<div style="position:relative;width:100%;user-select:none">

  <!-- Lignes de grille horizontales + labels axe Y -->
  <div style="position:relative;height:180px;display:flex;align-items:flex-end;gap:0">

    <!-- Axe Y (labels) -->
    <div style="display:flex;flex-direction:column;justify-content:space-between;height:100%;padding:0 6px 0 0;min-width:36px;align-items:flex-end;flex-shrink:0">
      <span style="font-size:8px;color:var(--a-tx3);font-family:'IBM Plex Mono',monospace">{{ yLabels[3] }}</span>
      <span style="font-size:8px;color:var(--a-tx3);font-family:'IBM Plex Mono',monospace">{{ yLabels[2] }}</span>
      <span style="font-size:8px;color:var(--a-tx3);font-family:'IBM Plex Mono',monospace">{{ yLabels[1] }}</span>
      <span style="font-size:8px;color:var(--a-tx3);font-family:'IBM Plex Mono',monospace">{{ yLabels[0] }}</span>
    </div>

    <!-- Zone barres + grille -->
    <div style="flex:1;position:relative;height:100%">
      <!-- Grille horizontale -->
      <div style="position:absolute;inset:0;display:flex;flex-direction:column;justify-content:space-between;pointer-events:none">
        <div style="border-top:1px dashed var(--a-border);width:100%"></div>
        <div style="border-top:1px dashed var(--a-border);width:100%"></div>
        <div style="border-top:1px dashed var(--a-border);width:100%"></div>
        <div style="border-top:1px solid var(--a-border2);width:100%"></div>
      </div>

      <!-- Barres -->
      <div style="display:flex;align-items:flex-end;gap:2px;height:100%;position:relative;z-index:1;padding:0 2px">
        @for (b of bars; track b.label; let i = $index) {
          <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%;gap:2px;position:relative"
               (mouseenter)="hoveredIdx = i" (mouseleave)="hoveredIdx = -1">
            <!-- Valeur au survol -->
            @if (hoveredIdx === i) {
              <div style="position:absolute;bottom:104%;left:50%;transform:translateX(-50%);
                          background:var(--a-bg4);border:1px solid var(--a-border2);border-radius:6px;
                          padding:4px 8px;font-size:10px;color:var(--a-tx1);white-space:nowrap;z-index:20;
                          font-family:'IBM Plex Mono',monospace;box-shadow:0 4px 12px rgba(0,0,0,.3)">
                {{ b.tip }}
              </div>
            }
            <!-- Barre -->
            <div [style.height]="b.pct + '%'"
                 [style.background]="hoveredIdx === i
                   ? color
                   : 'linear-gradient(180deg,' + color + 'dd,' + color + '55)'"
                 [style.border-top]="'2px solid ' + color"
                 [style.min-height]="'4px'"
                 [style.width]="'100%'"
                 [style.border-radius]="'3px 3px 0 0'"
                 style="transition:all .15s ease;cursor:default">
            </div>
          </div>
        }
      </div>
    </div>
  </div>

  <!-- Axe X (dates) -->
  <div style="display:flex;margin-left:42px;gap:2px;padding:0 2px;margin-top:4px">
    @for (b of bars; track b.label; let i = $index) {
      <div style="flex:1;text-align:center;font-size:7.5px;color:var(--a-tx3);font-family:'IBM Plex Mono',monospace;
                  overflow:hidden;white-space:nowrap;line-height:1.2"
           [style.color]="hoveredIdx === i ? color : 'var(--a-tx3)'"
           [style.font-weight]="hoveredIdx === i ? '700' : '400'">
        {{ b.label }}
      </div>
    }
  </div>

  <!-- Courbe de tendance (SVG overlay) -->
  @if (trend.length > 1) {
    <div style="position:absolute;top:0;left:42px;right:0;height:180px;pointer-events:none;z-index:2">
      <svg width="100%" height="100%" preserveAspectRatio="none">
        <polyline [attr.points]="trend"
                  fill="none"
                  [attr.stroke]="color"
                  stroke-width="1.5"
                  stroke-dasharray="4 3"
                  opacity="0.4" />
      </svg>
    </div>
  }
</div>`,
  imports: [CommonModule],
})
export class BarChartComponent implements OnChanges {
  @Input() data: { v: number; label: string; tip: string }[] = [];
  @Input() color = 'var(--a-cyan)';

  bars: { pct: number; label: string; tip: string }[] = [];
  yLabels: string[] = ['0', '', '', ''];
  trend   = '';
  hoveredIdx = -1;

  ngOnChanges(): void {
    const max = Math.max(...this.data.map(d => d.v), 1);
    this.bars = this.data.map(d => ({
      pct:   Math.max(3, Math.round(d.v / max * 100)),
      label: d.label.slice(-5),   // ex: "03/14"
      tip:   d.tip,
    }));

    // Labels axe Y
    const fmt = (v: number) => v >= 1000000 ? (v/1000000).toFixed(1)+'M'
                              : v >= 1000    ? (v/1000).toFixed(0)+'k'
                              : String(Math.round(v));
    this.yLabels = ['0', fmt(max*0.33), fmt(max*0.67), fmt(max)];

    // Courbe de tendance (points SVG en %)
    if (this.bars.length > 1) {
      const pts = this.bars.map((b, i) => {
        const x = (i / (this.bars.length - 1)) * 100;
        const y = 100 - b.pct;
        return `${x},${y}`;
      });
      this.trend = pts.join(' ');
    }
  }
}

/* ── Badge ── */
@Component({
  selector: 'adm-badge',
  standalone: true,
  template: `<span [class]="'a-badge ' + status">{{ displayLabel }}</span>`,
})
export class BadgeComponent {
  @Input() status = '';
  @Input() label = '';
  get displayLabel(): string {
    if (this.label) return this.label;
    const map: Record<string, string> = {
      confirmed: 'Confirmé', completed: 'Terminé', cancelled: 'Annulé', pending: 'Attente',
      paid: 'Payé', refunded: 'Remboursé', failed: 'Échoué',
      active: 'En service', maintenance: 'Maintenance', retired: 'Retraité',
      suspended: 'Suspendu', banned: 'Banni',
      mvola: 'MVola', orangemoney: 'Orange Money', airtelmoney: 'Airtel Money', cash: 'Espèces',
    };
    return map[this.status] ?? this.status;
  }
}

/* ── Progress bar ── */
@Component({
  selector: 'adm-progress',
  standalone: true,
  template: `
    <div class="a-progress-wrap">
      <div class="a-progress-bar"
           [style.width.%]="value"
           [style.background]="color || (value > 80 ? 'var(--a-red)' : value > 50 ? 'var(--a-amber)' : 'var(--a-green)')">
      </div>
    </div>`,
})
export class ProgressComponent {
  @Input() value = 0;
  @Input() color = '';
}

/* ── Seat map ─────────────────────────────────────────────────────────────────
   Layouts identiques à la page de réservation client :
   BUS 48      : rangée conducteur (pas de siège) + 12 rangées × 4 (2|couloir|2)
   MINIBUS 16  : conducteur à gauche + F1,F2 réservables à droite
                 puis A(1,2|3,4)  B(1|2,3)  C(1|2,3)  D(1,2|3,4)
   VIP 10      : conducteur à gauche + F1 réservable à droite
                 puis A,B,C : (s1,s2 | couloir | s3)
   ── */
@Component({
  selector: 'adm-seat-map',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
<div style="display:flex;flex-direction:column;align-items:center;gap:3px;font-family:ui-monospace,monospace" role="group" aria-label="Plan des sièges">
  <div style="width:100%;border-radius:10px 10px 0 0;text-align:center;padding:4px 0;font-size:9px;background:var(--a-bg3);color:var(--a-tx3)">▲ AVANT</div>
  @for (row of effectiveRows; track row.rowId) {
    @if (row.isDriverRow) {
      <div style="display:flex;align-items:center;gap:4px;width:100%;padding:4px 5px;background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.2);border-radius:6px;margin-bottom:2px">
        <div style="border-radius:5px;background:rgba(245,158,11,.2);border:1px solid rgba(245,158,11,.4);display:flex;align-items:center;justify-content:center;font-size:12px;flex-shrink:0"
             [style.width.px]="size" [style.height.px]="size" aria-hidden="true">🚗</div>
        <span style="font-size:8px;color:var(--a-tx3);flex:1;text-align:center">Conducteur</span>
        <div style="display:flex;gap:3px">
          @for (s of row.seats; track s) {
            <button type="button" [class]="'a-seat ' + st(s)" [title]="title(s)" [attr.aria-label]="title(s)" [disabled]="!clickable(s)" (click)="pick(s)"
                    [style.width.px]="size" [style.height.px]="size" [style.fontSize.px]="size > 30 ? 11 : 8">{{ s }}</button>
          }
        </div>
      </div>
    } @else {
      <div style="display:flex;align-items:center;gap:3px">
        <span style="width:12px;font-size:7px;color:var(--a-tx3);text-align:right">{{ row.rowId }}</span>
        @for (s of row.seats; track s; let i = $index) {
          @if (row.aisleAfter && i === row.aisleAfter) { <div style="width:8px;border-left:1px dashed var(--a-border)" [style.height.px]="size"></div> }
          <button type="button" [class]="'a-seat ' + st(s)" [title]="title(s)" [attr.aria-label]="title(s)" [disabled]="!clickable(s)" (click)="pick(s)"
                  [style.width.px]="size" [style.height.px]="size" [style.fontSize.px]="size > 30 ? 11 : 8">{{ s }}</button>
        }
        @for (pad of padding(row); track pad) { <div [style.width.px]="size"></div> }
      </div>
    }
  }
  <div style="width:100%;border-radius:0 0 10px 10px;text-align:center;padding:4px 0;font-size:9px;background:var(--a-bg3);color:var(--a-tx3)">▼ ARRIÈRE</div>
  <div style="display:flex;gap:8px;margin-top:4px;flex-wrap:wrap;justify-content:center">
    @for (l of legend; track l.cls) {
      <div style="display:flex;align-items:center;gap:3px">
        <div [class]="'a-seat ' + l.cls" style="width:14px;height:14px;font-size:0;pointer-events:none"></div>
        <span style="font-size:9px;color:var(--a-tx3)">{{ l.label }}</span>
      </div>
    }
  </div>
</div>
`,
})
export class SeatMapComponent implements OnChanges {
  /** Code du plan ('bus', 'minibus16', 'minibus10') : utilisé si `rows` n'est pas fourni. */
  @Input() layout = 'bus';
  /** Rangées du plan telles que renvoyées par l'API (fonctionne aussi pour un plan personnalisé). */
  @Input() rows: SeatRowDef[] | null = null;
  @Input() booked:  string[] = [];
  @Input() pending: string[] = [];
  @Input() selected: string[] = [];
  /** Nom du passager par siège (info-bulle). */
  @Input() names: Record<string, string> = {};
  @Input() selectable = false;
  @Input() size = 22;
  @Output() seatClick = new EventEmitter<string>();

  effectiveRows: SeatRowDef[] = [];
  private maxSeats = 4;
  get legend() {
    return [{ cls: 'available', label: 'Libre' }, { cls: 'booked', label: 'Vendu' }, { cls: 'pending', label: 'En cours' },
      ...(this.selectable ? [{ cls: 'selected', label: 'Sélection' }] : [])];
  }

  ngOnChanges(): void {
    this.effectiveRows = this.rows?.length ? this.rows : (BUILTIN_SEAT_ROWS[this.layout] ?? BUILTIN_SEAT_ROWS['bus']);
    this.maxSeats = Math.max(...this.effectiveRows.filter(r => !r.isDriverRow).map(r => r.seats.length), 1);
  }
  padding(row: SeatRowDef): number[] { return Array.from({ length: Math.max(0, this.maxSeats - row.seats.length) }, (_, i) => i); }
  st(seat: string): string {
    if (this.selected.includes(seat)) return 'selected';
    if (this.booked.includes(seat))  return 'booked';
    if (this.pending.includes(seat)) return 'pending';
    return 'available';
  }
  title(seat: string): string { const n = this.names[seat]; return n ? `${seat} — ${n}` : `${seat} — ${({ selected: 'sélectionné', booked: 'vendu', pending: 'en cours de réservation', available: 'libre' } as Record<string, string>)[this.st(seat)]}`; }
  clickable(seat: string): boolean { return this.selectable && (this.st(seat) === 'available' || this.st(seat) === 'selected'); }
  pick(seat: string): void { if (this.clickable(seat)) this.seatClick.emit(seat); }
}

/** Plans intégrés (identiques à ceux du serveur) : secours quand les rangées ne sont pas fournies. */
export const BUILTIN_SEAT_ROWS: Record<string, SeatRowDef[]> = {
  bus: [{ rowId: 'driver', seats: [], isDriverRow: true }, ...'ABCDEFGHIJKL'.split('').map(l => ({ rowId: l, seats: [1, 2, 3, 4].map(n => l + n), aisleAfter: 2 }))],
  minibus16: [{ rowId: 'front', seats: ['F1', 'F2'], isDriverRow: true }, { rowId: 'A', seats: ['A1', 'A2', 'A3', 'A4'], aisleAfter: 2 },
    { rowId: 'B', seats: ['B1', 'B2', 'B3'], aisleAfter: 2 }, { rowId: 'C', seats: ['C1', 'C2', 'C3'], aisleAfter: 2 }, { rowId: 'D', seats: ['D1', 'D2', 'D3', 'D4'], aisleAfter: 2 }],
  minibus10: [{ rowId: 'front', seats: ['F1'], isDriverRow: true }, { rowId: 'A', seats: ['A1', 'A2', 'A3'], aisleAfter: 2 },
    { rowId: 'B', seats: ['B1', 'B2', 'B3'], aisleAfter: 2 }, { rowId: 'C', seats: ['C1', 'C2', 'C3'], aisleAfter: 2 }],
};
