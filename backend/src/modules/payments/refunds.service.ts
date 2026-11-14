import { Injectable } from '@nestjs/common';
import { Queryable } from '../../common/db';

/** Création des remboursements (l'exécution réelle est faite par PaymentsService.processRefunds). */
@Injectable()
export class RefundsService {
  /**
   * Programme le remboursement de `amount` sur les paiements réussis d'une réservation (du plus récent au plus ancien).
   * Ne rembourse jamais plus que ce qui a été encaissé. Renvoie le montant effectivement programmé.
   */
  async schedule(t: Queryable, bookingId: string, amount: number, reason: string, requestedBy: string | null): Promise<number> {
    if (amount <= 0) return 0;
    const pays = await t.q<any>(
      `SELECT p.id, p.amount, p.refunded_amount,
              coalesce((SELECT sum(r.amount) FROM refunds r WHERE r.payment_id = p.id AND r.status IN ('pending','processing','manual')), 0)::bigint AS pending
         FROM payments p WHERE p.booking_id = $1 AND p.status IN ('succeeded','refund_pending','partially_refunded') ORDER BY p.succeeded_at DESC FOR UPDATE OF p`, [bookingId]);
    let left = amount, total = 0;
    for (const p of pays) {
      const room = p.amount - p.refundedAmount - p.pending;
      const take = Math.min(room, left);
      if (take <= 0) continue;
      await t.q(`INSERT INTO refunds (payment_id, booking_id, amount, reason, requested_by) VALUES ($1,$2,$3,$4,$5)`, [p.id, bookingId, take, reason, requestedBy]);
      await t.q(`UPDATE payments SET status = 'refund_pending', updated_at = now() WHERE id = $1`, [p.id]);
      left -= take; total += take;
      if (left <= 0) break;
    }
    return total;
  }
  /** Rembourse intégralement un paiement précis (doublon, siège perdu…). */
  async scheduleForPayment(t: Queryable, paymentId: string, reason: string): Promise<number> {
    const p = await t.one<any>(`SELECT id, booking_id, amount, refunded_amount FROM payments WHERE id = $1 FOR UPDATE`, [paymentId]);
    const pending = (await t.one<{ s: number }>(`SELECT coalesce(sum(amount),0)::bigint AS s FROM refunds WHERE payment_id = $1 AND status IN ('pending','processing','manual')`, [paymentId])).s;
    const amount = p.amount - p.refundedAmount - pending;
    if (amount <= 0) return 0;
    await t.q(`INSERT INTO refunds (payment_id, booking_id, amount, reason) VALUES ($1,$2,$3,$4)`, [p.id, p.bookingId, amount, reason]);
    await t.q(`UPDATE payments SET status = 'refund_pending', updated_at = now() WHERE id = $1`, [p.id]);
    return amount;
  }
}
