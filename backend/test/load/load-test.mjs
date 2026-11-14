#!/usr/bin/env node
/* Test de charge : de vraies requêtes HTTP simultanées contre un serveur démarré (voir run.sh).
   Usage : BASE_URL=http://127.0.0.1:3999 node test/load/load-test.mjs
   Le serveur doit tourner avec RATE_LIMIT_FACTOR élevé (sinon toutes les requêtes venant de la même adresse sont limitées,
   ce qui est le comportement voulu en production) et un moyen de paiement en mode simulé. */
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const BASE = (process.env.BASE_URL || 'http://127.0.0.1:3999').replace(/\/$/, '');
const API = BASE + '/api/v1';
const N_SAME_SEAT = Number(process.env.N_SAME_SEAT || 500);
const N_RUSH = Number(process.env.N_RUSH || 1000);
const N_READ = Number(process.env.N_READ || 4000);
const ADMIN = { firstName: 'Charge', lastName: 'Admin', email: 'admin@charge.local', password: 'Charge-Test-2026' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const lat = {};
async function call(name, method, path, { body, token, headers } = {}) {
  const t0 = performance.now();
  let status = 0, json = null;
  try {
    const r = await fetch(API + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: 'Bearer ' + token } : {}), ...(headers || {}) }, body: body ? JSON.stringify(body) : undefined });
    status = r.status;
    const text = await r.text();
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  } catch (e) { status = -1; json = { code: 'NETWORK', message: String(e?.cause?.code || e?.message) }; }
  (lat[name] ||= []).push(performance.now() - t0);
  return { status, body: json };
}
/** Comme le frontend : en cas de 503/429 on patiente (Retry-After) et on réessaie. */
async function patient(name, method, path, opts, tries = 30) {
  let r = await call(name, method, path, opts);
  for (let i = 0; (r.status === 503 || r.status === 429 || r.status === -1) && i < tries; i++) { await sleep(200 + Math.random() * 400); r = await call(name, method, path, opts); }
  return r;
}
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : 0; };
const stats = name => { const xs = lat[name] || []; return { n: xs.length, p50: Math.round(pct(xs, 0.5)), p95: Math.round(pct(xs, 0.95)), p99: Math.round(pct(xs, 0.99)), max: Math.round(Math.max(0, ...xs)) }; };
const hist = rs => rs.reduce((a, r) => { const k = String(r.status) + (r.body?.code ? ' ' + r.body.code : ''); a[k] = (a[k] || 0) + 1; return a; }, {});
const day = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const checks = [];
const check = (label, ok, detail = '') => { checks.push({ label, ok, detail }); console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ' — ' + detail : ''}`); };

async function prepare() {
  const st = await call('setup', 'GET', '/setup/status');
  if (st.body?.status !== 'completed') {
    const r = await call('setup', 'POST', '/setup/complete', { headers: process.env.SETUP_TOKEN ? { 'x-setup-token': process.env.SETUP_TOKEN } : {},
      body: { identity: { name: 'Charge Trans' }, admin: ADMIN, seed: 'empty', payments: [{ code: 'mvola', enabled: true, mode: 'test' }] } });
    if (r.status !== 200) throw new Error('setup: ' + JSON.stringify(r.body));
  }
  const login = await call('login', 'POST', '/auth/login', { body: { email: ADMIN.email, password: ADMIN.password, scope: 'staff' } });
  if (login.status !== 200) throw new Error('login: ' + JSON.stringify(login.body));
  const token = login.body.accessToken;
  const layouts = (await call('admin', 'GET', '/admin/seat-layouts', { token })).body;
  const mk = async (layoutCode, from, to) => {
    const l = layouts.find(x => x.code === layoutCode);
    const tag = randomUUID().slice(0, 6);
    const v = await call('admin', 'POST', '/admin/vehicles', { token, body: { name: 'Charge ' + tag, layoutId: l.id, plateNumber: 'CH-' + tag } });
    const r = await call('admin', 'POST', '/admin/routes', { token, body: { fromCity: from + ' ' + tag, toCity: to + ' ' + tag, durationMin: 180, basePrice: 15000 } });
    const t = await call('admin', 'POST', '/admin/trips', { token, body: { routeId: r.body.id, vehicleId: v.body.id, date: day(3), departureTime: '08:00' } });
    if (t.status >= 300) throw new Error('trip: ' + JSON.stringify(t.body));
    const map = (await call('admin', 'GET', `/trips/${t.body.id}/seats`)).body;
    return { tripId: t.body.id, seats: map.layout.rows.flatMap(x => x.seats), from: from + ' ' + tag, to: to + ' ' + tag };
  };
  return { token, mk };
}

async function scenarioSameSeat(env) {
  console.log(`\n■ Scénario 1 — ${N_SAME_SEAT} clients réservent LE MÊME siège au même instant`);
  const w = await env.mk('minibus16', 'Départ', 'Arrivée');
  const t0 = performance.now();
  const rs = await Promise.all(Array.from({ length: N_SAME_SEAT }, () => call('S1 verrou (même siège)', 'POST', `/trips/${w.tripId}/holds`, { body: { seats: ['A1'] } })));
  const ms = Math.round(performance.now() - t0);
  const h = hist(rs);
  console.log('  réponses :', JSON.stringify(h), `en ${ms} ms`);
  const winners = rs.filter(r => r.status === 200);
  check('un seul client obtient le siège', winners.length === 1, `${winners.length} gagnant(s)`);
  check('tous les autres reçoivent 409 SEAT_TAKEN (ou 503 « réessayez »), aucune erreur 500', rs.every(r => r.status === 200 || r.status === 409 || r.status === 503), JSON.stringify(h));
  // Le gagnant va jusqu'au bout : réservation, paiement, billet.
  const win = winners[0].body;
  const b = await call('S1 réservation', 'POST', '/bookings', { headers: { 'idempotency-key': randomUUID() }, body: { tripId: w.tripId, holdToken: win.token,
    passengers: [{ seatNo: 'A1', firstName: 'Gagnant', lastName: 'Unique', phone: '0340000100', gender: 'M', category: 'adult' }], contact: { name: 'Gagnant Unique', phone: '0341234567', email: 'gagnant@charge.local' } } });
  const p = await call('S1 paiement', 'POST', '/payments', { headers: { 'idempotency-key': randomUUID(), 'x-booking-token': b.body.accessToken }, body: { reference: b.body.reference, method: 'mvola', payerPhone: '0340000111' } });
  let final = null;
  for (let i = 0; i < 60; i++) { final = await call('S1 suivi', 'GET', `/bookings/${b.body.reference}`, { headers: { 'x-booking-token': b.body.accessToken } }); if (final.body?.status === 'confirmed') break; await sleep(500); }
  check('la vente du gagnant est confirmée et son billet émis', final.body?.status === 'confirmed' && p.status === 200, `statut ${final.body?.status}`);
  const again = await call('S1 verrou (après vente)', 'POST', `/trips/${w.tripId}/holds`, { body: { seats: ['A1'] } });
  check('le siège vendu ne peut plus être pris', again.status === 409);
  return { clients: N_SAME_SEAT, durationMs: ms, responses: h };
}

async function scenarioRush(env) {
  console.log(`\n■ Scénario 2 — ouverture des ventes : ${N_RUSH} clients pour un bus de 48 places (parcours complet avec paiement)`);
  const w = await env.mk('bus', 'Capitale', 'Côte');
  const t0 = performance.now();
  const outcomes = await Promise.all(Array.from({ length: N_RUSH }, async (_, i) => {
    await sleep(Math.random() * 300);                    // les clients n'arrivent pas tous à la même milliseconde
    for (let k = 0; k < 5; k++) {
      const seat = w.seats[(i * 11 + k * 17) % w.seats.length];
      const h = await patient('S2 verrou', 'POST', `/trips/${w.tripId}/holds`, { body: { seats: [seat] } });
      if (h.status === 409) continue;
      if (h.status !== 200) return { status: h.status, body: h.body, step: 'verrou' };
      const idem = randomUUID(), idemPay = randomUUID();
      const b = await patient('S2 réservation', 'POST', '/bookings', { headers: { 'idempotency-key': idem }, body: { tripId: w.tripId, holdToken: h.body.token,
        passengers: [{ seatNo: seat, firstName: 'Client' + i, lastName: 'Charge', phone: '0340000100', gender: 'F', category: 'adult' }], contact: { name: 'Client ' + i, phone: '0341234567', email: `c${i}@charge.local` } } });
      if (b.status >= 300) return { status: b.status, body: b.body, step: 'réservation' };
      const p = await patient('S2 paiement', 'POST', '/payments', { headers: { 'idempotency-key': idemPay, 'x-booking-token': b.body.accessToken }, body: { reference: b.body.reference, method: 'mvola', payerPhone: '0340000111' } });
      if (p.status >= 300) return { status: p.status, body: p.body, step: 'paiement' };
      for (let j = 0; j < 90; j++) {
        const v = await patient('S2 suivi', 'GET', `/bookings/${b.body.reference}`, { headers: { 'x-booking-token': b.body.accessToken } });
        if (v.body?.status === 'confirmed') return { status: 200, seat, reference: b.body.reference, step: 'confirmé' };
        if (v.body?.status === 'cancelled' || v.body?.status === 'expired') return { status: 410, body: { code: v.body.status }, step: 'suivi' };
        await sleep(700);
      }
      return { status: 408, body: { code: 'NON_CONFIRME' }, step: 'suivi' };
    }
    return { status: 409, body: { code: 'COMPLET' }, step: 'verrou' };
  }));
  const ms = Math.round(performance.now() - t0);
  const sold = outcomes.filter(o => o.status === 200);
  const h = hist(outcomes);
  console.log('  issues :', JSON.stringify(h), `en ${(ms / 1000).toFixed(1)} s`);
  check('exactement 48 billets vendus', sold.length === w.seats.length, `${sold.length} vendus pour ${w.seats.length} places`);
  check('aucun siège vendu deux fois', new Set(sold.map(o => o.seat)).size === sold.length);
  check('aucune erreur 500', outcomes.every(o => o.status < 500 || o.status === 503), JSON.stringify(h));
  const manifest = await call('admin', 'GET', `/admin/trips/${w.tripId}/manifest`, { token: env.token });
  const pax = manifest.body?.passengers || manifest.body?.items || [];
  check('le manifeste du voyage contient 48 passagers sur 48 sièges distincts', pax.length === w.seats.length && new Set(pax.map(x => x.seatNo)).size === pax.length, `${pax.length} passagers`);
  const search = await call('S2 recherche', 'GET', `/search?from=${encodeURIComponent(w.from)}&to=${encodeURIComponent(w.to)}&date=${day(3)}`);
  check('la recherche affiche le départ complet', search.body?.status === 'full', `statut ${search.body?.status}`);
  return { clients: N_RUSH, seats: w.seats.length, sold: sold.length, durationMs: ms, outcomes: h, tripId: w.tripId };
}

async function scenarioRead(env) {
  console.log(`\n■ Scénario 3 — consultation : ${N_READ} requêtes de recherche et de plan de sièges, 200 en parallèle`);
  const w = await env.mk('bus', 'Lecture', 'Seule');
  let i = 0; const rs = [];
  const t0 = performance.now();
  await Promise.all(Array.from({ length: 200 }, async () => {
    while (i < N_READ) { const k = i++; rs.push(k % 2
      ? await call('S3 recherche', 'GET', `/search?from=${encodeURIComponent(w.from)}&to=${encodeURIComponent(w.to)}&date=${day(3)}&passengers=2`)
      : await call('S3 plan de sièges', 'GET', `/trips/${w.tripId}/seats`)); }
  }));
  const ms = performance.now() - t0;
  const h = hist(rs);
  const rps = Math.round(rs.length / (ms / 1000));
  console.log('  réponses :', JSON.stringify(h), `— ${rps} requêtes/s`);
  check('toutes les lectures réussissent', rs.every(r => r.status === 200), JSON.stringify(h));
  return { requests: rs.length, durationMs: Math.round(ms), rps, responses: h };
}

const env = await prepare();
const out = { date: new Date().toISOString(), base: BASE, s1: await scenarioSameSeat(env), s2: await scenarioRush(env), s3: await scenarioRead(env) };
const health = await call('health', 'GET', '/../../health/ready');
check('le serveur est toujours en bonne santé après la charge', health.status === 200);
out.latencies = Object.fromEntries(Object.keys(lat).filter(k => k.startsWith('S')).sort().map(k => [k, stats(k)]));
out.checks = checks;
console.log('\nLatences (ms) :'); console.table(out.latencies);
if (process.env.RESULT_FILE) writeFileSync(process.env.RESULT_FILE, JSON.stringify(out, null, 2));
const failed = checks.filter(c => !c.ok);
console.log(failed.length ? `\n${failed.length} vérification(s) en échec` : `\nToutes les vérifications passent (${checks.length})`);
process.exit(failed.length ? 1 : 0);
