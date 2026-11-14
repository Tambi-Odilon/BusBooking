import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AdminEmailService, SentMessage } from '../../services/admin-email.service';
import { AdminAuthService } from '../../services/admin-auth.service';
import { AdminToastService } from '../../services/admin-toast.service';
import { AppConfigService } from '../../../core/config/app-config.service';

const STATUS: Record<string, { label: string; color: string }> = {
  sent: { label: 'Envoyé', color: 'var(--a-green)' }, pending: { label: 'En attente', color: 'var(--a-amber)' },
  failed: { label: 'Échec', color: 'var(--a-red)' }, simulated: { label: 'Simulé', color: 'var(--a-cyan)' },
};

/** Journal des e-mails et SMS envoyés par le serveur, avec relance des envois en échec. */
@Component({
  selector: 'app-messages',
  standalone: true,
  imports: [FormsModule],
  template: `
  <div class="a-fade">
    <div style="margin-bottom:18px">
      <h1 style="font-size:18px;font-weight:700;color:var(--a-tx1);margin:0">E-mails et SMS</h1>
      <div class="a-mono" style="font-size:11px;color:var(--a-tx3);margin-top:3px">Tout ce que l'application a envoyé aux voyageurs et au personnel</div>
    </div>

    <div class="a-card" style="padding:12px 16px;margin-bottom:14px;font-size:12px;color:var(--a-tx2);line-height:1.6">
      « Simulé » : aucun fournisseur d'e-mail ou de SMS n'est configuré, le message est seulement enregistré ici.
      Configurez l'envoi dans <strong>Société et réglages → Notifications</strong>.
    </div>

    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px">
      @for (f of filters; track f.id) {
        <button class="a-btn sm" [class.primary]="status() === f.id" [class.ghost]="status() !== f.id" (click)="status.set(f.id); load(1)">{{ f.label }}</button>
      }
    </div>

    <div class="a-card" style="padding:0;overflow:hidden">
      @if (loading()) { <div style="padding:28px;text-align:center;color:var(--a-tx3);font-size:12px" role="status">Chargement…</div> }
      @else if (error()) { <div style="padding:28px;text-align:center;color:var(--a-red);font-size:12px" role="alert">{{ error() }} <button class="a-btn ghost sm" (click)="load(page())">Réessayer</button></div> }
      @else if (!items().length) { <div style="padding:28px;text-align:center;color:var(--a-tx3);font-size:12px">Aucun message pour le moment.</div> }
      @else {
        @for (m of items(); track m.id) {
          <div style="padding:12px 16px;border-bottom:1px solid var(--a-border)">
            <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;cursor:pointer" (click)="open.set(open() === m.id ? null : m.id)">
              <span class="a-mono" style="font-size:9px;font-weight:700;padding:2px 8px;border-radius:4px" [style.color]="st(m.status).color" [style.border]="'1px solid ' + st(m.status).color">{{ st(m.status).label }}</span>
              <span style="font-size:11px;color:var(--a-tx3)">{{ m.channel === 'sms' ? '📱 SMS' : '✉ E-mail' }}</span>
              <span style="font-size:13px;font-weight:600;color:var(--a-tx1);flex:1 1 200px;min-width:0;overflow:hidden;text-overflow:ellipsis">{{ m.subject || svc.label(m.template) }}</span>
              <span style="font-size:12px;color:var(--a-tx2)">{{ m.to }}</span>
              <span class="a-mono" style="font-size:10px;color:var(--a-tx3);white-space:nowrap">{{ cfg.date(m.sentAt || m.createdAt, { time: true }) }}</span>
              @if (m.status === 'failed' && auth.can('canManageSettings')) { <button class="a-btn ghost sm" (click)="$event.stopPropagation(); retry(m)">Renvoyer</button> }
            </div>
            @if (m.lastError) { <div style="font-size:11px;color:var(--a-red);margin-top:6px">Erreur : {{ m.lastError }} ({{ m.attempts }} tentative(s))</div> }
            @if (open() === m.id) {
              <pre style="font-size:11px;color:var(--a-tx2);white-space:pre-wrap;background:var(--a-bg3);padding:12px;border-radius:7px;margin:10px 0 0;line-height:1.6;font-family:inherit;overflow-wrap:anywhere">{{ m.body }}</pre>
            }
          </div>
        }
      }
    </div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-top:12px;font-size:11px;color:var(--a-tx3);gap:10px;flex-wrap:wrap">
      <span>{{ total() }} message(s) · page {{ page() }} sur {{ pages() }}</span>
      <span style="display:flex;gap:6px">
        <button class="a-btn ghost sm" [disabled]="page() <= 1 || loading()" (click)="load(page() - 1)">Précédent</button>
        <button class="a-btn ghost sm" [disabled]="page() >= pages() || loading()" (click)="load(page() + 1)">Suivant</button>
      </span>
    </div>
  </div>`,
})
export class MessagesComponent implements OnInit {
  readonly svc = inject(AdminEmailService);
  readonly auth = inject(AdminAuthService);
  readonly cfg = inject(AppConfigService);
  private toast = inject(AdminToastService);
  readonly filters = [{ id: '', label: 'Tous' }, { id: 'failed', label: 'En échec' }, { id: 'pending', label: 'En attente' }, { id: 'sent', label: 'Envoyés' }, { id: 'simulated', label: 'Simulés' }];
  readonly status = signal('');
  readonly items = signal<SentMessage[]>([]);
  readonly total = signal(0);
  readonly page = signal(1);
  readonly loading = signal(false);
  readonly error = signal('');
  readonly open = signal<string | null>(null);
  private readonly limit = 25;
  pages(): number { return Math.max(1, Math.ceil(this.total() / this.limit)); }
  st(s: string) { return STATUS[s] ?? { label: s, color: 'var(--a-tx3)' }; }

  ngOnInit(): void { void this.load(1); }
  async load(page: number): Promise<void> {
    this.loading.set(true); this.error.set('');
    try { const r = await this.svc.page(page, this.status(), this.limit); this.items.set(r.items); this.total.set(r.total); this.page.set(r.page); }
    catch { this.error.set('Chargement impossible.'); }
    finally { this.loading.set(false); }
  }
  async retry(m: SentMessage): Promise<void> {
    try { await this.svc.retry(m.id); this.toast.success('Message remis en file d\'envoi'); } catch { this.toast.error('Relance impossible'); }
    void this.load(this.page());
  }
}
