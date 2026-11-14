import { Injectable, inject } from '@angular/core';
import { ApiService } from '../api/api.service';
import { TicketQr } from '../models/booking.models';

/** Billets : le PDF et les QR codes sont produits par le serveur (signés), l'e-mail est réellement envoyé. */
@Injectable({ providedIn: 'root' })
export class TicketService {
  private api = inject(ApiService);
  private headers(token?: string): Record<string, string> { return token ? { 'x-booking-token': token } : {}; }

  qrCodes(reference: string, token?: string): Promise<TicketQr[]> {
    return this.api.get<TicketQr[]>(`/bookings/${reference}/qr`, { headers: this.headers(token), scope: 'customer' });
  }
  /** Télécharge le billet PDF (fonctionne aussi sur téléphone : pas de fenêtre surgissante). */
  async downloadTicketPdf(reference: string, token?: string): Promise<void> {
    const blob = await this.api.get<Blob>(`/bookings/${reference}/ticket.pdf`, { headers: this.headers(token), blob: true, scope: 'customer' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `billet-${reference}.pdf`; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  /** Envoi réel du billet par e-mail (à l'adresse de contact si `email` est vide). */
  async sendTicketByEmail(reference: string, email: string | undefined, token?: string): Promise<void> {
    await this.api.post(`/bookings/${reference}/resend`, email ? { email } : {}, { headers: this.headers(token), scope: 'customer' });
  }
}
