import { Injectable } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { Db } from '../../common/db';
import { AppError } from '../../common/errors';
import { logger } from '../../common/logger';
import { SettingsService } from '../settings/settings.service';
import { TicketsService, formatMoney } from '../tickets/tickets.service';
import { DEFAULT_TEMPLATES, Template } from './templates';

const esc = (s: any) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const MONEY_VARS = ['total', 'refund_amount'];
export interface SmtpConfig { host: string; port: number; secure: boolean; user: string; password: string; fromName: string; fromEmail: string; replyTo?: string }

/** Retire scripts, gestionnaires d'événements et URL javascript: d'un modèle saisi par un administrateur. */
export function sanitizeHtml(html: string): string {
  return html.replace(/<\s*(script|style|iframe|object|embed|form|link|meta)[\s\S]*?(<\s*\/\s*\1\s*>|\/?>)/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '').replace(/(href|src)\s*=\s*(["']?)\s*javascript:[^"'>\s]*/gi, '$1=$2#');
}

@Injectable()
export class NotificationsService {
  constructor(private db: Db, private settings: SettingsService, private tickets: TicketsService) {}

  async template(code: string, lang: string): Promise<Template> {
    const row = await this.db.maybe<any>(`SELECT subject, body_html, body_text FROM email_templates WHERE code = $1 AND lang = ANY($2::text[]) ORDER BY (lang = $3) DESC LIMIT 1`, [code, [lang, 'fr'], lang]);
    const def = DEFAULT_TEMPLATES[code]?.[lang] ?? DEFAULT_TEMPLATES[code]?.fr;
    if (row) return { subject: row.subject, body: sanitizeHtml(row.bodyHtml), sms: row.bodyText || def?.sms };
    if (!def) throw new AppError('TEMPLATE_NOT_FOUND', 404, `Modèle inconnu : ${code}`);
    return def;
  }
  /** Remplace {{variable}}. Les valeurs sont échappées en HTML : un nom de passager ne peut pas injecter de balise. */
  async render(code: string, lang: string, vars: Record<string, any>) {
    const s = await this.settings.all();
    const all: Record<string, any> = {
      company_name: s.identity.name, company_phone: s.contact.phones[0] || '', company_email: s.contact.email, company_website: s.contact.website, ...vars };
    for (const k of MONEY_VARS) if (typeof all[k] === 'number') all[k] = formatMoney(all[k], s.locale);
    const t = await this.template(code, lang);
    const fill = (str: string, html: boolean) => str.replace(/\{\{\s*([a-z_0-9]+)\s*\}\}/gi, (_, k) => html ? esc(all[k]) : String(all[k] ?? ''));
    const inner = fill(t.body, true);
    const color = s.identity.primaryColor;
    const html = `<!doctype html><html><body style="margin:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;color:#0f172a">
<style>.btn{display:inline-block;background:${color};color:#fff !important;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:bold}.recap td{padding:6px 14px 6px 0;font-size:14px}p{line-height:1.55;font-size:15px}</style>
<div style="max-width:560px;margin:0 auto;padding:16px"><div style="background:${color};color:#fff;padding:20px 24px;border-radius:12px 12px 0 0;font-size:20px;font-weight:bold">${esc(s.identity.name)}</div>
<div style="background:#fff;padding:24px;border-radius:0 0 12px 12px">${inner}</div>
<div style="text-align:center;color:#64748b;font-size:12px;padding:14px">${esc([s.identity.legalName || s.identity.name, s.contact.address, s.contact.phones[0]].filter(Boolean).join(' · '))}</div></div></body></html>`;
    const text = inner.replace(/<a [^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi, '$2 : $1').replace(/<\/(p|tr|div)>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n\s+/g, '\n').trim();
    return { subject: fill(t.subject, false), html, text, sms: t.sms ? fill(t.sms, false).slice(0, 320) : '' };
  }

  private async smtp(): Promise<SmtpConfig | null> {
    const n = (await this.settings.get('notifications')).email;
    const id = await this.settings.get('identity');
    const contact = await this.settings.get('contact');
    if (!n.enabled || !n.host) return null;
    return { host: n.host, port: n.port, secure: n.secure, user: n.user, password: (await this.settings.getSecret('smtp.password')) || '',
      fromName: n.fromName || id.name, fromEmail: n.fromEmail || contact.ticketsEmail || contact.email || n.user, replyTo: n.replyTo || undefined };
  }
  private transport(c: SmtpConfig) {
    return nodemailer.createTransport({ host: c.host, port: c.port, secure: c.secure, auth: c.user ? { user: c.user, pass: c.password } : undefined,
      connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000, tls: { rejectUnauthorized: process.env.SMTP_ALLOW_SELF_SIGNED !== 'true' } });
  }
  /** Bouton « Envoyer un e-mail de test » (assistant et paramètres). Lève une erreur lisible si le serveur refuse. */
  async sendTest(to: string, override?: Partial<SmtpConfig>) {
    const base = await this.smtp();
    const c = { ...(base ?? { host: '', port: 587, secure: false, user: '', password: '', fromName: (await this.settings.get('identity')).name, fromEmail: '' }), ...Object.fromEntries(Object.entries(override ?? {}).filter(([, v]) => v !== undefined && v !== '')) } as SmtpConfig;
    if (!c.host) throw new AppError('SMTP_NOT_CONFIGURED', 400, 'Indiquez au moins le serveur SMTP');
    if (!c.fromEmail) c.fromEmail = c.user;
    const r = await this.render('test', 'fr', {});
    try { await this.transport(c).sendMail({ from: { name: c.fromName, address: c.fromEmail }, to, subject: r.subject, html: r.html, text: r.text }); }
    catch (e: any) { throw new AppError('SMTP_TEST_FAILED', 400, `Envoi refusé par le serveur : ${String(e?.message || e).slice(0, 200)}`); }
    return { ok: true };
  }

  private async sendSms(to: string, message: string): Promise<'sent' | 'simulated'> {
    const n = (await this.settings.get('notifications')).sms;
    if (!n.enabled || n.provider !== 'http' || !n.httpUrl) return 'simulated';
    const key = (await this.settings.getSecret('sms.apiKey')) || '';
    const fill = (s: string, enc: (v: string) => string) => s.replace(/\{\{to\}\}/g, enc(to)).replace(/\{\{message\}\}/g, enc(message)).replace(/\{\{sender\}\}/g, enc(n.senderId));
    const jsonEsc = (v: string) => JSON.stringify(v).slice(1, -1);
    const res = await fetch(fill(n.httpUrl, encodeURIComponent), {
      method: n.httpMethod, signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json', ...(key ? { [n.authHeader || 'Authorization']: key } : {}) },
      body: n.httpMethod === 'POST' ? fill(n.httpBodyTemplate, jsonEsc) : undefined });
    if (!res.ok) throw new Error(`passerelle SMS : HTTP ${res.status}`);
    return 'sent';
  }

  /** Worker : envoie les messages en attente. Reprise automatique avec délai croissant (5 essais). */
  async processOutbox(limit = 20): Promise<number> {
    const due = await this.db.q<any>(
      `UPDATE notifications_outbox SET status = 'sending', attempts = attempts + 1
        WHERE id IN (SELECT id FROM notifications_outbox WHERE status = 'pending' AND next_attempt_at <= now() ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED) RETURNING *`, [limit]);
    for (const m of due) {
      try {
        const r = await this.render(m.template, m.lang, m.vars || {});
        let status: 'sent' | 'simulated';
        if (m.channel === 'sms') status = await this.sendSms(m.recipient, r.sms || r.subject);
        else {
          const c = await this.smtp();
          if (!c) status = 'simulated';
          else {
            const attachments: any[] = [];
            if (m.attachBookingId) { try { attachments.push({ filename: `billet-${m.vars?.reference || 'voyage'}.pdf`, content: await this.tickets.pdf(m.attachBookingId), contentType: 'application/pdf' }); } catch { /* réservation annulée entre-temps : e-mail envoyé sans billet */ } }
            await this.transport(c).sendMail({ from: { name: c.fromName, address: c.fromEmail }, replyTo: c.replyTo, to: m.recipient, subject: r.subject, html: r.html, text: r.text, attachments });
            status = 'sent';
          }
        }
        await this.db.q(`UPDATE notifications_outbox SET status = $2, subject = $3, body = $4, sent_at = now(), last_error = NULL WHERE id = $1`, [m.id, status, r.subject, m.channel === 'sms' ? r.sms : r.text]);
      } catch (e: any) {
        const final = m.attempts >= 5;
        if (final) logger.error({ outboxId: m.id, err: e?.message }, 'notification abandonnée après 5 essais');
        await this.db.q(`UPDATE notifications_outbox SET status = $2, last_error = $3, next_attempt_at = now() + ($4 || ' seconds')::interval WHERE id = $1`,
          [m.id, final ? 'failed' : 'pending', String(e?.message || e).slice(0, 500), String(Math.min(3600, 30 * Math.pow(4, m.attempts - 1)))]);
      }
    }
    return due.length;
  }
}
