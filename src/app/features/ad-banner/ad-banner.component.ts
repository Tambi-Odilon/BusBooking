import {
  Component, inject, Input, OnInit, OnDestroy, signal, computed
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { PublicAdsService } from '../../core/services/public-ads.service';
import { AdminAd, AdPosition } from '../../admin/models/admin.models';

@Component({
  selector: 'app-ad-banner',
  standalone: true,
  imports: [CommonModule],
  styles: [`
    .ad-slide { animation: adIn .35s cubic-bezier(.4,0,.2,1); }
    @keyframes adIn { from { opacity:0; transform:translateX(16px); } to { opacity:1; transform:translateX(0); } }
    .ad-dot  { border:none; cursor:pointer; border-radius:50%; transition:all .2s; padding:0; }
    .ad-nav  { background:rgba(0,0,0,.18); border:none; cursor:pointer; border-radius:50%;
                width:28px; height:28px; display:flex; align-items:center; justify-content:center;
                transition:background .15s; flex-shrink:0; }
    .ad-nav:hover  { background:rgba(0,0,0,.30); }
    .ad-cta:hover  { background:rgba(255,255,255,.30) !important; }
    .ad-close      { background:rgba(0,0,0,.18); border:none; border-radius:50%; cursor:pointer;
                     width:26px; height:26px; font-size:13px;
                     display:flex; align-items:center; justify-content:center;
                     flex-shrink:0; align-self:flex-start; transition:background .15s; }
    .ad-close:hover { background:rgba(0,0,0,.30); }
  `],
  template: `
@if (activeAds().length > 0) {
  <div style="margin-bottom:14px">

    @if (activeAds().length === 1) {
      <!-- ── Bannière simple ── -->
      <div class="ad-slide" style="border-radius:14px;overflow:hidden;box-shadow:0 2px 10px rgba(0,0,0,.08)"
           [style.background]="activeAds()[0].bgColor"
           [style.color]="activeAds()[0].textColor">
        <ng-container [ngTemplateOutlet]="adBody"
                      [ngTemplateOutletContext]="{ $implicit: activeAds()[0], single: true }">
        </ng-container>
      </div>

    } @else {
      <!-- ── Carrousel ── -->
      <div style="position:relative;border-radius:14px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.1)">
        <div class="ad-slide"
             [style.background]="currentAd().bgColor"
             [style.color]="currentAd().textColor">
          <ng-container [ngTemplateOutlet]="adBody"
                        [ngTemplateOutletContext]="{ $implicit: currentAd(), single: false }">
          </ng-container>
        </div>

        <!-- Barre de progression auto -->
        @if (carouselSec > 0) {
          <div style="position:absolute;bottom:0;left:0;right:0;height:3px;background:rgba(0,0,0,.12)">
            <div style="height:100%;transition:width linear"
                 [style.width]="progressPct() + '%'"
                 [style.background]="currentAd().textColor"
                 [style.transition-duration]="carouselSec + 's'"></div>
          </div>
        }

        <!-- Flèches nav -->
        <button class="ad-nav" (click)="prev()"
                [style.color]="currentAd().textColor"
                style="position:absolute;left:10px;top:50%;transform:translateY(-50%)">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
               fill="none" stroke="currentColor" stroke-width="2.5"><path d="m15 18-6-6 6-6"/></svg>
        </button>
        <button class="ad-nav" (click)="next()"
                [style.color]="currentAd().textColor"
                style="position:absolute;right:10px;top:50%;transform:translateY(-50%)">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
               fill="none" stroke="currentColor" stroke-width="2.5"><path d="m9 18 6-6-6-6"/></svg>
        </button>

        <!-- Dots + compteur -->
        <div style="position:absolute;bottom:10px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:5px">
          @for (ad of activeAds(); track ad.id; let i = $index) {
            <button class="ad-dot" (click)="goTo(i)"
                    [style.width]="i === currentIdx() ? '18px' : '7px'"
                    [style.height]="'7px'"
                    [style.border-radius]="i === currentIdx() ? '4px' : '50%'"
                    [style.background]="i === currentIdx() ? currentAd().textColor : 'rgba(255,255,255,.45)'">
            </button>
          }
          <span style="font-size:9px;font-weight:700;opacity:.7;margin-left:4px"
                [style.color]="currentAd().textColor">
            {{ currentIdx()+1 }}/{{ activeAds().length }}
          </span>
        </div>
      </div>
    }
  </div>
}

<!-- ══════════════════════════════════════════════════════════
     Template corps d'une publicité — gère les 4 positions d'image
════════════════════════════════════════════════════════════ -->
<ng-template #adBody let-ad let-single="single">

  <!-- ── IMAGE EN FOND ── -->
  @if (ad.imageUrl && ad.imagePosition === 'background') {
    <div style="position:relative;min-height:90px"
         [style.padding-bottom]="single ? '0' : '28px'">
      <img [src]="ad.imageUrl" alt=""
           style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:.22;pointer-events:none" />
      <div style="position:relative;padding:14px 18px;display:flex;align-items:center;gap:12px">
        <ng-container [ngTemplateOutlet]="textBlock"
                      [ngTemplateOutletContext]="{ $implicit: ad, single: single }">
        </ng-container>
      </div>
    </div>

  <!-- ── IMAGE EN HAUT ── -->
  } @else if (ad.imageUrl && ad.imagePosition === 'top') {
    <div [style.padding-bottom]="single ? '0' : '28px'">
      <img [src]="ad.imageUrl" alt=""
           style="width:100%;display:block;object-fit:cover"
           [style.max-height]="ad.imageSize === 'small' ? '70px' : ad.imageSize === 'large' ? '180px' : '120px'" />
      <div style="padding:12px 18px;display:flex;align-items:center;gap:12px">
        <ng-container [ngTemplateOutlet]="textBlock"
                      [ngTemplateOutletContext]="{ $implicit: ad, single: single }">
        </ng-container>
      </div>
    </div>

  <!-- ── IMAGE À DROITE ── -->
  } @else if (ad.imageUrl && ad.imagePosition === 'right') {
    <div style="display:flex;flex-direction:row-reverse;align-items:stretch"
         [style.padding-bottom]="single ? '0' : '28px'">
      <img [src]="ad.imageUrl" alt=""
           style="object-fit:cover;flex-shrink:0"
           [style.width]="ad.imageSize === 'small' ? '80px' : ad.imageSize === 'large' ? '160px' : '120px'" />
      <div style="flex:1;padding:14px 18px;display:flex;align-items:center;gap:12px">
        <ng-container [ngTemplateOutlet]="textBlock"
                      [ngTemplateOutletContext]="{ $implicit: ad, single: single }">
        </ng-container>
      </div>
    </div>

  <!-- ── IMAGE À GAUCHE (défaut si image présente) ── -->
  } @else if (ad.imageUrl) {
    <div style="display:flex;flex-direction:row;align-items:stretch"
         [style.padding-bottom]="single ? '0' : '28px'">
      <img [src]="ad.imageUrl" alt=""
           style="object-fit:cover;flex-shrink:0"
           [style.width]="ad.imageSize === 'small' ? '80px' : ad.imageSize === 'large' ? '160px' : '120px'" />
      <div style="flex:1;padding:14px 18px;display:flex;align-items:center;gap:12px">
        <ng-container [ngTemplateOutlet]="textBlock"
                      [ngTemplateOutletContext]="{ $implicit: ad, single: single }">
        </ng-container>
      </div>
    </div>

  <!-- ── SANS IMAGE ── -->
  } @else {
    <div style="padding:14px 18px;display:flex;align-items:center;gap:12px"
         [style.padding-bottom]="single ? '14px' : '28px'">
      <ng-container [ngTemplateOutlet]="textBlock"
                    [ngTemplateOutletContext]="{ $implicit: ad, single: single }">
      </ng-container>
    </div>
  }
</ng-template>

<!-- ══════════════════════════════════════════════════════════
     Sous-template : texte + CTA + bouton fermer
════════════════════════════════════════════════════════════ -->
<ng-template #textBlock let-ad let-single="single">
  <div style="flex:1;min-width:0">
    <div style="font-weight:700;font-size:14px;line-height:1.35;margin-bottom:3px">{{ ad.title }}</div>
    @if (ad.description) {
      <div style="font-size:12px;opacity:.85;line-height:1.4">{{ ad.description }}</div>
    }
    @if (ad.linkLabel) {
      <a [href]="ad.linkUrl || '#'" [target]="ad.linkUrl ? '_blank' : '_self'"
         (click)="onCta(ad)" class="ad-cta"
         [style]="'display:inline-flex;align-items:center;gap:5px;margin-top:10px;'
               + 'background:rgba(255,255,255,.22);border:1.5px solid rgba(255,255,255,.40);'
               + 'border-radius:8px;padding:7px 16px;font-size:12px;font-weight:700;'
               + 'color:' + ad.textColor + ';text-decoration:none;transition:background .15s'">
        {{ ad.linkLabel }}
        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24"
             fill="none" stroke="currentColor" stroke-width="2.5">
          <path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>
        </svg>
      </a>
    }
  </div>
  <button class="ad-close" (click)="single ? dismissAt(0) : dismissCurrent()"
          [style.color]="ad.textColor" title="Fermer">✕</button>
</ng-template>
  `,
})
export class AdBannerComponent implements OnInit, OnDestroy {
  @Input() position: AdPosition = 'banner_top';
  @Input() page = '';

  private adsSvc    = inject(PublicAdsService);
  private allAds    = signal<AdminAd[]>([]);
  private dismissed = signal<Set<string>>(new Set());
  readonly currentIdx  = signal(0);
  readonly progressPct = signal(0);
  carouselSec = 5;

  readonly activeAds = computed(() =>
    this.allAds().filter(a => !this.dismissed().has(a.id))
  );
  readonly currentAd = computed<AdminAd>(() => {
    const ads = this.activeAds();
    const idx = Math.min(this.currentIdx(), ads.length - 1);
    return ads[idx] ?? ads[0];
  });

  private timer: ReturnType<typeof setInterval> | null = null;

  private destroyed = false;
  async ngOnInit(): Promise<void> {
    const ads = (await this.adsSvc.getBanners(this.page)).filter(a => a.position === this.position);
    if (this.destroyed) return;
    this.allAds.set(ads);
    ads.forEach(a => this.adsSvc.recordView(a.id));
    this.carouselSec = ads[0]?.carouselInterval ?? 5;
    if (this.carouselSec > 0 && ads.length > 1) this.startTimer();
  }

  ngOnDestroy(): void { this.destroyed = true; this.stopTimer(); }

  private startTimer(): void {
    this.stopTimer();
    this.progressPct.set(0);
    setTimeout(() => this.progressPct.set(100), 30);
    this.timer = setInterval(() => this.advance(), this.carouselSec * 1000);
  }
  private stopTimer(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
  private advance(): void {
    const n = this.activeAds().length;
    this.currentIdx.update(i => (i + 1) % n);
    this.progressPct.set(0);
    setTimeout(() => this.progressPct.set(100), 30);
  }

  goTo(i: number): void { this.currentIdx.set(i); if (this.carouselSec > 0) this.startTimer(); }
  next(): void { const n = this.activeAds().length; this.currentIdx.update(i => (i+1)%n); if (this.carouselSec > 0) this.startTimer(); }
  prev(): void { const n = this.activeAds().length; this.currentIdx.update(i => (i-1+n)%n); if (this.carouselSec > 0) this.startTimer(); }

  dismissAt(idx: number): void {
    const ad = this.activeAds()[idx];
    if (!ad) return;
    this.dismissed.update(s => new Set([...s, ad.id]));
    const rem = this.activeAds().length;
    if (rem === 0) { this.stopTimer(); return; }
    this.currentIdx.update(i => Math.min(i, rem - 1));
    if (this.carouselSec > 0 && rem > 1) this.startTimer();
  }
  dismissCurrent(): void { this.dismissAt(this.currentIdx()); }
  onCta(ad: AdminAd): void { this.adsSvc.recordClick(ad.id); }
}
