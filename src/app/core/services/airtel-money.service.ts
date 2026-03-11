import { Injectable, signal } from '@angular/core';

// ─── Configuration Airtel Money ───────────────────────────────────────────────
// Inscription : https://developers.airtel.africa/developer
// 1. Créer un compte développeur
// 2. Créer une app → récupérer client_id, client_secret, public_key (RSA)
// 3. Sandbox (UAT) : https://openapiuat.airtel.africa
// 4. Production    : https://openapi.airtel.africa

const AIRTEL_UAT_BASE  = 'https://openapiuat.airtel.africa';
const AIRTEL_PROD_BASE = 'https://openapi.airtel.africa';

export const AIRTEL_CONFIG = {
  clientId:     'YOUR_AIRTEL_CLIENT_ID',
  clientSecret: 'YOUR_AIRTEL_CLIENT_SECRET',
  // Clé RSA publique pour chiffrer le PIN (fournie dans le dashboard Airtel)
  publicKey:    'YOUR_AIRTEL_PUBLIC_KEY_RSA',

  // Madagascar : country = MG, currency = MGA (Ariary)
  country:      'MG',
  currency:     'MGA',

  sandbox:      true,
} as const;

// ─── Types ────────────────────────────────────────────────────────────────────
export interface AirtelTokenResponse {
  access_token:  string;
  token_type:    string;
  expires_in:    number;
  scope:         string;
}

export interface AirtelPaymentRequest {
  reference:   string;
  subscriber:  { country: string; currency: string; msisdn: string };
  transaction: { amount: number; country: string; currency: string; id: string };
}

export interface AirtelPaymentResponse {
  data: {
    transaction: {
      id:            string;
      status:        string;
      airtel_money_id?: string;
    };
  };
  status: {
    code:          string;
    message:       string;
    result_code:   string;
    response_code: string;
    success:       boolean;
  };
}

export interface AirtelTransactionStatus {
  data: {
    transaction: {
      airtel_money_id: string;
      id:              string;
      message:         string;
      status:          string;  // 'TS' (success) | 'TF' (failed) | 'TIP' (in progress)
    };
  };
  status: { code: string; message: string; success: boolean };
}

export type AirtelPaymentStatus = 'idle' | 'authenticating' | 'pending' | 'polling' | 'success' | 'failed';

export interface AirtelPaymentResult {
  success:         boolean;
  transactionId?:  string;
  airtelMoneyId?:  string;
  error?:          string;
}

// ─── Cache token ──────────────────────────────────────────────────────────────
interface TokenCache { token: string; expiresAt: number; }

@Injectable({ providedIn: 'root' })
export class AirtelMoneyService {
  private tokenCache: TokenCache | null = null;

  readonly paymentStatus = signal<AirtelPaymentStatus>('idle');
  readonly paymentError  = signal<string | null>(null);
  readonly transactionId = signal<string | null>(null);

  private get baseUrl(): string {
    return AIRTEL_CONFIG.sandbox ? AIRTEL_UAT_BASE : AIRTEL_PROD_BASE;
  }

  // ─── 1. OAuth2 token (client_credentials JSON body) ──────────────────────
  async getAccessToken(): Promise<string> {
    if (this.tokenCache && Date.now() < this.tokenCache.expiresAt - 60_000) {
      return this.tokenCache.token;
    }

    const response = await fetch(`${this.baseUrl}/auth/oauth2/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept':       '*/*',
      },
      body: JSON.stringify({
        client_id:     AIRTEL_CONFIG.clientId,
        client_secret: AIRTEL_CONFIG.clientSecret,
        grant_type:    'client_credentials',
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Airtel Money Auth failed (${response.status}): ${err}`);
    }

    const data: AirtelTokenResponse = await response.json();
    this.tokenCache = {
      token:     data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
    return data.access_token;
  }

  // ─── 2. Initier un paiement (USSD Push) ──────────────────────────────────
  // msisdn : numéro Airtel du client (sans indicatif, ex: '0331234567' → '0331234567')
  async initiatePayment(
    msisdn:    string,
    amount:    number,
    reference: string,
  ): Promise<AirtelPaymentResponse> {
    const token   = await this.getAccessToken();
    const txId    = `SOATRANS-AM-${Date.now()}`;
    const cleanPhone = msisdn.replace(/[\s\-().+]/g, '').replace(/^261/, '0');

    const payload: AirtelPaymentRequest = {
      reference,
      subscriber: {
        country:  AIRTEL_CONFIG.country,
        currency: AIRTEL_CONFIG.currency,
        msisdn:   cleanPhone,
      },
      transaction: {
        amount,
        country:  AIRTEL_CONFIG.country,
        currency: AIRTEL_CONFIG.currency,
        id:       txId,
      },
    };

    const response = await fetch(`${this.baseUrl}/merchant/v2/payments/`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json',
        'Accept':        '*/*',
        'X-Country':     AIRTEL_CONFIG.country,
        'X-Currency':    AIRTEL_CONFIG.currency,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Airtel Money payment initiation failed (${response.status}): ${err}`);
    }

    return await response.json() as AirtelPaymentResponse;
  }

  // ─── 3. Vérifier statut par transaction ID ────────────────────────────────
  async getTransactionStatus(txId: string): Promise<AirtelTransactionStatus> {
    const token = await this.getAccessToken();

    const response = await fetch(
      `${this.baseUrl}/standard/v1/payments/${txId}`,
      {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept':        '*/*',
          'X-Country':     AIRTEL_CONFIG.country,
          'X-Currency':    AIRTEL_CONFIG.currency,
        },
      }
    );

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Airtel status check failed (${response.status}): ${err}`);
    }

    return await response.json() as AirtelTransactionStatus;
  }

  // ─── 4. Flux complet avec polling ────────────────────────────────────────
  async processPayment(
    msisdn:    string,
    amount:    number,
    reference: string,
  ): Promise<AirtelPaymentResult> {
    this.paymentError.set(null);
    this.paymentStatus.set('authenticating');

    try {
      this.paymentStatus.set('pending');

      const initResult = await this.initiatePayment(msisdn, amount, reference);

      if (!initResult.status.success) {
        throw new Error(initResult.status.message || 'Initiation échouée');
      }

      const txId = initResult.data.transaction.id;
      this.transactionId.set(txId);

      // Polling : l'utilisateur reçoit un USSD push et valide son PIN
      this.paymentStatus.set('polling');

      const finalStatus = await this.pollStatus(txId, 12, 5000);

      this.paymentStatus.set('success');
      return {
        success:        true,
        transactionId:  txId,
        airtelMoneyId:  finalStatus.data.transaction.airtel_money_id,
      };

    } catch (error) {
      const message = error instanceof Error ? error.message : 'Erreur Airtel Money';
      this.paymentError.set(message);
      this.paymentStatus.set('failed');
      return { success: false, error: message };
    }
  }

  // ─── Polling interne ─────────────────────────────────────────────────────
  private async pollStatus(
    txId:        string,
    maxAttempts: number,
    intervalMs:  number,
  ): Promise<AirtelTransactionStatus> {
    for (let i = 0; i < maxAttempts; i++) {
      await this.sleep(intervalMs);
      const status = await this.getTransactionStatus(txId);
      const tx = status.data?.transaction;

      if (tx?.status === 'TS') return status;                          // Transaction Success
      if (tx?.status === 'TF') throw new Error(tx.message || 'Transaction échouée (TF)');
      // TIP = Transaction In Progress → on continue
    }
    throw new Error('Délai dépassé — aucune confirmation Airtel Money reçue');
  }

  normalizePhone(phone: string): string {
    return phone.replace(/[\s\-().+]/g, '').replace(/^261/, '0');
  }

  reset(): void {
    this.paymentStatus.set('idle');
    this.paymentError.set(null);
    this.transactionId.set(null);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
