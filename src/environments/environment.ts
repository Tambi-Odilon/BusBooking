// ─── Environnement Développement / Sandbox ───────────────────────────────────
export const environment = {
  production: false,

  // MVola (Telma) — https://developer.mvola.mg
  mvola: {
    consumerKey:    'YOUR_MVOLA_CONSUMER_KEY',
    consumerSecret: 'YOUR_MVOLA_CONSUMER_SECRET',
    merchantNumber: '0382101949',
    partnerName:    'Soatrans',
    callbackUrl:    '',
    sandboxMode:    true,
  },

  // Orange Money — https://developer.orange.com/myapps
  orangeMoney: {
    authorizationHeader: 'YOUR_OM_AUTHORIZATION_HEADER_BASE64',  // Basic base64(clientId:secret)
    merchantKey:  'YOUR_OM_MERCHANT_KEY',
    currency:     'OUV',   // Madagascar
    returnUrl:    'https://soatrans.mg/payment/return',
    cancelUrl:    'https://soatrans.mg/payment/cancel',
    notifUrl:     'https://soatrans.mg/api/orangemoney/callback',
    sandbox:      true,
  },

  // Airtel Money — https://developers.airtel.africa/developer
  airtelMoney: {
    clientId:     'YOUR_AIRTEL_CLIENT_ID',
    clientSecret: 'YOUR_AIRTEL_CLIENT_SECRET',
    publicKey:    'YOUR_AIRTEL_PUBLIC_KEY_RSA',
    country:      'MG',
    currency:     'MGA',
    sandbox:      true,
  },
};
