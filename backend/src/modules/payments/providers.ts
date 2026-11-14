import { Db } from '../../common/db';
import { AppError } from '../../common/errors';
import { hmac, safeEqual } from '../../common/crypto';
import { env } from '../../common/env';

export type ProviderStatus = 'pending' | 'succeeded' | 'failed';
export interface ProviderCtx { mode: 'test' | 'live'; publicConfig: any; secrets: Record<string, string> }
export interface InitiateInput { paymentId: string; amount: number; currency: string; payerPhone: string; description: string; reference: string; callbackUrl: string; returnUrl: string; cancelUrl: string }
export interface InitiateResult { providerRef: string; status: ProviderStatus; clientAction: { type: 'ussd_push' | 'redirect' | 'none'; url?: string; message?: string }; raw?: any }
export interface WebhookEvent { providerRef?: string; paymentId?: string; status: ProviderStatus; eventKey: string }
export interface PaymentProvider {
  code: string;
  /** vrai : le contenu du callback fait foi (signature vérifiée). faux : on reconfirme toujours le statut auprès de l'opérateur. */
  trustWebhook: boolean;
  initiate(i: InitiateInput, ctx: ProviderCtx): Promise<InitiateResult>;
  status(payment: any, ctx: ProviderCtx): Promise<{ status: ProviderStatus; raw?: any }>;
  parseWebhook(body: any, headers: any): WebhookEvent;
  refund?(payment: any, amount: number, ctx: ProviderCtx): Promise<{ ok: boolean; providerRef?: string; error?: string }>;
}

async function http(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<any> {
  let res: Response;
  try { res = await fetch(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? 15000) }); }
  catch (e: any) { throw new AppError('PAYMENT_PROVIDER_UNREACHABLE', 502, 'L\'opérateur de paiement ne répond pas, réessayez dans un instant', { cause: e?.name }); }
  const text = await res.text();
  let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { /* réponse non JSON */ }
  if (!res.ok) throw new AppError('PAYMENT_PROVIDER_ERROR', 502, 'L\'opérateur de paiement a refusé la demande', { httpStatus: res.status, body: json ?? text.slice(0, 300) });
  return json;
}
const localMsisdn = (p: string) => p.replace(/\D/g, '').replace(/^261/, '0').replace(/^(?!0)/, '0');
const need = (ctx: ProviderCtx, ...keys: string[]) => { for (const k of keys) if (!ctx.secrets[k]) throw new AppError('PAYMENT_NOT_CONFIGURED', 503, 'Ce moyen de paiement n\'est pas encore configuré'); };

// ─────────────────────────────────────────────────────────────────────────────
// Simulateur : utilisé tant qu'aucune clé n'est saisie pour un moyen de paiement en mode test.
// Le numéro du payeur pilote le scénario : …0000 refus · …0001 aucune réponse · …0002 succès tardif · autre : succès.
// ─────────────────────────────────────────────────────────────────────────────
export class SimulatorProvider implements PaymentProvider {
  code = 'simulator'; trustWebhook = true;
  constructor(private db: Db) {}
  static sign(providerRef: string, status: string, eventId: string) { return hmac(`sim:${providerRef}:${status}:${eventId}`, env().webhookSecret); }
  async initiate(i: InitiateInput): Promise<InitiateResult> {
    const tail = i.payerPhone.replace(/\D/g, '').slice(-4);
    const scenario = tail === '0000' ? 'fail' : tail === '0001' ? 'never' : tail === '0002' ? 'late' : 'success';
    const delayMs = scenario === 'late' ? Number(process.env.SIM_LATE_MS || 900000) : Number(process.env.SIM_DELAY_MS || 3000);
    const ref = 'SIM-' + i.paymentId.replace(/-/g, '').slice(0, 16).toUpperCase();
    await this.db.q(`INSERT INTO payment_simulations (provider_ref, method, amount, scenario, final_status, ready_at) VALUES ($1,$2,$3,$4,$5, now() + ($6 || ' milliseconds')::interval)`,
      [ref, 'simulator', i.amount, scenario, scenario === 'fail' ? 'failed' : scenario === 'never' ? 'pending' : 'succeeded', String(delayMs)]);
    return { providerRef: ref, status: 'pending', clientAction: { type: 'ussd_push', message: 'MODE SIMULATION — aucun débit réel. Le paiement sera validé automatiquement dans quelques secondes.' } };
  }
  async status(payment: any) {
    const s = await this.db.maybe<any>('SELECT final_status, (ready_at <= now()) AS ready FROM payment_simulations WHERE provider_ref = $1', [payment.providerRef]);
    return { status: (s && s.ready ? s.finalStatus : 'pending') as ProviderStatus, raw: { simulated: true } };
  }
  parseWebhook(body: any, headers: any): WebhookEvent {
    const { providerRef, status, eventId } = body || {};
    if (!providerRef || !['succeeded', 'failed', 'pending'].includes(status) || !eventId) throw new AppError('WEBHOOK_INVALID', 400);
    if (!safeEqual(String(headers['x-sim-signature'] || ''), SimulatorProvider.sign(providerRef, status, eventId))) throw new AppError('WEBHOOK_SIGNATURE_INVALID', 401);
    return { providerRef, status, eventKey: `simulator:${eventId}` };
  }
  async refund() { return { ok: true, providerRef: 'SIM-REFUND-' + Date.now() }; }
}

// ─────────────────────────────────────────────────────────────────────────────
// MVola (Telma) — écrit d'après la documentation publique developer.mvola.mg. À VALIDER en bac à sable avec des identifiants marchands.
// ─────────────────────────────────────────────────────────────────────────────
export class MvolaProvider implements PaymentProvider {
  code = 'mvola'; trustWebhook = false;
  private base = (c: ProviderCtx) => c.mode === 'live' ? 'https://api.mvola.mg' : 'https://devapi.mvola.mg';
  private async token(c: ProviderCtx): Promise<string> {
    need(c, 'consumerKey', 'consumerSecret');
    const r = await http(this.base(c) + '/token', { method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(`${c.secrets.consumerKey}:${c.secrets.consumerSecret}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
      body: 'grant_type=client_credentials&scope=EXT_INT_MVOLA_SCOPE' });
    if (!r?.access_token) throw new AppError('PAYMENT_PROVIDER_ERROR', 502, 'Authentification MVola refusée');
    return r.access_token;
  }
  private headers(c: ProviderCtx, token: string, correlationId: string, extra: Record<string, string> = {}) {
    return { Authorization: `Bearer ${token}`, Version: '1.0', 'X-CorrelationID': correlationId, UserLanguage: 'FR',
      UserAccountIdentifier: `msisdn;${localMsisdn(c.publicConfig.merchantNumber || '')}`, partnerName: c.publicConfig.partnerName || 'Marchand',
      'Content-Type': 'application/json', 'Cache-Control': 'no-cache', ...extra };
  }
  async initiate(i: InitiateInput, c: ProviderCtx): Promise<InitiateResult> {
    if (!c.publicConfig.merchantNumber) throw new AppError('PAYMENT_NOT_CONFIGURED', 503, 'Numéro marchand MVola manquant');
    const token = await this.token(c);
    const r = await http(this.base(c) + '/mvola/mm/transactions/type/merchantpay/1.0.0/', { method: 'POST',
      headers: this.headers(c, token, i.paymentId, { 'X-Callback-URL': i.callbackUrl }),
      body: JSON.stringify({
        amount: String(i.amount), currency: 'Ar', descriptionText: i.description.replace(/[^A-Za-z0-9 ._,-]/g, ' ').slice(0, 50),
        requestingOrganisationTransactionReference: i.reference, requestDate: new Date().toISOString(), originalTransactionReference: '',
        debitParty: [{ key: 'msisdn', value: localMsisdn(i.payerPhone) }], creditParty: [{ key: 'msisdn', value: localMsisdn(c.publicConfig.merchantNumber) }],
        metadata: [{ key: 'partnerName', value: c.publicConfig.partnerName || 'Marchand' }, { key: 'fc', value: 'USD' }, { key: 'amountFc', value: '1' }],
      }) });
    if (!r?.serverCorrelationId) throw new AppError('PAYMENT_PROVIDER_ERROR', 502, 'Réponse MVola inattendue', { body: r });
    return { providerRef: r.serverCorrelationId, status: 'pending', raw: r, clientAction: { type: 'ussd_push', message: 'Validez le paiement sur votre téléphone MVola en saisissant votre code secret.' } };
  }
  async status(payment: any, c: ProviderCtx) {
    const token = await this.token(c);
    const r = await http(`${this.base(c)}/mvola/mm/transactions/type/merchantpay/1.0.0/status/${encodeURIComponent(payment.providerRef)}`, { headers: this.headers(c, token, payment.id) });
    const s = String(r?.status || '').toLowerCase();
    return { status: (s === 'completed' ? 'succeeded' : s === 'failed' ? 'failed' : 'pending') as ProviderStatus, raw: r };
  }
  parseWebhook(body: any): WebhookEvent {
    const ref = body?.serverCorrelationId; const s = String(body?.transactionStatus || body?.status || '').toLowerCase();
    if (!ref) throw new AppError('WEBHOOK_INVALID', 400);
    return { providerRef: ref, status: s === 'completed' ? 'succeeded' : s === 'failed' ? 'failed' : 'pending', eventKey: `mvola:${ref}:${s}:${body?.transactionReference || ''}` };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Orange Money Web Payment — d'après developer.orange.com (API « Orange Money Webpay »). À VALIDER avec un compte marchand.
// ─────────────────────────────────────────────────────────────────────────────
export class OrangeMoneyProvider implements PaymentProvider {
  code = 'orange_money'; trustWebhook = false;
  private path = (c: ProviderCtx) => `https://api.orange.com/orange-money-webpay/${c.mode === 'live' ? 'mg' : 'dev'}/v1`;
  private async token(c: ProviderCtx): Promise<string> {
    need(c, 'clientId', 'clientSecret', 'merchantKey');
    const r = await http('https://api.orange.com/oauth/v3/token', { method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(`${c.secrets.clientId}:${c.secrets.clientSecret}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: 'grant_type=client_credentials' });
    if (!r?.access_token) throw new AppError('PAYMENT_PROVIDER_ERROR', 502, 'Authentification Orange Money refusée');
    return r.access_token;
  }
  private currency = (c: ProviderCtx, fallback: string) => c.mode === 'live' ? fallback : 'OUV';
  async initiate(i: InitiateInput, c: ProviderCtx): Promise<InitiateResult> {
    const token = await this.token(c);
    const r = await http(this.path(c) + '/webpayment', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ merchant_key: c.secrets.merchantKey, currency: this.currency(c, i.currency), order_id: i.paymentId, amount: i.amount,
        return_url: i.returnUrl, cancel_url: i.cancelUrl, notif_url: i.callbackUrl, lang: 'fr', reference: i.reference }) });
    if (!r?.pay_token || !r?.payment_url) throw new AppError('PAYMENT_PROVIDER_ERROR', 502, 'Réponse Orange Money inattendue', { body: r });
    return { providerRef: r.pay_token, status: 'pending', raw: { notif_token: r.notif_token }, clientAction: { type: 'redirect', url: r.payment_url, message: 'Vous allez être redirigé vers Orange Money pour valider le paiement.' } };
  }
  async status(payment: any, c: ProviderCtx) {
    const token = await this.token(c);
    const r = await http(this.path(c) + '/transactionstatus', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ order_id: payment.id, amount: payment.amount, pay_token: payment.providerRef }) });
    const s = String(r?.status || '').toUpperCase();
    return { status: (s === 'SUCCESS' ? 'succeeded' : s === 'FAILED' || s === 'EXPIRED' ? 'failed' : 'pending') as ProviderStatus, raw: r };
  }
  parseWebhook(body: any): WebhookEvent {
    const s = String(body?.status || '').toUpperCase();
    if (!body?.notif_token && !body?.txnid) throw new AppError('WEBHOOK_INVALID', 400);
    // le callback Orange ne contient pas le pay_token : le paiement est retrouvé par l'identifiant placé dans l'URL de notification
    return { status: s === 'SUCCESS' ? 'succeeded' : s === 'FAILED' ? 'failed' : 'pending', eventKey: `orange_money:${body.notif_token || ''}:${body.txnid || ''}:${s}` };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Airtel Money — d'après developers.airtel.africa (Collection API). À VALIDER en UAT avec des identifiants marchands.
// ─────────────────────────────────────────────────────────────────────────────
export class AirtelMoneyProvider implements PaymentProvider {
  code = 'airtel_money'; trustWebhook = false;
  private base = (c: ProviderCtx) => c.mode === 'live' ? 'https://openapi.airtel.africa' : 'https://openapiuat.airtel.africa';
  private async token(c: ProviderCtx): Promise<string> {
    need(c, 'clientId', 'clientSecret');
    const r = await http(this.base(c) + '/auth/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: '*/*' },
      body: JSON.stringify({ client_id: c.secrets.clientId, client_secret: c.secrets.clientSecret, grant_type: 'client_credentials' }) });
    if (!r?.access_token) throw new AppError('PAYMENT_PROVIDER_ERROR', 502, 'Authentification Airtel Money refusée');
    return r.access_token;
  }
  private headers(c: ProviderCtx, token: string, currency: string) {
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: '*/*', 'X-Country': c.publicConfig.country || 'MG', 'X-Currency': c.publicConfig.currency || currency };
  }
  async initiate(i: InitiateInput, c: ProviderCtx): Promise<InitiateResult> {
    const token = await this.token(c);
    const country = c.publicConfig.country || 'MG', currency = c.publicConfig.currency || i.currency;
    const id = i.paymentId.replace(/-/g, '').slice(0, 24);
    const r = await http(this.base(c) + '/merchant/v1/payments/', { method: 'POST', headers: this.headers(c, token, currency),
      body: JSON.stringify({ reference: i.reference.slice(0, 64), subscriber: { country, currency, msisdn: localMsisdn(i.payerPhone).replace(/^0/, '') }, transaction: { amount: i.amount, country, currency, id } }) });
    if (r?.status?.success === false) throw new AppError('PAYMENT_PROVIDER_ERROR', 502, r.status.message || 'Airtel Money a refusé la demande', { body: r.status });
    return { providerRef: r?.data?.transaction?.id || id, status: 'pending', raw: r, clientAction: { type: 'ussd_push', message: 'Saisissez votre code PIN Airtel Money sur votre téléphone pour valider.' } };
  }
  private map(code: string): ProviderStatus { return code === 'TS' ? 'succeeded' : code === 'TF' ? 'failed' : 'pending'; }
  async status(payment: any, c: ProviderCtx) {
    const token = await this.token(c);
    const r = await http(`${this.base(c)}/standard/v1/payments/${encodeURIComponent(payment.providerRef)}`, { headers: this.headers(c, token, payment.currency) });
    return { status: this.map(String(r?.data?.transaction?.status || '')), raw: r };
  }
  parseWebhook(body: any): WebhookEvent {
    const tr = body?.transaction; if (!tr?.id) throw new AppError('WEBHOOK_INVALID', 400);
    return { providerRef: tr.id, status: this.map(String(tr.status_code || '')), eventKey: `airtel_money:${tr.id}:${tr.status_code}:${tr.airtel_money_id || ''}` };
  }
  async refund(payment: any, _amount: number, c: ProviderCtx) {
    const airtelId = payment.rawLastStatus?.data?.transaction?.airtel_money_id;
    if (!airtelId) return { ok: false, error: 'identifiant Airtel Money de la transaction inconnu' };
    const token = await this.token(c);
    const r = await http(this.base(c) + '/standard/v1/payments/refund', { method: 'POST', headers: this.headers(c, token, payment.currency), body: JSON.stringify({ transaction: { airtel_money_id: airtelId } }) });
    return r?.status?.success ? { ok: true, providerRef: r?.data?.transaction?.airtel_money_id } : { ok: false, error: r?.status?.message || 'refus' };
  }
}
