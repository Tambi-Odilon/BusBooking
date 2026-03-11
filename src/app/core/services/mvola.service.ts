import { Injectable, signal } from '@angular/core';

// ─── Configuration MVola API ────────────────────────────────────────────────
// URLs
const SANDBOX_BASE_URL    = 'https://devapi.mvola.mg';
const PRODUCTION_BASE_URL = 'https://api.mvola.mg';

// Endpoints
const TOKEN_ENDPOINT   = '/token';
const MERCHANT_PAY_URL = '/mvola/mm/transactions/type/merchantpay/1.0/';
const STATUS_URL       = '/mvola/mm/transactions/type/merchantpay/1.0/status/';

// Merchant config Soatrans — compte marchand MVola
export const MVOLA_CONFIG = {
  // Clés API à obtenir sur https://developer.mvola.mg
  // Remplacer par vos vraies clés en production
  consumerKey:    'YOUR_CONSUMER_KEY',
  consumerSecret: 'YOUR_CONSUMER_SECRET',

  // Numéro MVola marchand Soatrans (le compte qui REÇOIT les paiements)
  merchantNumber: '0382101949',          // +261 38 210 1949

  partnerName:    'Soatrans',
  callbackUrl:    'https://soatrans.mg/api/mvola/callback',

  // false = sandbox (devapi.mvola.mg), true = production (api.mvola.mg)
  production: false,
} as const;

// ─── Types ──────────────────────────────────────────────────────────────────
export interface MVolaTokenResponse {
  access_token: string;
  scope:        string;
  token_type:   string;
  expires_in:   number;
}

export interface MVolaInitResponse {
  status:              string;   // 'pending' | 'success' | 'failed'
  serverCorrelationId: string;
  notificationMethod:  string;
  objectReference:     string;
}

export interface MVolaStatusResponse {
  status:              string;
  serverCorrelationId: string;
  notificationMethod:  string;
  objectReference:     string;   // transactionReference une fois complété
}

export interface MVolaPaymentResult {
  success:            boolean;
  transactionId?:     string;
  serverCorrelationId?: string;
  error?:             string;
  rawResponse?:       unknown;
}

export type MVolaPaymentStatus = 'idle' | 'authenticating' | 'pending' | 'polling' | 'success' | 'failed';

// ─── Cache token en mémoire ──────────────────────────────────────────────────
interface TokenCache {
  token:     string;
  expiresAt: number;  // timestamp ms
}

@Injectable({ providedIn: 'root' })
export class MVolaService {
  private tokenCache: TokenCache | null = null;

  readonly paymentStatus = signal<MVolaPaymentStatus>('idle');
  readonly paymentError  = signal<string | null>(null);
  readonly serverCorrelationId = signal<string | null>(null);

  private get baseUrl(): string {
    return MVOLA_CONFIG.production ? PRODUCTION_BASE_URL : SANDBOX_BASE_URL;
  }

  // ─── 1. Authentification OAuth2 (client_credentials) ──────────────────────
  async getAccessToken(): Promise<string> {
    // Retourner le token en cache s'il est encore valide (avec 60s de marge)
    if (this.tokenCache && Date.now() < this.tokenCache.expiresAt - 60_000) {
      return this.tokenCache.token;
    }

    const credentials = btoa(
      `${MVOLA_CONFIG.consumerKey}:${MVOLA_CONFIG.consumerSecret}`
    );

    const response = await fetch(`${this.baseUrl}${TOKEN_ENDPOINT}`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type':  'application/x-www-form-urlencoded',
        'Cache-Control': 'no-cache',
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        scope:      'EXT_INT_MVOLA_SCOPE',
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`MVola Auth failed (${response.status}): ${err}`);
    }

    const data: MVolaTokenResponse = await response.json();
    this.tokenCache = {
      token:     data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };

    return data.access_token;
  }

  // ─── 2. Initier un paiement MerchantPay ───────────────────────────────────
  // customerPhone : numéro MVola du CLIENT qui paie (ex: '0341234567')
  // amount        : montant en Ariary
  // description   : max 40 caractères sans caractères spéciaux
  async initiatePayment(
    customerPhone: string,
    amount:        number,
    description:   string
  ): Promise<MVolaInitResponse> {
    const token = await this.getAccessToken();

    // Normaliser le numéro (supprimer le +261, garder 03x...)
    const phone = this.normalizePhone(customerPhone);
    const correlationId = this.generateUUID();
    const transRef      = `SOATRANS-${Date.now()}`;
    const requestDate   = new Date().toISOString();

    // Tronquer la description à 40 caractères, supprimer les accents/caractères spéciaux
    const safeDesc = this.sanitizeDescription(description);

    const payload = {
      amount:    String(amount),
      currency:  'Ar',
      descriptionText: safeDesc,
      requestingOrganisationTransactionReference: transRef,
      requestDate,
      originalTransactionReference: transRef,
      debitParty: [
        { key: 'msisdn', value: phone }
      ],
      creditParty: [
        { key: 'msisdn', value: MVOLA_CONFIG.merchantNumber }
      ],
      metadata: [
        { key: 'partnerName',                         value: MVOLA_CONFIG.partnerName },
        { key: 'fc',                                  value: 'Ar' },
        { key: 'amountFc',                            value: String(amount) },
        { key: 'requestingOrganisationTransactionReference', value: transRef },
      ],
    };

    const response = await fetch(`${this.baseUrl}${MERCHANT_PAY_URL}`, {
      method: 'POST',
      headers: {
        'Authorization':         `Bearer ${token}`,
        'Version':               '1.0',
        'X-CorrelationID':       correlationId,
        'UserLanguage':          'FR',
        'UserAccountIdentifier': `msisdn;${MVOLA_CONFIG.merchantNumber}`,
        'partnerName':           MVOLA_CONFIG.partnerName,
        'Content-Type':          'application/json',
        'Cache-Control':         'no-cache',
        ...(MVOLA_CONFIG.callbackUrl
          ? { 'X-Callback-URL': MVOLA_CONFIG.callbackUrl }
          : {}),
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`MVola initPayment failed (${response.status}): ${err}`);
    }

    return await response.json() as MVolaInitResponse;
  }

  // ─── 3. Vérifier le statut d'une transaction ──────────────────────────────
  async getTransactionStatus(serverCorrelationId: string): Promise<MVolaStatusResponse> {
    const token      = await this.getAccessToken();
    const corrId     = this.generateUUID();

    const response = await fetch(
      `${this.baseUrl}${STATUS_URL}${serverCorrelationId}`,
      {
        method: 'GET',
        headers: {
          'Authorization':         `Bearer ${token}`,
          'Version':               '1.0',
          'X-CorrelationID':       corrId,
          'UserLanguage':          'FR',
          'UserAccountIdentifier': `msisdn;${MVOLA_CONFIG.merchantNumber}`,
          'partnerName':           MVOLA_CONFIG.partnerName,
          'Content-Type':          'application/json',
          'Cache-Control':         'no-cache',
        },
      }
    );

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`MVola status check failed (${response.status}): ${err}`);
    }

    return await response.json() as MVolaStatusResponse;
  }

  // ─── 4. Méthode principale : paiement complet avec polling ────────────────
  async processMVolaPayment(
    customerPhone: string,
    amount:        number,
    description:   string,
    onStatusUpdate?: (status: MVolaPaymentStatus) => void,
  ): Promise<MVolaPaymentResult> {
    this.paymentError.set(null);
    this.paymentStatus.set('authenticating');
    onStatusUpdate?.('authenticating');

    try {
      // Étape 1 : Initier le paiement
      this.paymentStatus.set('pending');
      onStatusUpdate?.('pending');

      const initResult = await this.initiatePayment(customerPhone, amount, description);
      this.serverCorrelationId.set(initResult.serverCorrelationId);

      // Étape 2 : Polling du statut (max 12 tentatives × 5s = 60s)
      this.paymentStatus.set('polling');
      onStatusUpdate?.('polling');

      const finalStatus = await this.pollTransactionStatus(
        initResult.serverCorrelationId,
        12,    // max attempts
        5000   // interval ms
      );

      if (finalStatus.status === 'completed' || finalStatus.status === 'success') {
        this.paymentStatus.set('success');
        onStatusUpdate?.('success');
        return {
          success:            true,
          transactionId:      finalStatus.objectReference,
          serverCorrelationId: initResult.serverCorrelationId,
          rawResponse:        finalStatus,
        };
      } else {
        throw new Error(`Transaction ${finalStatus.status}`);
      }

    } catch (error) {
      const message = error instanceof Error ? error.message : 'Erreur MVola inconnue';
      this.paymentError.set(message);
      this.paymentStatus.set('failed');
      onStatusUpdate?.('failed');
      return { success: false, error: message };
    }
  }

  // ─── Polling interne ──────────────────────────────────────────────────────
  private async pollTransactionStatus(
    serverCorrelationId: string,
    maxAttempts: number,
    intervalMs:  number,
  ): Promise<MVolaStatusResponse> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await this.sleep(intervalMs);

      const status = await this.getTransactionStatus(serverCorrelationId);

      if (status.status === 'completed' || status.status === 'success') {
        return status;
      }
      if (status.status === 'failed' || status.status === 'error') {
        throw new Error(`Transaction échouée : ${status.status}`);
      }
      // status === 'pending' → on continue de poller
    }
    throw new Error('Délai dépassé — aucune confirmation MVola reçue après 60 secondes');
  }

  // ─── Utilitaires ─────────────────────────────────────────────────────────
  normalizePhone(phone: string): string {
    // +261 38 210 1949 → 0382101949
    // 261382101949      → 0382101949
    // 0382101949        → 0382101949
    let cleaned = phone.replace(/[\s\-().+]/g, '');
    if (cleaned.startsWith('261')) cleaned = '0' + cleaned.slice(3);
    if (!cleaned.startsWith('0'))  cleaned = '0' + cleaned;
    return cleaned;
  }

  private sanitizeDescription(text: string): string {
    return text
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')   // supprimer accents
      .replace(/[^a-zA-Z0-9 \-._,]/g, '') // garder chars autorisés
      .slice(0, 40)
      .trim();
  }

  private generateUUID(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
