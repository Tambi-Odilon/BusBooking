import { All, Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentUser, OptionalAuth, Public, RateLimit, RequirePermission } from '../../common/auth';
import { Api, ZBody, zId, zPhone } from '../../common/zod';
import { paging } from '../../common/db';
import { Idempotency } from '../../common/idempotency';
import { BookingsService } from '../booking/bookings.service';
import { PaymentsService } from './payments.service';

const initSchema = z.strictObject({ reference: z.string().min(3).max(40), method: z.string().min(2).max(40), payerPhone: zPhone });

@ApiTags('Paiements')
@Controller('payments')
export class PaymentsController {
  constructor(private payments: PaymentsService, private bookings: BookingsService, private idem: Idempotency) {}

  @OptionalAuth() @RateLimit('pay', 20, 60) @HttpCode(200) @Post() @Api('Lancer le paiement d\'une réservation (en-tête Idempotency-Key requis)', initSchema)
  async initiate(@ZBody(initSchema) b: any, @Headers() h: any, @CurrentUser() u: AuthUser | null) {
    const key = Idempotency.key(h);
    const booking = await this.bookings.authorize(b.reference, { user: u }, h['x-booking-token']);
    return this.idem.run(`payment:${booking.id}`, key, b, () => this.payments.initiate(booking.id, b.method, b.payerPhone, key));
  }
  @OptionalAuth() @Get(':id') @Api('Statut d\'un paiement')
  async get(@Param('id') id: string, @Headers() h: any, @Query('reference') reference: string, @CurrentUser() u: AuthUser | null) {
    const p = await this.payments.get(zId.parse(id));
    const b = await this.bookings.authorize(reference, { user: u }, h['x-booking-token']);
    if (b.id !== p.bookingId) await this.bookings.authorize('', { user: null });   // 404
    return this.payments.view(p);
  }
  /** Point d'entrée des opérateurs. Réponse 200 même pour un doublon : l'opérateur ne doit pas renvoyer indéfiniment. */
  @Public() @RateLimit('webhook', 600, 60) @HttpCode(200) @All('webhooks/:method/:paymentId/:signature') @Api('Callback opérateur (MVola, Orange Money, Airtel Money)')
  webhook(@Param('method') method: string, @Param('paymentId') paymentId: string, @Param('signature') signature: string, @Body() body: any, @Headers() h: any) {
    return this.payments.handleWebhook(method, zId.parse(paymentId), signature, body, h);
  }
}

@ApiTags('Administration · remboursements')
@Controller('admin/refunds')
export class RefundsAdminController {
  constructor(private payments: PaymentsService) {}
  @RequirePermission('canRefund', 'canViewRevenue') @Get() @Api('Remboursements (filtre par statut : pending, manual, succeeded…)')
  list(@Query() q: any) { const { page, limit, offset } = paging(q); return this.payments.listRefunds(String(q.status || ''), page, limit, offset); }
  @RequirePermission('canRefund') @HttpCode(200) @Post(':id/mark-done') @Api('Marquer un remboursement manuel comme effectué')
  async done(@Param('id') id: string, @ZBody(z.strictObject({ providerRef: z.string().max(80).optional() })) b: any, @CurrentUser() u: AuthUser) {
    await this.payments.completeRefund(zId.parse(id), b.providerRef ?? null, u); return { ok: true };
  }
}
