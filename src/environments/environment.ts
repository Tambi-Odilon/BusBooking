// ─── Environnement Développement / Sandbox ───────────────────────────────────
// Obtenir vos clés sur : https://developer.mvola.mg
// 1. Créer un compte développeur sur https://developer.mvola.mg/devportal/
// 2. Créer une application → copier Consumer Key & Consumer Secret
// 3. Activer la sandbox → utiliser devapi.mvola.mg
// 4. Pour la production → activer production → utiliser api.mvola.mg

export const environment = {
  production: false,
  mvola: {
    consumerKey:    'YOUR_CONSUMER_KEY_HERE',
    consumerSecret: 'YOUR_CONSUMER_SECRET_HERE',
    merchantNumber: '0382101949',  // +261 38 210 1949 — numéro marchand Soatrans
    partnerName:    'Soatrans',
    callbackUrl:    '',            // ex: 'https://soatrans.mg/api/mvola/callback'
    sandboxMode:    true,
  },
};
