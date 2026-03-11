import { Injectable, signal } from '@angular/core';

// ─── Configuration Orange Money ───────────────────────────────────────────────
// Inscription : https://developer.orange.com/myapps
// 1. Créer un compte sur developer.orange.com
// 2. Créer une application → récupérer Authorization Header & Merchant Key
// 3. Tester en sandbox : https://api.orange.com/orange-money-webpay/dev/v1/
// 4. Production : https://api.orange.com/orange-money-webpay/mg/v1/ (country = mg)

const OM_TOKEN_URL  = 'https://api.orange.com/oauth/v3/token';
const OM_PAY_URL    = 'https://api.orange.com/orange-money-webpay/dev/v1/webpayment';  // sandbox
const OM_STATUS_URL = 'https://api.orange.com/orange-money-webpay/dev/v1/transactionstatus';

export const OM_CONFIG = {
  // Obtenu depuis developer.orange.com > Mon App > Credentials
  authorizationHeader: 'YOUR_AUTHORIZATION_HEADER_BASE64',  // Basic base64(clientId:clientSecret)
  merchantKey:  'YOUR_MERCHANT_KEY',
  currency:     'OUV',           // Madagascar: OUV (Ariary)
  lang:         'fr',
  returnUrl:    'https://soatrans.mg/payment/return',
  cancelUrl:    'https://soatrans.mg/payment/cancel',
  notifUrl:     'https://soatrans.mg/api/orangemoney/callback',
  sandbox:      true,
} as const;

// ─── Types ────────────────────────────────────────────────────────────────────
export interface OmTokenResponse {
  access_token:  string;
  token_type:    string;
  expires_in:    number;
}

export interface OmWebPaymentRequest {
  merchant_key: string;
  currency:     string;
  order_id:     string;
  amount:       number;
  return_url:   string;
  cancel_url:   string;
  notif_url:    string;
  lang:         string;
  reference:    string;
}

export interface OmWebPaymentResponse {
  // Orange renvoie une payment_url vers laquelle rediriger le client
  payment_url:   string;
  notif_token:   string;
  pay_token:     string;
  status:        string;
  message:       string;
}

export interface OmTransactionStatus {
  status:       string;   // 'SUCCESS' | 'FAILED' | 'PENDING' | 'EXPIRED'
  txnid:        string;
  amount:       string;
  order_id:     string;
  message:      string;
}

export type OmPaymentStatus = 'idle' | 'authenticating' | 'pending' | 'waiting_otp' | 'polling' | 'success' | 'failed';

export interface OmPaymentResult {
  success:       boolean;
  paymentUrl?:   string;   // URL de redirection Orange
  payToken?:     string;
  transactionId?: string;
  error?:        string;
}

// ─── Cache token ──────────────────────────────────────────────────────────────
interface TokenCache { token: string; expiresAt: number; }

@Injectable({ providedIn: 'root' })
export class OrangeMoneyService {
  private tokenCache: TokenCache | null = null;

  readonly paymentStatus = signal<OmPaymentStatus>('idle');
  readonly paymentError  = signal<string | null>(null);
  readonly payToken      = signal<string | null>(null);
  readonly paymentUrl    = signal<string | null>(null);

  // ─── 1. OAuth2 token ────────────────────────────────────────────────────────
  async getAccessToken(): Promise<string> {
    if (this.tokenCache && Date.now() < this.tokenCache.expiresAt - 60_000) {
      return this.tokenCache.token;
    }

    const response = await fetch(OM_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${OM_CONFIG.authorizationHeader}`,
        'Content-Type':  'application/x-www-form-urlencoded',
        'Accept':        'application/json',
      },
      body: 'grant_type=client_credentials',
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Orange Money Auth failed (${response.status}): ${err}`);
    }

    const data: OmTokenResponse = await response.json();
    this.tokenCache = {
      token:     data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
    return data.access_token;
  }

  // ─── 2. Initier paiement Web Payment ────────────────────────────────────────
  // Orange Money Madagascar utilise un flux redirect + OTP USSD
  // Le client est redirigé vers une page Orange pour saisir son OTP
  async initiateWebPayment(
    amount:    number,
    orderId:   string,
    reference: string,
  ): Promise<OmWebPaymentResponse> {
    const token = await this.getAccessToken();

    const payload: OmWebPaymentRequest = {
      merchant_key: OM_CONFIG.merchantKey,
      currency:     OM_CONFIG.currency,
      order_id:     orderId,
      amount,
      return_url:   OM_CONFIG.returnUrl,
      cancel_url:   OM_CONFIG.cancelUrl,
      notif_url:    OM_CONFIG.notifUrl,
      lang:         OM_CONFIG.lang,
      reference,
    };

    const url = OM_CONFIG.sandbox
      ? 'https://api.orange.com/orange-money-webpay/dev/v1/webpayment'
      : 'https://api.orange.com/orange-money-webpay/mg/v1/webpayment';

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json',
        'Accept':        'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Orange Money webpayment failed (${response.status}): ${err}`);
    }

    return await response.json() as OmWebPaymentResponse;
  }

  // ─── 3. Vérifier statut par pay_token ────────────────────────────────────────
  async checkTransactionStatus(payToken: string): Promise<OmTransactionStatus> {
    const token = await this.getAccessToken();

    const url = OM_CONFIG.sandbox
      ? `https://api.orange.com/orange-money-webpay/dev/v1/transactionstatus?payToken=${payToken}`
      : `https://api.orange.com/orange-money-webpay/mg/v1/transactionstatus?payToken=${payToken}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept':        'application/json',
      },
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Orange Money status check failed (${response.status}): ${err}`);
    }

    return await response.json() as OmTransactionStatus;
  }

  // ─── 4. Flux complet ─────────────────────────────────────────────────────────
  // Orange Money utilise un flux redirect : l'utilisateur est redirigé vers
  // une page Orange pour valider par OTP USSD, puis redirigé vers return_url
  // En mode SPA (sans redirect), on initie et renvoie la payment_url pour popup/iframe
  async processPayment(
    amount:    number,
    reference: string,
  ): Promise<OmPaymentResult> {
    this.paymentError.set(null);
    this.paymentStatus.set('authenticating');

    try {
      this.paymentStatus.set('pending');
      const orderId = `SOATRANS-OM-${Date.now()}`;

      const result = await this.initiateWebPayment(amount, orderId, reference);

      this.payToken.set(result.pay_token);
      this.paymentUrl.set(result.payment_url);
      this.paymentStatus.set('waiting_otp');

      return {
        success:    true,
        paymentUrl: result.payment_url,
        payToken:   result.pay_token,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Erreur Orange Money';
      this.paymentError.set(message);
      this.paymentStatus.set('failed');
      return { success: false, error: message };
    }
  }

  // Polling après que l'utilisateur revient de la page Orange
  async pollPaymentStatus(payToken: string, maxAttempts = 10, intervalMs = 5000): Promise<OmPaymentResult> {
    this.paymentStatus.set('polling');
    for (let i = 0; i < maxAttempts; i++) {
      await this.sleep(intervalMs);
      const status = await this.checkTransactionStatus(payToken);
      if (status.status === 'SUCCESS') {
        this.paymentStatus.set('success');
        return { success: true, transactionId: status.txnid, payToken };
      }
      if (status.status === 'FAILED' || status.status === 'EXPIRED') {
        throw new Error(`Transaction Orange Money : ${status.message || status.status}`);
      }
    }
    throw new Error('Délai dépassé — aucune confirmation Orange Money reçue');
  }

  reset(): void {
    this.paymentStatus.set('idle');
    this.paymentError.set(null);
    this.payToken.set(null);
    this.paymentUrl.set(null);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
