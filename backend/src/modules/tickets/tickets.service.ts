import { Injectable } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import * as QRCode from 'qrcode';
import * as fs from 'fs';
import * as path from 'path';
import { Db } from '../../common/db';
import { AppError } from '../../common/errors';
import { AuthUser } from '../../common/auth';
import { hmac, safeEqual } from '../../common/crypto';
import { env } from '../../common/env';
import { DateTime } from 'luxon';
import { SettingsService } from '../settings/settings.service';
import { BookingsService, bookingAccessToken } from '../booking/bookings.service';
import { Outbox } from '../notifications/outbox';

/** Contenu du QR code. « signed » : numéro de billet + signature (un faux billet est rejeté même hors ligne côté serveur). */
export function qrPayload(ticketNumber: string, format: 'signed' | 'reference'): string {
  return format === 'reference' ? ticketNumber : `BB1.${ticketNumber}.${hmac('ticket:' + ticketNumber).slice(0, 12)}`;
}
export function parseQr(code: string): { ticketNumber: string; signed: boolean; valid: boolean } {
  const c = code.trim();
  if (c.startsWith('BB1.')) {
    const [, num, sig] = c.split('.');
    return { ticketNumber: (num || '').toUpperCase(), signed: true, valid: !!num && !!sig && safeEqual(sig, hmac('ticket:' + num).slice(0, 12)) };
  }
  return { ticketNumber: c.toUpperCase(), signed: false, valid: true };
}
export function formatMoney(amount: number, l: { currencySymbol: string; currencyPosition: string; currencyDecimals: number; thousandsSeparator: string }): string {
  const v = amount / Math.pow(10, l.currencyDecimals);
  const [int, dec] = v.toFixed(l.currencyDecimals).split('.');
  const n = int.replace(/\B(?=(\d{3})+(?!\d))/g, l.thousandsSeparator === ' ' ? ' ' : l.thousandsSeparator) + (dec ? (l.thousandsSeparator === ',' ? '.' : ',') + dec : '');   // séparateur décimal jamais identique au séparateur de milliers
  return l.currencyPosition === 'before' ? `${l.currencySymbol} ${n}` : `${n} ${l.currencySymbol}`;
}
const LABELS: Record<string, Record<string, string>> = {
  fr: { ticket: 'Billet de voyage', ref: 'Référence', from: 'Départ', to: 'Arrivée', date: 'Date', vehicle: 'Véhicule', seat: 'Siège', passenger: 'Passager', phone: 'Téléphone', total: 'Total payé', tickets: 'Billets', fee: 'Frais de service', tax: 'Taxe', confirmed: 'RÉSERVATION CONFIRMÉE', scan: 'À présenter à l\'embarquement', issued: 'Émis le', important: 'Important', station: 'Lieu de départ' },
  en: { ticket: 'Travel ticket', ref: 'Reference', from: 'From', to: 'To', date: 'Date', vehicle: 'Vehicle', seat: 'Seat', passenger: 'Passenger', phone: 'Phone', total: 'Total paid', tickets: 'Tickets', fee: 'Service fee', tax: 'Tax', confirmed: 'BOOKING CONFIRMED', scan: 'Show when boarding', issued: 'Issued on', important: 'Important', station: 'Departure point' },
  mg: { ticket: 'Tapakila', ref: 'Laharana', from: 'Fiaingana', to: 'Fahatongavana', date: 'Daty', vehicle: 'Fiara', seat: 'Seza', passenger: 'Mpandeha', phone: 'Finday', total: 'Totaly voaloa', tickets: 'Tapakila', fee: 'Saram-panompoana', tax: 'Hetra', confirmed: 'VOAMARINA NY FAMANDRIHANA', scan: 'Asehoy alohan\'ny hiakarana', issued: 'Navoaka ny', important: 'Zava-dehibe', station: 'Toerana fiaingana' },
};

@Injectable()
export class TicketsService {
  constructor(private db: Db, private settings: SettingsService, private bookings: BookingsService, private outbox: Outbox) {}

  async qrCodes(bookingId: string) {
    const v = await this.bookings.view(bookingId);
    const t = await this.settings.get('ticket');
    const out: any[] = [];
    for (const p of v.passengers.filter((x: any) => x.ticketNumber && x.status !== 'cancelled'))
      out.push({ passengerId: p.id, ticketNumber: p.ticketNumber, seatNo: p.seatNo, name: `${p.firstName} ${p.lastName}`,
        qrDataUrl: await QRCode.toDataURL(qrPayload(p.ticketNumber, t.qrFormat), { margin: 1, width: 240, errorCorrectionLevel: 'M' }) });
    return out;
  }
  private async logoBuffer(url: string): Promise<Buffer | null> {
    const m = /\/files\/([0-9a-f-]{36})/.exec(url || '');
    if (!m) return null;
    const f = await this.db.maybe<any>('SELECT path, mime FROM files WHERE id = $1', [m[1]]);
    if (!f || !/png|jpeg/.test(f.mime)) return null;   // pdfkit ne sait intégrer que PNG et JPEG
    try { return fs.readFileSync(path.resolve(env().uploadDir, f.path)); } catch { return null; }
  }

  /** Billet PDF : une page par passager, aux couleurs et au nom de la société. */
  async pdf(bookingId: string): Promise<Buffer> {
    const v = await this.bookings.view(bookingId);
    if (!['confirmed', 'completed'].includes(v.status)) throw new AppError('BOOKING_NOT_CONFIRMED', 409, 'Le billet n\'est disponible que pour une réservation confirmée');
    const s = await this.settings.all();
    const L = LABELS[v.lang] || LABELS.fr;
    const color = s.ticket.headerColor || s.identity.primaryColor;
    const logo = s.ticket.showLogo ? await this.logoBuffer(s.identity.logoUrl) : null;
    const zone = s.locale.timezone;
    const dep = DateTime.fromJSDate(new Date(v.trip.departureAt), { zone }), arr = DateTime.fromJSDate(new Date(v.trip.arrivalAt), { zone });
    const fmtDate = (d: DateTime) => d.setLocale(v.lang === 'en' ? 'en' : 'fr').toFormat(s.locale.dateFormat) ;
    const fmtTime = (d: DateTime) => d.toFormat(s.locale.timeFormat);
    const money = (n: number) => formatMoney(n, s.locale).replace(/ /g, ' ');
    const pax = v.passengers.filter((p: any) => p.status !== 'cancelled');

    const doc = new PDFDocument({ size: 'A5', margin: 28, info: { Title: `${L.ticket} ${v.reference}`, Author: s.identity.name } });
    const chunks: Buffer[] = [];
    doc.on('data', c => chunks.push(c));
    const done = new Promise<Buffer>(res => doc.on('end', () => res(Buffer.concat(chunks))));
    const W = doc.page.width, M = 28;

    for (let i = 0; i < pax.length; i++) {
      const p = pax[i];
      if (i > 0) doc.addPage();
      doc.rect(0, 0, W, 78).fill(color);
      let x = M;
      if (logo) { try { doc.image(logo, M, 16, { fit: [46, 46] }); x = M + 56; } catch { /* logo illisible : on continue sans */ } }
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(17).text(s.identity.name, x, 20, { width: W - x - 150, ellipsis: true, lineBreak: false });
      doc.font('Helvetica').fontSize(8.5).text(s.identity.slogan || L.ticket, x, 44, { width: W - x - 150, ellipsis: true, lineBreak: false });
      doc.fontSize(7.5).text(L.ref.toUpperCase(), W - 150, 20, { width: 150 - M, align: 'right' });
      doc.font('Courier-Bold').fontSize(13).text(p.ticketNumber || v.reference, W - 170, 32, { width: 170 - M, align: 'right' });
      doc.rect(0, 78, W, 20).fill('#059669');
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(9).text(L.confirmed, 0, 84, { width: W, align: 'center' });

      let y = 114;
      doc.roundedRect(M, y, W - 2 * M, 74, 6).fillAndStroke('#f8fafc', '#e2e8f0');
      const half = (W - 2 * M) / 2;
      doc.fillColor('#64748b').font('Helvetica').fontSize(7.5).text(L.from.toUpperCase(), M + 12, y + 10).text(L.to.toUpperCase(), M + half, y + 10, { width: half - 12, align: 'right' });
      doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(15).text(v.trip.fromCity, M + 12, y + 22, { width: half - 20, lineBreak: false, ellipsis: true })
        .text(v.trip.toCity, M + half, y + 22, { width: half - 12, align: 'right', lineBreak: false, ellipsis: true });
      doc.fillColor(color).fontSize(12).text(fmtTime(dep), M + 12, y + 44).text(fmtTime(arr), M + half, y + 44, { width: half - 12, align: 'right' });
      doc.fillColor('#64748b').font('Helvetica').fontSize(8).text(v.trip.duration, M, y + 47, { width: W - 2 * M, align: 'center' });

      y += 88;
      const cell = (label: string, value: string, cx: number, cy: number, w: number) => {
        doc.fillColor('#94a3b8').font('Helvetica').fontSize(7).text(label.toUpperCase(), cx, cy, { width: w });
        doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(10.5).text(value || '-', cx, cy + 10, { width: w, lineBreak: false, ellipsis: true });
      };
      const cw = (W - 2 * M) / 3;
      cell(L.date, fmtDate(dep), M, y, cw - 6); cell(L.vehicle, `${v.trip.vehicleName}${v.plateNumber ? ' · ' + v.plateNumber : ''}`, M + cw, y, cw - 6); cell(L.seat, p.seatNo, M + 2 * cw, y, cw);
      y += 34;
      cell(L.passenger, `${p.firstName} ${p.lastName}`, M, y, 2 * cw - 6); cell(L.phone, p.phone || v.contact.phone, M + 2 * cw, y, cw);
      if (v.trip.fromStation) { y += 34; cell(L.station, v.trip.fromStation, M, y, W - 2 * M); }

      y += 40;
      doc.moveTo(M, y).lineTo(W - M, y).dash(3, { space: 3 }).strokeColor('#cbd5e1').stroke().undash();
      y += 12;
      const qr = await QRCode.toBuffer(qrPayload(p.ticketNumber || v.reference, s.ticket.qrFormat), { margin: 1, width: 300, errorCorrectionLevel: 'M' });
      doc.image(qr, W - M - 104, y, { width: 104 });
      doc.fillColor('#64748b').font('Helvetica').fontSize(7).text(L.scan, W - M - 114, y + 106, { width: 124, align: 'center' });
      const line = (label: string, value: string, bold = false) => {
        doc.fillColor(bold ? '#0f172a' : '#475569').font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 9).text(label, M, y, { width: 130 }).text(value, M + 130, y, { width: W - 2 * M - 250, align: 'right' });
        y += bold ? 18 : 14;
      };
      line(`${L.tickets} × ${pax.length}`, money(v.subtotal));
      if (v.serviceFee) line(L.fee, money(v.serviceFee));
      if (v.taxAmount) line(`${s.legal.taxName} ${s.legal.taxRatePercent} %${s.legal.taxIncluded ? ' (incl.)' : ''}`, money(v.taxAmount));
      y += 2; line(L.total, money(v.total), true);

      y = Math.max(y + 12, doc.y + 12, 114 + 88 + 34 + 34 + 40 + 12 + 124);
      const notes = [...s.ticket.instructions, s.legal.ticketLegalNotice].filter(Boolean);
      if (notes.length) {
        doc.fillColor('#92400e').font('Helvetica-Bold').fontSize(8).text(L.important, M, y); y += 11;
        doc.font('Helvetica').fontSize(7.5).fillColor('#78350f');
        for (const n of notes) { doc.text('• ' + n, M, y, { width: W - 2 * M }); y = doc.y + 2; }
      }
      const regs = s.legal.registrationNumbers.map(r => `${r.label} ${r.value}`).join(' · ');
      const foot = [s.ticket.footerText, [s.contact.phones[0], s.contact.email, s.contact.website].filter(Boolean).join(' · '), regs,
        `${L.issued} ${fmtDate(DateTime.fromJSDate(new Date(v.confirmedAt || v.createdAt), { zone }))} — ${s.identity.legalName || s.identity.name}`].filter(Boolean);
      doc.fillColor('#94a3b8').font('Helvetica').fontSize(6.5).text(foot.join('\n'), M, doc.page.height - 28 - foot.length * 8.5, { width: W - 2 * M, align: 'center', lineGap: 1 });
    }
    doc.end();
    return done;
  }
  async enqueueTicketEmail(bookingId: string, to: string) {
    const b = await this.db.one<any>('SELECT * FROM bookings WHERE id = $1', [bookingId]);
    await this.bookings.notifyBooking(this.db, { ...b, contactEmail: to }, 'booking_confirmed', true);
  }

  // ── Contrôle à l'embarquement ──────────────────────────────────────────────
  async verify(code: string, tripId?: string) {
    const q = parseQr(code);
    if (!q.valid) return { valid: false, reason: 'FORGED', message: 'QR code non authentique' };
    const p = await this.db.maybe<any>(
      `SELECT p.*, b.reference, b.status AS booking_status, b.trip_id, b.contact_phone, t.status AS trip_status, t.departure_at, t.service_date,
              cf.name AS from_city, ct.name AS to_city
         FROM booking_passengers p JOIN bookings b ON b.id = p.booking_id JOIN trips t ON t.id = b.trip_id
         JOIN routes r ON r.id = t.route_id JOIN cities cf ON cf.id = r.from_city_id JOIN cities ct ON ct.id = r.to_city_id
        WHERE p.ticket_number = $1`, [q.ticketNumber]);
    if (!p) return { valid: false, reason: 'UNKNOWN', message: 'Billet inconnu' };
    const info = { ticketNumber: p.ticketNumber, reference: p.reference, passenger: `${p.firstName} ${p.lastName}`, seatNo: p.seatNo, phone: p.phone || p.contactPhone,
      fromCity: p.fromCity, toCity: p.toCity, departureAt: p.departureAt, serviceDate: p.serviceDate, tripId: p.tripId, status: p.status, boardedAt: p.boardedAt };
    if (p.status === 'cancelled' || p.bookingStatus === 'cancelled') return { valid: false, reason: 'CANCELLED', message: 'Billet annulé', ...info };
    if (p.tripStatus === 'cancelled') return { valid: false, reason: 'TRIP_CANCELLED', message: 'Voyage annulé', ...info };
    if (!['confirmed', 'completed'].includes(p.bookingStatus)) return { valid: false, reason: 'NOT_PAID', message: 'Réservation non payée', ...info };
    if (tripId && tripId !== p.tripId) return { valid: false, reason: 'WRONG_TRIP', message: 'Ce billet est pour un autre départ', ...info };
    if (p.status === 'boarded') return { valid: false, reason: 'ALREADY_BOARDED', message: 'Billet déjà utilisé', ...info };
    if (p.status === 'no_show') return { valid: false, reason: 'NO_SHOW', message: 'Passager marqué absent', ...info };
    return { valid: true, reason: 'OK', message: 'Billet valide', ...info };
  }
  /** Embarquement atomique : deux scans simultanés du même billet → un seul réussit. */
  async board(code: string, staff: AuthUser, tripId?: string) {
    const v: any = await this.verify(code, tripId);
    if (!v.valid) return v;
    const r = await this.db.maybe(`UPDATE booking_passengers SET status = 'boarded', boarded_at = now(), boarded_by = $2 WHERE ticket_number = $1 AND status = 'active' RETURNING id`, [v.ticketNumber, staff.id]);
    if (!r) return { ...v, valid: false, reason: 'ALREADY_BOARDED', message: 'Billet déjà utilisé' };
    return { ...v, status: 'boarded', boardedAt: new Date(), message: 'Embarquement validé' };
  }
}
