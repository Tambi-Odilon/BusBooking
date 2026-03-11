export const environment = {
  production: true,
  mvola: {
    consumerKey:    'PROD_MVOLA_CONSUMER_KEY',
    consumerSecret: 'PROD_MVOLA_CONSUMER_SECRET',
    merchantNumber: '0382101949',
    partnerName:    'Soatrans',
    callbackUrl:    'https://soatrans.mg/api/mvola/callback',
    sandboxMode:    false,
  },
  orangeMoney: {
    authorizationHeader: 'PROD_OM_AUTHORIZATION_HEADER_BASE64',
    merchantKey:  'PROD_OM_MERCHANT_KEY',
    currency:     'OUV',
    returnUrl:    'https://soatrans.mg/payment/return',
    cancelUrl:    'https://soatrans.mg/payment/cancel',
    notifUrl:     'https://soatrans.mg/api/orangemoney/callback',
    sandbox:      false,
  },
  airtelMoney: {
    clientId:     'PROD_AIRTEL_CLIENT_ID',
    clientSecret: 'PROD_AIRTEL_CLIENT_SECRET',
    publicKey:    'PROD_AIRTEL_PUBLIC_KEY_RSA',
    country:      'MG',
    currency:     'MGA',
    sandbox:      false,
  },
};
