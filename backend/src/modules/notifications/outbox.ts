import { Injectable } from '@nestjs/common';
import { Db, Queryable } from '../../common/db';

export interface OutboxMessage {
  channel: 'email' | 'sms'; to: string; template: string; lang?: string;
  vars?: Record<string, any>; attachBookingId?: string;
}
/**
 * Boîte d'envoi transactionnelle : le message est enregistré dans la même transaction que l'opération métier,
 * puis envoyé par le worker. Un e-mail n'est donc jamais envoyé pour une opération annulée, ni perdu si le SMTP est en panne.
 */
@Injectable()
export class Outbox {
  constructor(private db: Db) {}
  async enqueue(m: OutboxMessage, t: Queryable = this.db) {
    if (!m.to) return;
    await t.q(`INSERT INTO notifications_outbox (channel, recipient, template, lang, vars, attach_booking_id) VALUES ($1,$2,$3,$4,$5,$6)`,
      [m.channel, m.to, m.template, m.lang || 'fr', JSON.stringify(m.vars ?? {}), m.attachBookingId ?? null]);
  }
}
