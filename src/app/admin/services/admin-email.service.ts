import { Injectable, computed, signal } from '@angular/core';
import { AdminPermissions } from '../models/admin.models';
import { RemoteStore } from './admin-store';
import { Page, errorMessage } from '../../core/api/api.service';

/** Message (e-mail ou SMS) réellement confié au serveur d'envoi. */
export interface SentMessage {
  id: string; channel: 'email' | 'sms'; to: string; template: string; lang: string; subject: string; body: string;
  status: 'pending' | 'sent' | 'failed' | 'simulated'; attempts: number; lastError: string | null; createdAt: string; sentAt: string | null;
}
const toMessage = (n: any): SentMessage => ({ id: n.id, channel: n.channel, to: n.recipient, template: n.template, lang: n.lang, subject: n.subject || '', body: n.body || '',
  status: n.status, attempts: n.attempts, lastError: n.lastError, createdAt: n.createdAt, sentAt: n.sentAt });
export const TEMPLATE_LABELS: Record<string, string> = {
  booking_confirmed: 'Billet confirmé', booking_cancelled: 'Réservation annulée', booking_changed: 'Réservation modifiée', trip_cancelled: 'Voyage annulé', seat_changed: 'Changement de siège',
  payment_refund: 'Remboursement', trip_reminder: 'Rappel de départ', password_reset: 'Mot de passe', staff_welcome: 'Invitation du personnel', test: 'E-mail de test',
};

/** Journal des e-mails et SMS. Les messages sont envoyés par le serveur (jamais depuis le navigateur). */
@Injectable({ providedIn: 'root' })
export class AdminEmailService extends RemoteStore {
  protected readonly needs: (keyof AdminPermissions)[] = ['canViewSettings'];
  private readonly _emails = signal<SentMessage[]>([]);
  readonly emails = this._emails.asReadonly();
  readonly total = signal(0);
  /** Nombre de messages en échec parmi les plus récents (pastille d'alerte du bandeau). */
  readonly failed = computed(() => this._emails().filter(e => e.status === 'failed').length);
  readonly unread = () => this.failed();

  protected async fetch(): Promise<void> {
    const r = await this.api.get<Page<any>>('/admin/notifications', { query: { limit: 50 } });
    this._emails.set(r.items.map(toMessage)); this.total.set(r.total);
  }
  protected reset(): void { this._emails.set([]); this.total.set(0); }
  async page(page: number, status = '', limit = 25): Promise<Page<SentMessage>> {
    const r = await this.api.get<Page<any>>('/admin/notifications', { query: { page, limit, status } });
    return { ...r, items: r.items.map(toMessage) };
  }
  /** Messages adressés à une personne (fiche client ou fiche d'un compte interne). */
  forRecipient(...addresses: (string | undefined)[]): SentMessage[] {
    const set = new Set(addresses.filter(Boolean).map(a => a!.toLowerCase()));
    return this._emails().filter(e => set.has(e.to.toLowerCase()));
  }
  async retry(id: string): Promise<void> {
    try { await this.api.post(`/admin/notifications/${id}/retry`); this.toast.success('Nouvel envoi programmé'); await this.load(); }
    catch (e) { this.toast.error(errorMessage(e)); }
  }
  label(template: string): string { return TEMPLATE_LABELS[template] ?? template; }
}
