import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Db, Tx } from '../../common/db';
import { AppError } from '../../common/errors';
import { AuthUser } from '../../common/auth';
import { Audit } from '../../common/audit';
import { EventBus } from '../../common/events';
import { hmac, safeEqual } from '../../common/crypto';
import { env } from '../../common/env';
import { logger } from '../../common/logger';
import { normalizePhone } from '../../common/zod';
import { SettingsService } from '../settings/settings.service';
import { PAYMENT_SECRET_FIELDS } from '../settings/schemas';
import { BookingsService, bookingAccessToken } from '../booking/bookings.service';
import { Outbox } from '../notifications/outbox';
import { RefundsService } from './refunds.service';
import { AirtelMoneyProvider, MvolaProvider, OrangeMoneyProvider, PaymentProvider, ProviderCtx, ProviderStatus, SimulatorProvider } from './providers';

/** Délais de revérification d'un paiement sans réponse : 15 s, 30 s, 1 min, 2 min, 5 min, puis toutes les 15 min pendant 24 h. */
const BACKOFF_SEC = [15, 30, 60, 120, 300];
export const webhookSignature = (method: string, paymentId: string) => hmac(`webhook:${method}:${paymentId}`, env().webhookSecret).slice(0, 32);

@Injectable()
export class PaymentsService implements OnModuleDestroy {
  private providers: Record<string, PaymentProvider>;
  private simulator: SimulatorProvider;
  private timers = new Set<NodeJS.Timeout>();
  constructor(private db: Db, private settings: SettingsService, private bookings: BookingsService, private refunds: RefundsService,
    private outbox: Outbox, private bus: EventBus, private audit: Audit) {
    this.simulator = new SimulatorProvider(db);
    this.providers = { mvola: new MvolaProvider(), orange_money: new OrangeMoneyProvider(), airtel_money: new AirtelMoneyProvider() };
  }
  onModuleDestroy() { for (const t of this.timers) clearTimeout(t); }

  /** Simulateur tant que le moyen de paiement est en mode test sans clés ; sinon l'adaptateur réel (bac à sable ou production). */
  private async resolve(method: string): Promise<{ provider: PaymentProvider; ctx: ProviderCtx; simulated: boolean }> {
    const m = await this.settings.paymentMethod(method);
    if (!m || !m.enabled) throw new AppError('PAYMENT_METHOD_UNAVAILABLE', 409, 'Ce moyen de paiement n\'est pas disponible');
    const secrets = await this.settings.paymentSecrets(method);
    const ctx: ProviderCtx = { mode: m.mode, publicConfig: m.publicConfig || {}, secrets };
    const required = PAYMENT_SECRET_FIELDS[method] ?? [];
    const configured = required.length > 0 && required.every(f => secrets[f]);
    if (!this.providers[method] || (m.mode === 'test' && !configured)) return { provider: this.simulator, ctx, simulated: true };
    if (!configured) throw new AppError('PAYMENT_NOT_CONFIGURED', 503, 'Ce moyen de paiement n\'est pas encore configuré');
    return { provider: this.providers[method], ctx, simulated: false };
  }
  private providerOf(payment: any) { return payment.mode === 'simulated' ? Promise.resolve({ provider: this.simulator as PaymentProvider, ctx: { mode: 'test', publicConfig: {}, secrets: {} } as ProviderCtx, simulated: true }) : this.resolve(payment.method); }

  view(p: any) {
    return { id: p.id, bookingId: p.bookingId, method: p.method, simulated: p.mode === 'simulated', amount: p.amount, currency: p.currency, status: p.status,
      failureReason: p.failureReason, clientAction: p.clientAction, createdAt: p.createdAt, refundedAmount: p.refundedAmount };
  }
  async get(id: string) { const p = await this.db.maybe<any>('SELECT * FROM payments WHERE id = $1', [id]); if (!p) throw new AppError('PAYMENT_NOT_FOUND', 404); return p; }

  // ── Initiation ─────────────────────────────────────────────────────────────
  async initiate(bookingId: string, method: string, payerPhone: string, idempotencyKey: string) {
    const s = await this.settings.get('booking');
    const m = await this.settings.paymentMethod(method);
    if (!m || !m.enabled || !m.online) throw new AppError('PAYMENT_METHOD_UNAVAILABLE', 409, 'Ce moyen de paiement n\'est pas disponible en ligne');
    const { provider, ctx, simulated } = await this.resolve(method);
    const phone = normalizePhone(payerPhone);

    const payment = await this.db.tx(async t => {
      const b = await t.maybe<any>('SELECT * FROM bookings WHERE id = $1 FOR UPDATE', [bookingId]);
      if (!b) throw new AppError('BOOKING_NOT_FOUND', 404);
      if (b.status === 'confirmed') throw new AppError('BOOKING_ALREADY_PAID', 409, 'Cette réservation est déjà payée');
      if (b.status !== 'pending_payment' || new Date(b.expiresAt) < new Date()) throw new AppError('BOOKING_EXPIRED', 409, 'Le délai de paiement est dépassé, veuillez refaire votre réservation');
      // un paiement est déjà en attente : on le renvoie plutôt que de solliciter deux fois le téléphone du client
      const open = await t.maybe<any>(`SELECT * FROM payments WHERE booking_id = $1 AND status IN ('initiated','pending') ORDER BY created_at DESC LIMIT 1`, [bookingId]);
      if (open && open.method === method) return { row: open, reused: true, booking: b };
      if (open) await t.q(`UPDATE payments SET status = 'expired', failure_reason = 'remplacé par un autre moyen de paiement', updated_at = now() WHERE id = $1`, [open.id]);
      const row = await t.insert<any>('payments', { bookingId, method, mode: simulated ? 'simulated' : ctx.mode, amount: b.total, currency: b.currency, payerPhone: phone, idempotencyKey,
        nextCheckAt: new Date(Date.now() + 120000) });
      // le verrou des sièges couvre toute la durée de validation sur le téléphone : personne ne peut prendre le siège entre-temps
      const until = new Date(Math.max(new Date(b.expiresAt).getTime(), Date.now() + s.paymentTimeoutMinutes * 60000));
      await t.q('UPDATE bookings SET expires_at = $2, updated_at = now() WHERE id = $1', [bookingId, until]);
      await t.q(`UPDATE trip_seats SET hold_expires_at = $2, updated_at = now() WHERE booking_id = $1 AND status = 'held'`, [bookingId, until]);
      await t.q(`UPDATE seat_holds SET expires_at = greatest(expires_at, $2) WHERE token IN (SELECT hold_token FROM trip_seats WHERE booking_id = $1 AND hold_token IS NOT NULL)`, [bookingId, until]);
      return { row, reused: false, booking: b };
    });
    if (payment.reused) return this.view(payment.row);

    const p = payment.row, b = payment.booking;
    const base = `${env().apiPublicUrl}/api/v1/payments/webhooks/${method}/${p.id}/${webhookSignature(method, p.id)}`;
    const back = `${env().publicUrl}/booking/${b.reference}?t=${bookingAccessToken(b.id)}`;
    try {
      const r = await provider.initiate({ paymentId: p.id, amount: p.amount, currency: p.currency, payerPhone: phone, description: `Billet ${b.reference}`, reference: b.reference,
        callbackUrl: base, returnUrl: back, cancelUrl: back + '&cancelled=1' }, ctx);
      const up = await this.db.one<any>(
        `UPDATE payments SET provider_ref = $2, status = CASE WHEN status = 'initiated' THEN 'pending' ELSE status END, client_action = $3, raw_last_status = $4,
                next_check_at = now() + interval '15 seconds', updated_at = now() WHERE id = $1 RETURNING *`,
        [p.id, r.providerRef, JSON.stringify(r.clientAction), JSON.stringify(r.raw ?? null)]);
      if (simulated && process.env.SIM_AUTO !== 'false') this.scheduleSimCheck(p.id);
      this.emit(up, b);
      return this.view(up);
    } catch (e: any) {
      const reason = e instanceof AppError ? e.message : 'Erreur technique';
      await this.db.q(`UPDATE payments SET status = 'failed', failure_reason = $2, next_check_at = NULL, updated_at = now() WHERE id = $1 AND status = 'initiated'`, [p.id, reason]);
      if (!(e instanceof AppError)) logger.error({ err: e, paymentId: p.id }, 'échec d\'initiation du paiement');
      throw e instanceof AppError ? e : new AppError('PAYMENT_PROVIDER_ERROR', 502, 'Le paiement n\'a pas pu être lancé, réessayez');
    }
  }
  /** En simulation, joue le rôle du callback de l'opérateur : revérifie le paiement quand il est « prêt ». */
  private scheduleSimCheck(paymentId: string) {
    const delay = Number(process.env.SIM_DELAY_MS || 3000) + 150;
    const timer = setTimeout(() => { this.timers.delete(timer); this.checkOne(paymentId).catch(() => {}); }, delay);
    timer.unref?.(); this.timers.add(timer);
  }
  private emit(p: any, b: any) {
    const payload = { paymentId: p.id, bookingId: b.id, reference: b.reference, status: p.status, failureReason: p.failureReason ?? null };
    this.bus.emit(`booking:${b.id}`, 'payment.updated', payload);
    if (b.customerId) this.bus.emit(`user:${b.customerId}`, 'payment.updated', payload);
  }

  // ── Callbacks des opérateurs ───────────────────────────────────────────────
  async handleWebhook(method: string, paymentId: string, signature: string, body: any, headers: any) {
    if (!safeEqual(signature || '', webhookSignature(method, paymentId))) throw new AppError('WEBHOOK_SIGNATURE_INVALID', 401);
    const payment = await this.db.maybe<any>('SELECT * FROM payments WHERE id = $1 AND method = $2', [paymentId, method]);
    if (!payment) throw new AppError('PAYMENT_NOT_FOUND', 404);
    const { provider, ctx } = await this.providerOf(payment);
    const ev = provider.parseWebhook(body, headers);
    if (ev.providerRef && payment.providerRef && ev.providerRef !== payment.providerRef) throw new AppError('WEBHOOK_INVALID', 400, 'Référence de transaction incohérente');
    // dédoublonnage : un même callback reçu deux fois n'est traité qu'une fois
    const fresh = await this.db.maybe(
      `INSERT INTO payment_events (provider, event_key, payment_id, payload) VALUES ($1,$2,$3,$4) ON CONFLICT (event_key) DO NOTHING RETURNING id`,
      [provider.code, ev.eventKey, paymentId, JSON.stringify(body ?? {})]);
    if (!fresh) return { ok: true, duplicate: true };
    let status: ProviderStatus = ev.status, raw: any = body;
    if (!provider.trustWebhook) {
      // on ne croit jamais le contenu d'un callback non signé : le statut est redemandé à l'opérateur
      try { const r = await provider.status(payment, ctx); status = r.status; raw = r.raw ?? raw; }
      catch { await this.db.q(`UPDATE payments SET next_check_at = now() WHERE id = $1 AND status IN ('initiated','pending')`, [paymentId]); return { ok: true, deferred: true }; }
    }
    const result = await this.applyStatus(paymentId, status, raw);
    await this.db.q('UPDATE payment_events SET processed_at = now(), result = $2 WHERE event_key = $1', [ev.eventKey, result]);
    return { ok: true, result };
  }

  /**
   * Machine à états d'un paiement. Un paiement réussi ou remboursé ne revient jamais en arrière,
   * quel que soit l'ordre d'arrivée des callbacks. Idempotent.
   */
  async applyStatus(paymentId: string, status: ProviderStatus, raw?: any): Promise<string> {
    let out = 'ignored'; let snapshot: any = null, bookingSnap: any = null;
    await this.db.tx(async t => {
      const p = await t.maybe<any>('SELECT * FROM payments WHERE id = $1 FOR UPDATE', [paymentId]);
      if (!p) throw new AppError('PAYMENT_NOT_FOUND', 404);
      if (['succeeded', 'refund_pending', 'refunded', 'partially_refunded'].includes(p.status)) { out = 'already_final'; return; }
      if (status === 'pending') { out = 'pending'; return; }
      if (status === 'failed') {
        if (!['initiated', 'pending'].includes(p.status)) { out = 'ignored'; return; }
        snapshot = await t.one<any>(`UPDATE payments SET status = 'failed', failure_reason = coalesce($2, 'Paiement refusé ou annulé'), raw_last_status = coalesce($3, raw_last_status), next_check_at = NULL, updated_at = now() WHERE id = $1 RETURNING *`,
          [paymentId, raw?.failureReason ?? null, raw ? JSON.stringify(raw) : null]);
        bookingSnap = await t.one<any>('SELECT * FROM bookings WHERE id = $1', [p.bookingId]);
        out = 'failed'; return;
      }
      // ── succès ──
      snapshot = await t.one<any>(`UPDATE payments SET status = 'succeeded', failure_reason = NULL, succeeded_at = now(), raw_last_status = coalesce($2, raw_last_status), next_check_at = NULL, updated_at = now() WHERE id = $1 RETURNING *`,
        [paymentId, raw ? JSON.stringify(raw) : null]);
      const b = await t.one<any>('SELECT * FROM bookings WHERE id = $1 FOR UPDATE', [p.bookingId]);
      bookingSnap = b;
      const otherPaid = await t.maybe(`SELECT 1 FROM payments WHERE booking_id = $1 AND id <> $2 AND status IN ('succeeded','partially_refunded')`, [b.id, paymentId]);
      if (b.status === 'confirmed' && otherPaid) {   // le client a payé deux fois (deux moyens, deux validations) : le doublon est remboursé
        await this.refunds.scheduleForPayment(t, paymentId, 'duplicate_payment');
        await this.bookings.notifyBooking(t, b, 'payment_refund', false, { refund_amount: p.amount, refund_reason: 'paiement en double' });
        snapshot.status = 'refund_pending'; out = 'duplicate_refunded'; return;
      }
      const r = await this.bookings.confirmPaid(t, b);
      if (r.ok) { out = 'confirmed'; return; }
      // paiement arrivé trop tard : le siège a été revendu, le voyage est annulé ou parti → remboursement automatique, jamais de double vente
      const amount = await this.refunds.scheduleForPayment(t, paymentId, r.reason);
      if (!(b.status === 'cancelled' && !['abandoned', 'replaced', 'payment_timeout'].includes(b.cancelReason)))
        await t.q(`UPDATE bookings SET status = 'cancelled', cancel_reason = $2, cancelled_at = coalesce(cancelled_at, now()), updated_at = now() WHERE id = $1`, [b.id, r.reason]);
      await t.q(`DELETE FROM trip_seats WHERE booking_id = $1 AND status = 'held'`, [b.id]);
      await this.bookings.notifyBooking(t, b, 'payment_refund', false, { refund_amount: amount, refund_reason: r.reason === 'seat_lost' ? 'siège plus disponible' : r.reason === 'trip_cancelled' ? 'voyage annulé' : 'réservation expirée' });
      await this.audit.log({ category: 'bookings', action: 'Paiement tardif remboursé', severity: 'warning', targetType: 'booking', targetId: b.id, targetName: b.reference, details: `Motif : ${r.reason} · montant ${amount}` }, t);
      t.afterCommit(() => { this.bus.emit('staff', 'alert', { type: 'late_payment_refunded', bookingId: b.id, reference: b.reference, reason: r.reason, amount }); this.bookings.emitBooking(b, 'booking.cancelled', 'cancelled', { reason: r.reason, refundAmount: amount }); });
      snapshot.status = 'refund_pending'; out = 'refunded_' + r.reason;
    });
    if (snapshot && bookingSnap) this.emit(snapshot, bookingSnap);
    return out;
  }

  // ── Rapprochement périodique (callback perdu, en retard, serveur redémarré) ─
  async checkOne(paymentId: string): Promise<string> {
    const p = await this.db.maybe<any>(`SELECT * FROM payments WHERE id = $1 AND status IN ('initiated','pending','expired','failed')`, [paymentId]);
    if (!p || !p.providerRef) return 'skipped';
    const { provider, ctx } = await this.providerOf(p);
    const r = await provider.status(p, ctx);
    return this.applyStatus(p.id, r.status, r.raw);
  }
  async reconcile(limit = 50): Promise<{ checked: number; changed: number }> {
    const due = await this.db.q<any>(
      `UPDATE payments SET attempts = attempts + 1, next_check_at = now() + interval '5 minutes'
        WHERE id IN (SELECT id FROM payments WHERE status IN ('initiated','pending') AND next_check_at <= now() ORDER BY next_check_at LIMIT $1 FOR UPDATE SKIP LOCKED)
        RETURNING *`, [limit]);
    let changed = 0;
    for (const p of due) {
      const ageSec = (Date.now() - new Date(p.createdAt).getTime()) / 1000;
      try {
        if (!p.providerRef) {   // le serveur s'est arrêté entre l'enregistrement et l'appel à l'opérateur : rien n'a été débité
          if (ageSec > 120) { await this.db.q(`UPDATE payments SET status = 'expired', failure_reason = 'paiement non transmis', next_check_at = NULL WHERE id = $1 AND status = 'initiated'`, [p.id]); changed++; }
          continue;
        }
        const res = await this.checkOne(p.id);
        if (res !== 'pending' && res !== 'skipped') { changed++; continue; }
        if (ageSec > 86400) {   // 24 h sans réponse : on abandonne (un succès tardif resterait accepté par applyStatus)
          await this.db.q(`UPDATE payments SET status = 'expired', failure_reason = 'aucune réponse de l''opérateur', next_check_at = NULL WHERE id = $1 AND status IN ('initiated','pending')`, [p.id]);
          changed++; continue;
        }
        const wait = BACKOFF_SEC[Math.min(p.attempts - 1, BACKOFF_SEC.length)] ?? 900;
        await this.db.q(`UPDATE payments SET next_check_at = now() + ($2 || ' seconds')::interval WHERE id = $1 AND status IN ('initiated','pending')`, [p.id, String(wait)]);
      } catch (e: any) {
        logger.warn({ paymentId: p.id, err: e?.message }, 'rapprochement : opérateur injoignable, nouvel essai plus tard');
        await this.db.q(`UPDATE payments SET next_check_at = now() + interval '60 seconds' WHERE id = $1 AND status IN ('initiated','pending')`, [p.id]);
      }
    }
    return { checked: due.length, changed };
  }

  // ── Remboursements ─────────────────────────────────────────────────────────
  /** Exécute les remboursements en attente. Automatique si l'opérateur le permet, sinon « à faire manuellement » (visible au back-office). */
  async processRefunds(limit = 20): Promise<number> {
    const due = await this.db.q<any>(
      `UPDATE refunds SET status = 'processing', attempts = attempts + 1
        WHERE id IN (SELECT id FROM refunds WHERE status = 'pending' ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED) RETURNING *`, [limit]);
    for (const r of due) {
      const p = await this.db.one<any>('SELECT * FROM payments WHERE id = $1', [r.paymentId]);
      try {
        if (p.method === 'cash') { await this.db.q(`UPDATE refunds SET status = 'manual', last_error = 'Espèces : à rendre au guichet' WHERE id = $1`, [r.id]); this.alertManual(r); continue; }
        const { provider, ctx } = await this.providerOf(p);
        const res = provider.refund ? await provider.refund(p, r.amount, ctx) : { ok: false, error: 'remboursement automatique non proposé par cet opérateur' };
        if (res.ok) await this.completeRefund(r.id, (res as any).providerRef ?? null, null);
        else { await this.db.q(`UPDATE refunds SET status = 'manual', last_error = $2 WHERE id = $1`, [r.id, res.error ?? 'refus']); this.alertManual(r); }
      } catch (e: any) {
        // panne passagère : on réessaie 5 fois avant de demander une intervention manuelle
        await this.db.q(`UPDATE refunds SET status = CASE WHEN attempts >= 5 THEN 'manual' ELSE 'pending' END, last_error = $2 WHERE id = $1`, [r.id, String(e?.message || e).slice(0, 300)]);
      }
    }
    return due.length;
  }
  private alertManual(r: any) { this.bus.emit('staff', 'alert', { type: 'manual_refund', refundId: r.id, bookingId: r.bookingId, amount: r.amount }); }
  async completeRefund(refundId: string, providerRef: string | null, staff: AuthUser | null) {
    await this.db.tx(async t => {
      const r = await t.maybe<any>(`SELECT * FROM refunds WHERE id = $1 FOR UPDATE`, [refundId]);
      if (!r) throw new AppError('REFUND_NOT_FOUND', 404);
      if (r.status === 'succeeded') return;
      await t.q(`UPDATE refunds SET status = 'succeeded', provider_ref = $2, processed_at = now(), last_error = NULL WHERE id = $1`, [refundId, providerRef]);
      const p = await t.one<any>(`UPDATE payments SET refunded_amount = refunded_amount + $2, updated_at = now() WHERE id = $1 RETURNING *`, [r.paymentId, r.amount]);
      const open = await t.maybe(`SELECT 1 FROM refunds WHERE payment_id = $1 AND status IN ('pending','processing','manual')`, [p.id]);
      await t.q('UPDATE payments SET status = $2 WHERE id = $1', [p.id, open ? 'refund_pending' : p.refundedAmount >= p.amount ? 'refunded' : 'partially_refunded']);
      if (staff) await this.audit.log({ actor: staff, category: 'bookings', action: 'Remboursement effectué', severity: 'success', targetType: 'refund', targetId: refundId, details: `Montant ${r.amount}` }, t);
    });
  }
  async listRefunds(status: string, page: number, limit: number, offset: number) {
    const total = (await this.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM refunds WHERE ($1 = '' OR status = $1)`, [status])).n;
    const items = await this.db.q(
      `SELECT r.*, b.reference, b.contact_name, b.contact_phone, p.method, p.payer_phone
         FROM refunds r JOIN bookings b ON b.id = r.booking_id JOIN payments p ON p.id = r.payment_id
        WHERE ($1 = '' OR r.status = $1) ORDER BY r.created_at DESC LIMIT $2 OFFSET $3`, [status, limit, offset]);
    return { items, total, page, limit };
  }
}
