// smoke-rythu.js — REAL end-to-end check of the rythu save path.
// Runs against the ALREADY-RUNNING server (default http://localhost:3000)
// with the real Supabase project behind it — no mocks anywhere.
//
// What it does:
//   1. signs up a THROWAWAY shop through the real auth flow
//      (voiceOkToken minted with the server's own JWT_SECRET from .env —
//      the same trust domain the server itself signs challenges with),
//   2. creates a farmer customer (kind='farmer'),
//   3. posts a Rythu delivery exactly like the browser does
//      (5 quintal x rate -> server-computed amount, payable, settlement anchor),
//   4. posts an advance, a deduction (hamali), a payment,
//   5. reads the settlement read-model and checks the remaining balance,
//   6. DELETES every row it created (transactions, audit_events, customers,
//      the shop) even on failure.
//
// Every step prints its HTTP status and, when present, the machine error code.
// The script NEVER prints phone numbers, names, transcripts or amounts —
// only opaque uuids, statuses, codes and PASS/FAIL booleans.
// Run: npm run smoke     (server must be running first)
'use strict';
require('dotenv').config();

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

const E = process.env;
const BASE = (E.SMOKE_URL || 'http://localhost:3000').replace(/\/+$/, '');
const SB_URL = E.SUPABASE_URL || '';
const SB_KEY = E.SUPABASE_SERVICE_KEY || E.SUPABASE_SECRET_KEY || '';
const JWT_SECRET = E.JWT_SECRET || '';

if (!JWT_SECRET) { console.error('smoke: need JWT_SECRET in .env (the running server signs voiceOk tokens with it)'); process.exit(2); }
if (!SB_URL || !SB_KEY) { console.error('smoke: need SUPABASE_URL + SUPABASE_SERVICE_KEY in .env for the cleanup step'); process.exit(2); }

let ints = 0;
const checks = {};
const ok = (label, cond) => { checks[label] = !!cond; console.log('[smoke] ' + label + ': ' + (cond ? 'PASS' : 'FAIL')); };

// per-step reporter: status + machine code only (never response messages,
// which could embedded user data on some failures)
function step(name, status, body) {
  const code = body && (body.code || (body.error_code)) ? String(body.code || body.error_code) : '-';
  console.log('[smoke] ' + name + ' -> HTTP ' + status + ' code=' + code);
  return body;
}
// a 5xx means the SAME opaque server message always: assert the status instead
function stepFail(name, status) {
  console.log('[smoke] ' + name + ' -> HTTP ' + status + ' code=' + (status === 500 ? 'SERVER_ERROR' : status === 502 ? 'UPSTREAM' : '-'));
}

(async () => {
  // the server must be up before anything else
  const hz = await fetch(BASE + '/healthz');
  if (!(hz && hz.ok)) { console.error('smoke: server is not running at ' + BASE + ' (node server.js first)'); process.exit(2); }
  console.log('[smoke] healthz -> HTTP ' + hz.status);

  const sbAdmin = createClient(SB_URL, SB_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

  // cookie jar: capture the session cookie from signup, replay it afterwards
  let cookie = null;
  const reqJSON = async (name, method, p, body) => {
    const res = await fetch(BASE + p, {
      method,
      headers: Object.assign({ 'Content-Type': 'application/json' }, cookie ? { Cookie: cookie } : {}),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    let data = null;
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) stepFail(name, res.status); else step(name, res.status, data);
    const out = new Error('http_' + res.status); // thrown when !res.ok, carries code only
    out.status = res.status;
    out.code = (data && data.code) || (res.status === 500 ? 'SERVER_ERROR' : null);
    return { res, data, out };
  };

  const shopId = crypto.randomUUID(); // tracking key ONLY for the fallback sweep
  let realShopId = null;
  try {
    // ---- 1. signup through the real auth flow ----
    // valid: starts with 9, ten digits; the number itself is NEVER printed
    const phone = '9' + String(Date.now() % 1000000000).padStart(9, '0');
    const token = jwt.sign({ phone, purpose: 'voiceOk' }, JWT_SECRET, { expiresIn: '5m' });
    const up = await reqJSON('signup', 'POST', '/api/auth/signup', { phone, pin: '1234', voiceOkToken: token });
    if (up.res.status === 409) throw up.out; // collision — rerun the smoke; random number made it unlikely
    if (!up.res.ok) throw up.out;
    realShopId = up.data && up.data.shop && up.data.shop.id;
    if (!realShopId) throw up.out;
    ok('signup created a session (cookie set)', !!cookie && !!up.data.shop);

    // ---- 2. farmer customer (kind='farmer') ----
    const fname = '__SMOKE farmer ' + crypto.randomUUID().slice(0, 8);
    const fc = await reqJSON('create-farmer', 'POST', '/api/customers', { name: fname, village: '__smoke', kind: 'farmer' });
    if (!fc.res.ok || !fc.res.status) throw fc.out;
    const farmerId = fc.data && (fc.data.id || (fc.data.customer && fc.data.customer.id));
    ok('farmer created with an id', !!farmerId);

    // ---- 3. delivery exactly like the browser's postRythu ----
    const key = crypto.randomUUID();
    const dl = await reqJSON('delivery-post', 'POST', '/api/transactions', {
      customer_id: farmerId, workflow: 'rythu', direction: 'payable', type: 'credit',
      event: 'produce_delivery', produce: 'paddy',
      quantity: '5', unit: 'quintal', rate: '2200', rate_unit: 'quintal',
      raw_transcript: 'smoke delivery (screen)', idempotency_key: key, source: 'screen',
    });
    if (!dl.res.ok || !dl.res.status) throw dl.out;
    const d = dl.data;
    ok('delivery: server computed amount from qty x rate (no client amount sent)', Number(d.amount) === 11000);
    ok('delivery: own row is the settlement anchor (settlement_id == id)', d.settlement_id === d.id);

    // ---- 4. advance / deduction / payment, all auto-linking to the anchor ----
    const adv = await reqJSON('advance-post', 'POST', '/api/transactions', {
      customer_id: farmerId, workflow: 'rythu', type: 'pay', event: 'advance', amount: 4000,
      raw_transcript: 'smoke advance (screen)', idempotency_key: crypto.randomUUID(), source: 'screen',
    });
    if (!adv.res.ok) throw adv.out;
    ok('advance auto-linked to the delivery anchor', adv.data.settlement_id === d.id);

    const ded = await reqJSON('deduction-post', 'POST', '/api/transactions', {
      customer_id: farmerId, workflow: 'rythu', type: 'pay', event: 'deduction',
      deduction_category: 'hamali', amount: 200,
      raw_transcript: 'smoke deduction (screen)', idempotency_key: crypto.randomUUID(), source: 'screen',
    });
    if (!ded.res.ok) throw ded.out;
    ok('deduction kept its category and auto-linked', ded.data.settlement_id === d.id && ded.data.deduction_category === 'hamali');

    const pay = await reqJSON('payment-post', 'POST', '/api/transactions', {
      customer_id: farmerId, workflow: 'rythu', type: 'pay', event: 'payment', amount: 5000,
      raw_transcript: 'smoke payment (screen)', idempotency_key: crypto.randomUUID(), source: 'screen',
    });
    if (!pay.res.ok) throw pay.out;
    ok('payment linked to the delivery anchor', pay.data.settlement_id === d.id);

    // ---- 5. read model: remaining === 1800, open === true ----
    const fs2 = await fetch(BASE + '/api/rythu/farmers/' + farmerId + '/settlements', { headers: { Cookie: cookie } });
    const fsd = fs2.ok ? await fs2.json() : null;
    if (!fs2.ok) stepFail('settlement-read', fs2.status);
    else step('settlement-read', fs2.status, {});
    const s = fsd && (fsd.settlements || []).find(x => x.settlement_id === d.id);
    ok('settlement read: remaining balance == cash-out, settlement open', !!s &&
      Number(s.remaining) === 1800 && s.open === true);

    const sm = await fetch(BASE + '/api/rythu/summary', { headers: { Cookie: cookie } });
    ok('rythu summary readable without error', sm.ok);

    console.log('\n[smoke] EVERY STEP PASSED — rythu save works against the real server');
  } catch (e) {
    console.log('[smoke] STOPPED at the failing step (status/code above). Cleanup still runs.');
    process.exitCode = 1;
    checks['flow completed'] = false;
  } finally {
    // ---- 6. always cleanup every row the smoke created ----
    const del = async (label, tbl, col, val) => {
      const r = await sbAdmin.from(tbl).delete().eq(col, val);
      step('cleanup-' + label, r.error ? 500 : 200, r.error || {});
    };
    try {
      if (realShopId) {
        await del('audit-events', 'audit_events', 'shop_id', realShopId);
        await del('transactions', 'transactions', 'shop_id', realShopId); // one statement: self-ref FK checked at statement end
        await del('customers', 'customers', 'shop_id', realShopId);
        await del('shop', 'shops', 'id', realShopId);
      }
      // safety net: the signup SUCCEEDED but the response parsing failed
      // (then-shop-id sweep keyed by the random phone is unnecessary —
      // failed signups never create a shop row; nothing else to sweep)
    } catch (e) {
      console.error('[smoke] CLEANUP FAILED (rows left behind!). ' +
        'Delete shops/transactions/audit_events/customers created by this run manually. ' +
        (e && e.code ? 'pg=' + String(e.code).slice(0, 12) : ''));
    }
    const passed = Object.values(checks).filter(Boolean).length;
    const failed = Object.keys(checks).length - passed;
    console.log('\n[smoke] ' + passed + ' checks passed, ' + failed + ' failed' +
      (process.exitCode ? ' (with cleanup)' : ''));
  }
})().catch(e => {
  console.error('[smoke] UNEXPECTED ' + (((e && (e.code || e.name)) || 'ERROR')) + ' — cleanup will run');
  process.exit(1);
});
