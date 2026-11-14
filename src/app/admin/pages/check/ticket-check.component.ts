import { Component, OnDestroy, ElementRef, ViewChild, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AdminLiveService, TicketCheck } from '../../services/admin-live.service';
import { AppConfigService } from '../../../core/config/app-config.service';
import { errorMessage } from '../../../core/api/api.service';
import { AdminDatePipe } from '../../pipes/admin.pipes';

/**
 * Contrôle des billets à l'embarquement : scan du QR code avec la caméra du téléphone (quand le navigateur le permet),
 * lecteur de codes-barres (qui « tape » le code) ou saisie du numéro de billet. La signature du QR est vérifiée par le serveur.
 */
@Component({
  selector: 'app-ticket-check',
  standalone: true,
  imports: [FormsModule, AdminDatePipe],
  template: `
<div class="a-fade" style="max-width:560px;margin:0 auto">
  <div style="font-size:18px;font-weight:700;letter-spacing:-.4px;margin-bottom:12px">Contrôle des billets</div>
  <form class="a-card" (ngSubmit)="check()" style="display:grid;gap:10px">
    <label class="a-form-label" for="code">QR code scanné ou numéro de billet</label>
    <input id="code" #codeInput name="code" class="a-input a-mono" style="height:48px;font-size:16px" [(ngModel)]="code" autocomplete="off" autocapitalize="characters" placeholder="Scannez ou saisissez…" autofocus />
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button type="submit" class="a-btn primary" style="flex:1;justify-content:center;height:44px" [disabled]="busy() || code.trim().length < 3">Vérifier</button>
      @if (cameraSupported) { <button type="button" class="a-btn ghost" style="height:44px" (click)="scanning() ? stopCamera() : startCamera()">{{ scanning() ? 'Arrêter la caméra' : '📷 Scanner' }}</button> }
    </div>
    @if (!cameraSupported) { <div style="font-size:11px;color:var(--a-tx3)">Ce navigateur ne sait pas lire les QR codes avec la caméra : utilisez un lecteur de codes ou saisissez le numéro imprimé sur le billet.</div> }
    <video #video [hidden]="!scanning()" playsinline muted style="width:100%;border-radius:10px;background:#000;max-height:320px"></video>
    @if (cameraError()) { <div role="alert" style="font-size:12px;color:var(--a-red)">{{ cameraError() }}</div> }
  </form>

  @if (result(); as r) {
    <div class="a-card" role="status" aria-live="assertive" [style]="'margin-top:12px;text-align:center;border-width:2px;border-color:' + color(r)">
      <div style="font-size:44px" aria-hidden="true">{{ r.valid ? (r.status === 'boarded' ? '🟢' : '✅') : '⛔' }}</div>
      <div style="font-size:20px;font-weight:800" [style.color]="color(r)">{{ r.message || (r.valid ? 'Billet valide' : 'Billet refusé') }}</div>
      @if (r.passenger) {
        <div style="font-size:18px;font-weight:700;margin-top:10px">{{ r.passenger }}</div>
        <div class="a-mono" style="font-size:26px;font-weight:800;color:var(--a-cyan)">Siège {{ r.seatNo }}</div>
        <div style="font-size:13px;margin-top:6px">{{ r.fromCity }} → {{ r.toCity }} · {{ r.departureAt | adminDate:'datetime' }}</div>
        <div class="a-mono" style="font-size:11px;color:var(--a-tx3);margin-top:4px">{{ r.ticketNumber }} · {{ r.phone }}</div>
        @if (r.boardedAt && r.reason === 'ALREADY_BOARDED') { <div style="font-size:12px;color:var(--a-amber);margin-top:6px">Déjà présenté le {{ r.boardedAt | adminDate:'datetime' }}</div> }
      }
      @if (r.valid && r.status !== 'boarded') {
        <button class="a-btn success" style="margin-top:14px;width:100%;justify-content:center;height:48px;font-size:15px" [disabled]="busy()" (click)="board()">Valider l'embarquement</button>
      }
      <button class="a-btn ghost" style="margin-top:8px;width:100%;justify-content:center" (click)="next()">Billet suivant</button>
    </div>
  }
  @if (error()) { <div class="a-card" role="alert" style="margin-top:12px;color:var(--a-red)">{{ error() }}</div> }
  <div style="font-size:11px;color:var(--a-tx3);margin-top:14px;text-align:center">{{ count() }} embarquement(s) validé(s) depuis l'ouverture de cette page</div>
</div>`,
})
export class TicketCheckComponent implements OnDestroy {
  private live = inject(AdminLiveService);
  readonly cfg = inject(AppConfigService);
  @ViewChild('video') video?: ElementRef<HTMLVideoElement>;
  @ViewChild('codeInput') input?: ElementRef<HTMLInputElement>;
  code = '';
  readonly busy = signal(false);
  readonly result = signal<TicketCheck | null>(null);
  readonly error = signal<string | null>(null);
  readonly scanning = signal(false);
  readonly cameraError = signal<string | null>(null);
  readonly count = signal(0);
  readonly cameraSupported = typeof window !== 'undefined' && 'BarcodeDetector' in window && !!navigator.mediaDevices?.getUserMedia;
  private stream: MediaStream | null = null;
  private lastCode = '';
  private loop: ReturnType<typeof setInterval> | null = null;

  async check(): Promise<void> {
    if (this.busy() || this.code.trim().length < 3) return;
    this.busy.set(true); this.error.set(null);
    try { this.lastCode = this.code.trim(); this.result.set(await this.live.verifyTicket(this.lastCode)); }
    catch (e) { this.result.set(null); this.error.set(errorMessage(e)); }
    finally { this.busy.set(false); }
  }
  async board(): Promise<void> {
    this.busy.set(true); this.error.set(null);
    try { const r = await this.live.boardTicket(this.lastCode); this.result.set(r); if (r.valid) this.count.update(n => n + 1); }
    catch (e) { this.error.set(errorMessage(e)); }
    finally { this.busy.set(false); }
  }
  next(): void { this.code = ''; this.result.set(null); this.error.set(null); setTimeout(() => this.input?.nativeElement.focus(), 0); }
  color(r: TicketCheck): string { return r.valid ? 'var(--a-green)' : r.reason === 'ALREADY_BOARDED' ? 'var(--a-amber)' : 'var(--a-red)'; }

  async startCamera(): Promise<void> {
    this.cameraError.set(null);
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      const v = this.video!.nativeElement; v.srcObject = this.stream; await v.play();
      this.scanning.set(true);
      const detector = new (window as any).BarcodeDetector({ formats: ['qr_code'] });
      this.loop = setInterval(async () => {
        if (this.busy() || this.result()) return;
        try { const codes = await detector.detect(v); if (codes[0]?.rawValue) { this.code = codes[0].rawValue; await this.check(); } } catch { /* image suivante */ }
      }, 400);
    } catch { this.cameraError.set('Caméra indisponible ou accès refusé. Saisissez le numéro du billet.'); this.stopCamera(); }
  }
  stopCamera(): void {
    if (this.loop) clearInterval(this.loop); this.loop = null;
    this.stream?.getTracks().forEach(t => t.stop()); this.stream = null;
    this.scanning.set(false);
  }
  ngOnDestroy(): void { this.stopCamera(); }
}
