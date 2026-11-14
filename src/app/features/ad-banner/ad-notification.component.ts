import { Component, inject, OnInit, OnDestroy, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { PublicAdsService } from '../../core/services/public-ads.service';
import { AdminAd, AdNotifPosition } from '../../admin/models/admin.models';

interface Slot { ad: AdminAd; alive: boolean; progress: number; }

// Styles CSS de position → coin de l'écran
const POS_STYLE: Record<AdNotifPosition, string> = {
  'top-left':      'top:16px;left:16px',
  'top-center':    'top:16px;left:50%;transform:translateX(-50%)',
  'top-right':     'top:16px;right:16px',
  'bottom-left':   'bottom:20px;left:16px',
  'bottom-center': 'bottom:20px;left:50%;transform:translateX(-50%)',
  'bottom-right':  'bottom:20px;right:16px',
};

@Component({
  selector: 'app-ad-notification',
  standalone: true,
  imports: [CommonModule],
  styles: [`
    .notif-in  { animation: nIn  .38s cubic-bezier(.22,1,.36,1) both; }
    .notif-out { animation: nOut .28s cubic-bezier(.4,0,1,1) both; }
    @keyframes nIn  { from { opacity:0; transform:scale(.88) translateY(10px); } to { opacity:1; transform:scale(1) translateY(0); } }
    @keyframes nOut { from { opacity:1; transform:scale(1); }                   to { opacity:0; transform:scale(.88); } }
    .notif-cta { transition:background .15s; }
    .notif-cta:hover { background:rgba(255,255,255,.30) !important; }
  `],
  template: `
<!-- Un conteneur par position utilisée -->
@for (pos of usedPositions(); track pos) {
  <div [style]="'position:fixed;z-index:9999;display:flex;flex-direction:column;gap:10px;pointer-events:none;' + posStyle(pos)"
       [style.align-items]="pos.includes('right') ? 'flex-end' : pos.includes('left') ? 'flex-start' : 'center'">
    @for (slot of slotsFor(pos); track slot.ad.id) {
      <div [class]="slot.alive ? 'notif-in' : 'notif-out'"
           style="width:310px;border-radius:14px;overflow:hidden;box-shadow:0 8px 30px rgba(0,0,0,.18);pointer-events:all"
           [style.background]="slot.ad.bgColor"
           [style.color]="slot.ad.textColor">

        <!-- Image en haut (si imagePosition === 'top') -->
        @if (slot.ad.imageUrl && slot.ad.imagePosition === 'top') {
          <img [src]="slot.ad.imageUrl" alt=""
               style="width:100%;display:block;border-radius:14px 14px 0 0"
               [style.max-height]="slot.ad.imageSize === 'small' ? '60px' : slot.ad.imageSize === 'large' ? '130px' : '90px'"
               style="object-fit:cover" />
        }

        <!-- Contenu -->
        <div style="padding:13px 14px 11px;position:relative"
             [style.background]="slot.ad.imageUrl && slot.ad.imagePosition === 'background' ? 'transparent' : ''">

          <!-- Image de fond -->
          @if (slot.ad.imageUrl && slot.ad.imagePosition === 'background') {
            <img [src]="slot.ad.imageUrl" alt=""
                 style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:.2;pointer-events:none;border-radius:0 0 14px 14px" />
          }

          <div style="position:relative;display:flex;align-items:flex-start;gap:9px"
               [style.flex-direction]="slot.ad.imageUrl && slot.ad.imagePosition === 'right' ? 'row-reverse' : 'row'">

            <!-- Image gauche ou droite -->
            @if (slot.ad.imageUrl && (slot.ad.imagePosition === 'left' || slot.ad.imagePosition === 'right')) {
              <img [src]="slot.ad.imageUrl" alt=""
                   style="border-radius:8px;object-fit:cover;flex-shrink:0;align-self:center"
                   [style.width]="slot.ad.imageSize === 'small' ? '44px' : slot.ad.imageSize === 'large' ? '80px' : '60px'"
                   [style.height]="slot.ad.imageSize === 'small' ? '44px' : slot.ad.imageSize === 'large' ? '80px' : '60px'" />
            } @else if (!slot.ad.imageUrl) {
              <!-- Icône par défaut si pas d'image -->
              <div [style]="'width:34px;height:34px;flex-shrink:0;border-radius:9px;background:rgba(255,255,255,.2);display:flex;align-items:center;justify-content:center;font-size:17px'">
                📢
              </div>
            }

            <div style="flex:1;min-width:0">
              <div style="font-weight:700;font-size:13px;line-height:1.3;margin-bottom:2px">{{ slot.ad.title }}</div>
              @if (slot.ad.description) {
                <div style="font-size:11px;opacity:.82;line-height:1.35">{{ slot.ad.description }}</div>
              }
              @if (slot.ad.linkLabel) {
                <a [href]="slot.ad.linkUrl || '#'" [target]="slot.ad.linkUrl ? '_blank' : '_self'"
                   (click)="onCta(slot.ad)"
                   class="notif-cta"
                   [style]="'display:inline-flex;align-items:center;gap:5px;margin-top:9px;background:rgba(255,255,255,.2);border:1.5px solid rgba(255,255,255,.38);border-radius:7px;padding:5px 13px;font-size:11px;font-weight:700;color:' + slot.ad.textColor + ';text-decoration:none'">
                  {{ slot.ad.linkLabel }}
                  <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
                </a>
              }
            </div>
            <button (click)="dismiss(slot.ad.id)"
                    [style]="'background:rgba(0,0,0,.15);border:none;color:' + slot.ad.textColor + ';width:22px;height:22px;border-radius:50%;cursor:pointer;font-size:11px;flex-shrink:0;display:flex;align-items:center;justify-content:center'"
                    title="Fermer">✕</button>
          </div>
        </div>

        <!-- Barre de progression -->
        <div style="height:3px;background:rgba(0,0,0,.14)">
          <div style="height:100%;transition:width linear"
               [style.width]="slot.progress + '%'"
               [style.background]="slot.ad.textColor"
               [style.transition-duration]="(slot.ad.notifDuration || 5) + 's'">
          </div>
        </div>
      </div>
    }
  </div>
}
  `,
})
export class AdNotificationComponent implements OnInit, OnDestroy {
  private adsSvc = inject(PublicAdsService);

  private slots  = signal<Slot[]>([]);
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  // Positions utilisées (pour créer un conteneur par coin)
  usedPositions = signal<AdNotifPosition[]>([]);

  // Slots groupés par position
  slotsFor(pos: AdNotifPosition): Slot[] {
    return this.slots().filter(s => (s.ad.notifPosition ?? 'bottom-right') === pos);
  }

  posStyle(pos: AdNotifPosition): string { return POS_STYLE[pos] ?? POS_STYLE['bottom-right']; }

  private destroyed = false;
  async ngOnInit(): Promise<void> {
    const notifs = await this.adsSvc.getNotifications();
    if (!notifs.length || this.destroyed) return;

    // Calculer les positions utilisées
    const positions = [...new Set(notifs.map(a => a.notifPosition ?? 'bottom-right' as AdNotifPosition))];
    this.usedPositions.set(positions);

    // Afficher en cascade (délai entre chaque)
    notifs.forEach((ad, i) => {
      setTimeout(() => {
        this.adsSvc.recordView(ad.id);
        this.show(ad);
      }, i * 600);
    });
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.timers.forEach(t => clearTimeout(t));
    this.timers.clear();
  }

  private show(ad: AdminAd): void {
    const slot: Slot = { ad, alive: true, progress: 0 };
    this.slots.update(s => [...s, slot]);

    // Démarrer la barre
    setTimeout(() => {
      this.slots.update(s => s.map(sl =>
        sl.ad.id === ad.id ? { ...sl, progress: 100 } : sl
      ));
    }, 40);

    // Auto-fermeture
    const duration = (ad.notifDuration ?? 5) * 1000;
    const t = setTimeout(() => this.dismiss(ad.id), duration);
    this.timers.set(ad.id, t);
  }

  dismiss(id: string): void {
    // Animation sortie
    this.slots.update(s => s.map(sl =>
      sl.ad.id === id ? { ...sl, alive: false } : sl
    ));
    setTimeout(() => {
      this.slots.update(s => s.filter(sl => sl.ad.id !== id));
      this.updateUsedPositions();
    }, 300);
    const t = this.timers.get(id);
    if (t) { clearTimeout(t); this.timers.delete(id); }
  }

  private updateUsedPositions(): void {
    const remaining = this.slots();
    const positions = [...new Set(remaining.map(s => s.ad.notifPosition ?? 'bottom-right' as AdNotifPosition))];
    this.usedPositions.set(positions);
  }

  onCta(ad: AdminAd): void { this.adsSvc.recordClick(ad.id); }
}
