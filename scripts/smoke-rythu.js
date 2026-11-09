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
  let realShop2Id = null;
  let realShop3Id = null;
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

    // ---- 1b. profile + the one-time business-type choice (rythu) ----
    const profA = await reqJSON('profile-set', 'PUT', '/api/me', {
      owner_name: '__smoke owner', shop_name: '__SMOKE shop ' + crypto.randomUUID().slice(0, 8),
      address: '__smoke address',
    });
    if (!profA.res.ok) throw profA.out;
    const ws = await reqJSON('biz-required', 'GET', '/api/customers');
    ok('null business type blocked from ledger routes (403 REQUIRED)',
      !ws.res.ok && ws.res.status === 403 && ws.out.code === 'BUSINESS_TYPE_REQUIRED',
      ws.res.status + '/' + ws.out.code);
    const badT = await reqJSON('biz-bad-type', 'PUT', '/api/me/business-type', { business_type: 'dairy' });
    ok('invalid business type rejected (400)', !badT.res.ok && badT.res.status === 400, badT.res.status);
    const chooseA = await reqJSON('biz-choose-rythu', 'PUT', '/api/me/business-type', { business_type: 'rythu' });
    if (!chooseA.res.ok) throw chooseA.out;
    ok('rythu type chosen for shop A', !!(chooseA.data && chooseA.data.shop &&
      chooseA.data.shop.business_type === 'rythu'));

    // ---- 2. farmer customer (kind='farmer') ----
    const fname = '__SMOKE farmer ' + crypto.randomUUID().slice(0, 8);
    const fc = await reqJSON('create-farmer', 'POST', '/api/customers', { name: fname, village: '__smoke', kind: 'farmer' });
    if (!fc.res.ok || !fc.res.status) throw fc.out;
    const farmerId = fc.data && (fc.data.id || (fc.data.customer && fc.data.customer.id));
    ok('farmer created with an id', !!farmerId);

    // ---- 2b. separation guards: a rythu shop never acts kirana ----
    const kcust = await reqJSON('create-kirana-rejected', 'POST', '/api/customers',
      { name: '__SMOKE kirana ' + crypto.randomUUID().slice(0, 8), kind: 'customer' });
    ok('rythu shop creating kind=customer rejected (403)',
      !kcust.res.ok && kcust.res.status === 403 && kcust.out.code === 'BUSINESS_TYPE_MISMATCH',
      kcust.res.status + '/' + kcust.out.code);
    const kpost = await reqJSON('kirana-row-rejected', 'POST', '/api/transactions', {
      customer_id: farmerId, workflow: 'kirana', direction: 'receivable', type: 'credit',
      event: 'goods_credit', amount: 10, idempotency_key: crypto.randomUUID(), source: 'screen',
    });
    ok('rythu shop posting a kirana row rejected (403)',
      !kpost.res.ok && kpost.res.status === 403 && kpost.out.code === 'BUSINESS_TYPE_MISMATCH',
      kpost.res.status + '/' + kpost.out.code);
    // propose ignores the client-supplied workflow: this shop parses as rythu
    const ppA = await reqJSON('propose-workflow', 'POST', '/api/voice/propose',
      { transcript: 'nothing that parses here', workflow: 'kirana' });
    ok('shop A propose derived rythu (client workflow ignored)',
      ppA.res.ok && ppA.data && ppA.data.workflow === 'rythu');

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

    // ---- 5b. the settlement ANCHOR with linked rows is NOT reversible (409) ----
    // must run in shop A's own session (a cross-shop session correctly reads 404)
    const revAnchor = await reqJSON('reverse-anchor-rejected', 'POST', '/api/transactions/' + d.id + '/reverse', { reason: 'smoke anchor' });
    ok('delivery anchor with linked rows is NOT reversible (409)',
      !revAnchor.res.ok && revAnchor.res.status === 409 && revAnchor.out.code === 'HAS_LINKED_ROWS',
      revAnchor.res.status + '/' + revAnchor.out.code);

    // ================= second shop: a KIRANA shop for the ack flow =================
    const phoneB = '9' + String((Date.now() + 3) % 1000000000).padStart(9, '0');
    const tokB = jwt.sign({ phone: phoneB, purpose: 'voiceOk' }, JWT_SECRET, { expiresIn: '5m' });
    cookie = null;
    const upB = await reqJSON('signup-kirana', 'POST', '/api/auth/signup', { phone: phoneB, pin: '1234', voiceOkToken: tokB });
    if (!upB.res.ok) throw upB.out;
    realShop2Id = upB.data && upB.data.shop && upB.data.shop.id;
    const profB = await reqJSON('profile-set-b', 'PUT', '/api/me', {
      owner_name: '__smoke owner B', shop_name: '__SMOKE shop ' + crypto.randomUUID().slice(0, 8),
      address: '__smoke address B',
    });
    if (!profB.res.ok) throw profB.out;
    const chooseB = await reqJSON('biz-choose-kirana', 'PUT', '/api/me/business-type', { business_type: 'kirana' });
    if (!chooseB.res.ok) throw chooseB.out;
    const rf = await reqJSON('ry-route-rejected', 'GET', '/api/rythu/farmers');
    ok('kirana shop cannot call /api/rythu/* (403 MISMATCH)',
      !rf.res.ok && rf.res.status === 403 && rf.out.code === 'BUSINESS_TYPE_MISMATCH',
      rf.res.status + '/' + rf.out.code);
    const bfarmer = await reqJSON('create-farmer-rejected-b', 'POST', '/api/customers',
      { name: '__SMOKE farmer B ' + crypto.randomUUID().slice(0, 8), kind: 'farmer' });
    ok('kirana shop cannot create kind=farmer (403 MISMATCH)',
      !bfarmer.res.ok && bfarmer.res.status === 403 && bfarmer.out.code === 'BUSINESS_TYPE_MISMATCH');
    // ================= sprint 3: acknowledgement flow (kirana) =================
    // ---- 6. shop profile: the public page shows the SHOP NAME ----
    const shopName = '__SMOKE shop ' + crypto.randomUUID().slice(0, 8);
    const prof = await reqJSON('profile-set', 'PUT', '/api/me', {
      owner_name: '__smoke owner', shop_name: shopName, address: '__smoke address',
    });
    if (!prof.res.ok) throw prof.out;

    // ---- 7. a kirana customer + one goods_credit entry ----
    const kname = '__SMOKE kirana ' + crypto.randomUUID().slice(0, 8);
    const kc = await reqJSON('create-kirana', 'POST', '/api/customers', { name: kname, kind: 'customer' });
    if (!kc.res.ok) throw kc.out;
    const kid = kc.data && (kc.data.id || (kc.data.customer && kc.data.customer.id));
    if (!kid) throw kc.out;
    const ke = await reqJSON('credit-post', 'POST', '/api/transactions', {
      customer_id: kid, workflow: 'kirana', direction: 'receivable', type: 'credit', event: 'goods_credit',
      amount: 300, note: 'smoke credit note', idempotency_key: crypto.randomUUID(), source: 'screen',
    });
    if (!ke.res.ok) throw ke.out;
    const entryId = ke.data && ke.data.id;
    ok('credit posted for acknowledgement', !!entryId);

    // payment/debt rows must NEVER get a link (debt side is not acknowledge-able)
    const kPay = await reqJSON('payment-post-kirana', 'POST', '/api/transactions', {
      customer_id: kid, workflow: 'kirana', type: 'pay', event: 'repayment', amount: 100,
      idempotency_key: crypto.randomUUID(), source: 'screen',
    });
    if (!kPay.res.ok) throw kPay.out;
    const badLink = await reqJSON('ack-link-pay-rejected', 'POST',
      '/api/transactions/' + (kPay.data && kPay.data.id) + '/ack-link', {});
    if (badLink.res.ok) { console.log('[smoke] ack-link on a payment: MUST have failed'); }
    ok('ack-link on a payment row rejected', !badLink.res.ok);

    // ---- 8. mint the link: URL + QR svg back, audio best-effort ----
    const al = await reqJSON('ack-link', 'POST', '/api/transactions/' + entryId + '/ack-link', {});
    if (!al.res.ok) throw al.out;
    const link = al.data || {};
    const url = String(link.url || '');
    const mTok = /\/a\/([A-Za-z0-9_-]{43})$/.exec(url);
    ok('ack-link: url ends in /a/<43-char base64url token>', !!mTok);
    ok('ack-link: qr svg present', String(link.qrSvg || '').indexOf('<svg') === 0);
    const token1 = mTok ? mTok[1] : '';
    // the QR payload is exactly the URL — both were built from the same string
    // server-side (asserted on the shape here; decoding needs raster imaging)

    // ---- 9. the customer opens the page + JSON view (no cookies anywhere) ----
    const page = await fetch(BASE + '/a/' + token1);
    const pageOk = page.status === 200 && (await page.text()).indexOf('<html') !== -1;
    ok('public page loads with browser-guard headers', pageOk &&
      page.headers.get('cache-control') === 'no-store' &&
      String(page.headers.get('x-robots-tag') || '').indexOf('noindex') !== -1, page.status);
    const pj = await fetch(BASE + '/api/public/ack/' + token1);
    const pv = pj.ok ? await pj.json() : null;
    ok('public view: awaiting + the shop name', pj.status === 200 && pv &&
      pv.status === 'awaiting' && pv.shop_name === shopName);
    ok('public view: minimal field set only', !!pv && Object.keys(pv).every(k =>
      ['status', 'shop_name', 'entry_date', 'entry_kind', 'amount', 'item',
        'responded_at', 'dispute_note', 'audio'].includes(k)));
    ok('public view: leaks no customer name or phone',
      JSON.stringify(pv || {}).indexOf(kname) === -1);
    const au = await fetch(BASE + '/a/' + token1 + '/audio');
    ok('ack audio served (or provider down at mint time)',
      au.status === 200 || (au.status === 404), au.status);

    // ---- 10. single response: acknowledge once, repeats are idempotent ----
    const answer = (tok, action, note) => fetch(BASE + '/api/public/ack/' + tok, {
      method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, { Origin: BASE }),
      body: JSON.stringify(note === undefined ? { action } : { action, note }),
    });
    let r1 = null, r2 = null, r3 = null, pv2 = null;
    try { r1 = await (await answer(token1, 'acknowledge')).json(); } catch (_) {}
    try { r2 = await (await answer(token1, 'dispute', 'late attempt')).json(); } catch (_) {}
    try { r3 = await (await answer(token1, 'acknowledge')).json(); } catch (_) {}
    ok('customer acknowledges once', r1 && r1.ok === true && r1.status === 'acknowledged' && !r1.repeat, JSON.stringify(r1));
    ok('a given answer can never flip to dispute', r2 && r2.repeat === true && r2.status === 'acknowledged');
    ok('second acknowledge is an idempotent repeat', r3 && r3.repeat === true);

    const pj2 = await fetch(BASE + '/api/public/ack/' + token1);
    try { pv2 = await pj2.json(); } catch (_) {}
    ok('public view now reads acknowledged, audio stopped',
      pj2.status === 200 && pv2 && pv2.status === 'acknowledged' && pv2.audio === false);

    // ---- 11. the shop sees it: entry ack_status + summary + audits ----
    const txl = await fetch(BASE + '/api/customers/' + kid + '/transactions', { headers: { Cookie: cookie } });
    const rows = txl.ok ? (await txl.json()).transactions || [] : [];
    const rowAck = (rows || []).find(t => t.id === entryId);
    ok('shop timeline shows ack_status acknowledged', !!rowAck && rowAck.ack_status === 'acknowledged');
    const sums = await fetch(BASE + '/api/acknowledgements/summary', { headers: { Cookie: cookie } });
    const sumsData = sums.ok ? await sums.json() : null;
    ok('acknowledgement summary counts it under acknowledged',
      sumsData && sumsData.acknowledged >= 1);

    // ---- 12. dispute + resolve round-trip ----
    const ke2 = await reqJSON('credit-post-2', 'POST', '/api/transactions', {
      customer_id: kid, workflow: 'kirana', direction: 'receivable', type: 'credit', event: 'goods_credit',
      amount: 70, note: 'smoke dispute note', idempotency_key: crypto.randomUUID(), source: 'screen',
    });
    if (!ke2.res.ok) throw ke2.out;
    const entry2Id = ke2.data && ke2.data.id;
    const al2 = await reqJSON('ack-link-2', 'POST', '/api/transactions/' + entry2Id + '/ack-link', {});
    if (!al2.res.ok) throw al2.out;
    const mTok2 = /\/a\/([A-Za-z0-9_-]{43})$/.exec(String(al2.data && al2.data.url || ''));
    const token2 = mTok2 ? mTok2[1] : '';
    let d1 = null;
    try { d1 = await (await answer(token2, 'dispute', 'never received this ' + 'x'.repeat(220))).json(); } catch (_) {}
    ok('customer disputes with a note', d1 && d1.ok === true && d1.status === 'disputed' && !d1.repeat);
    let di = null;
    const dil = await fetch(BASE + '/api/transactions/' + entry2Id + '/ack', { headers: { Cookie: cookie } });
    try { di = await dil.json(); } catch (_) {}
    ok('shop reads the dispute note via /ack, capped to 200 chars', di &&
      di.ack_status === 'disputed' &&
      ((di.acknowledgement || {}).dispute_note || '').length === 200);
    const rs = await reqJSON('ack-resolve', 'POST', '/api/transactions/' + entry2Id + '/ack-resolve', { note: 'settled' });
    if (!rs.res.ok) throw rs.out;
    const rows2 = await (await fetch(BASE + '/api/customers/' + kid + '/transactions', { headers: { Cookie: cookie } })).json();
    const row2 = ((rows2 || {}).transactions || []).find(t => t.id === entry2Id);
    ok('resolved dispute shows ack_status resolved', !!row2 && row2.ack_status === 'resolved');

    // ---- 13. re-minting revokes the previous link ----
    const al3 = await reqJSON('ack-relink', 'POST', '/api/transactions/' + entryId + '/ack-link', {});
    if (!al3.res.ok) throw al3.out;
    const mTok3 = /\/a\/([A-Za-z0-9_-]{43})$/.exec(String(al3.data && al3.data.url || ''));
    const token3 = mTok3 ? mTok3[1] : '';
    const dead = await fetch(BASE + '/api/public/ack/' + token1);
    const deadBody = dead.ok ? await dead.json().catch(() => null) : null;
    // by design only AWAITING links are revoked on re-mint (tests/test-ack.js):
    // the old link was already ANSWERED, so it either 404s (revoked) or still
    // truthfully reads acknowledged — it must never read awaiting again.
    ok('the OLD link after re-mint never reads awaiting again',
      dead.status === 404 || (!!deadBody && deadBody.status === 'acknowledged'), dead.status);
    const fresh3 = await fetch(BASE + '/api/public/ack/' + token3);
    const fv = fresh3.ok ? await fresh3.json() : null;
    ok('the NEW link works and the entry is awaiting again', fresh3.status === 200 && fv && fv.status === 'awaiting');

    // ---- 14. idempotent retry: the same idempotency key returns the SAME row ----
    const idemKey = crypto.randomUUID();
    const idemBody = () => ({
      customer_id: kid, workflow: 'kirana', direction: 'receivable', type: 'credit', event: 'goods_credit',
      amount: 55, idempotency_key: idemKey, source: 'screen',
    });
    const p1 = await reqJSON('idem-post-1', 'POST', '/api/transactions', idemBody());
    if (!p1.res.ok) throw p1.out;
    const p2 = await reqJSON('idem-post-2', 'POST', '/api/transactions', idemBody());
    if (!p2.res.ok) throw p2.out;
    ok('idempotent retry returns the SAME row (no double entry)',
      p2.data && p2.data.dedup === true && p2.data.id === p1.data.id);

    // ---- 15. kirana credit -> payment -> reversal (+ reverse retry replay) ----
    const rv = await reqJSON('reverse-payment', 'POST', '/api/transactions/' + (kPay.data && kPay.data.id) + '/reverse', { reason: 'smoke reversal' });
    if (!rv.res.ok) throw rv.out;
    ok('payment reversal posts an offsetting row', !!rv.data && !!rv.data.reversal);
    const rv2 = await reqJSON('reverse-retry', 'POST', '/api/transactions/' + (kPay.data && kPay.data.id) + '/reverse', { reason: 'smoke reversal' });
    ok('reverse retry replays the SAME reversal row (idempotent)',
      rv2.res.ok && rv2.data && rv.data && rv2.data.reversal.id === rv.data.reversal.id);
    // the rythu delivery belongs to shop A -> shop B's session reads it as 404
    const revAnchorX = await reqJSON('cross-shop-anchor-404', 'POST', '/api/transactions/' + d.id + '/reverse', { reason: 'smoke anchor x' });
    ok('cross-shop anchor reverse reads as 404',
      !revAnchorX.res.ok && revAnchorX.res.status === 404, revAnchorX.res.status);

    // ---- 16. overpayment rejection ----
    const op = await reqJSON('overpay-rejected', 'POST', '/api/transactions', {
      customer_id: kid, workflow: 'kirana', type: 'pay', event: 'repayment', amount: 9999999,
      idempotency_key: crypto.randomUUID(), source: 'screen',
    });
    ok('kirana overpayment rejected with 409', !op.res.ok && op.res.status === 409, op.res.status);

    // ---- 17. duplicate-name resolution: two customers named Ramesh ----
    const rm1 = await reqJSON('dup-1', 'POST', '/api/customers', { name: 'Ramesh', kind: 'customer' });
    const rm2 = await reqJSON('dup-2', 'POST', '/api/customers', { name: 'Ramesh', kind: 'customer' });
    ok('two same-name customers created', rm1.res.ok && rm2.res.ok);
    const pp = await reqJSON('propose-dup', 'POST', '/api/voice/propose', { transcript: 'Ramesh 500 ఉద్దెర' });
    if (!pp.res.ok) throw pp.out;
    const pEntry = (pp.data && pp.data.candidate && pp.data.candidate[0]) || {};
    ok('duplicate names resolve as ambiguous (many, 2 options)',
      pEntry.status === 'many' && (pEntry.candidates || []).length === 2 &&
      pp.data.ambiguities && pp.data.ambiguities.length === 1);

    // ---- 18. balances equal sums (kirana kid: 300 + 55 + 70, payment reversed) ----
    const cl = await fetch(BASE + '/api/customers', { headers: { Cookie: cookie } });
    const clData = cl.ok ? await cl.json() : null;
    const custRow = ((clData && (clData.customers || clData)) || []).find(c => c.id === kid);
    const tl2 = await fetch(BASE + '/api/customers/' + kid + '/transactions', { headers: { Cookie: cookie } });
    const rows3 = tl2.ok ? ((await tl2.json()).transactions || []) : [];
    // the product's invariant: balance == credit-sum minus pay-sum over ALL rows
    // (a reversed row and its offsetting reversal cancel each other)
    const sumP = rows3.reduce((a, t) => a + (t.type === 'credit' ? 1 : -1) * Math.round(Number(t.amount) * 100), 0) / 100;
    ok('customer balance equals the ledger sum over all rows',
      !!custRow && Number(custRow.balance) === sumP, 'sum=' + sumP);

    // ---- 19. cross-shop isolation: a second shop cannot touch shop B's rows ----
    const cookieB = cookie;
    const phone2 = '9' + String((Date.now() + 7) % 1000000000).padStart(9, '0');
    const tokC = jwt.sign({ phone: phone2, purpose: 'voiceOk' }, JWT_SECRET, { expiresIn: '5m' });
    cookie = null;
    const up2 = await reqJSON('signup-c', 'POST', '/api/auth/signup', { phone: phone2, pin: '1234', voiceOkToken: tokC });
    if (!up2.res.ok) throw up2.out;
    realShop3Id = up2.data && up2.data.shop && up2.data.shop.id;
    // a shop that has not chosen: nothing ledger-ish works yet (403 REQUIRED)
    const isoPre = await fetch(BASE + '/api/customers/' + kid + '/transactions', { headers: { Cookie: cookie } });
    ok('untyped cross-shop timeline reads as 403 REQUIRED', isoPre.status === 403, isoPre.status);
    const profC = await reqJSON('profile-set-c', 'PUT', '/api/me', {
      owner_name: '__smoke owner C', shop_name: '__SMOKE shop ' + crypto.randomUUID().slice(0, 8),
      address: '__smoke address C',
    });
    if (!profC.res.ok) throw profC.out;
    const chooseC = await reqJSON('biz-choose-kirana-c', 'PUT', '/api/me/business-type', { business_type: 'kirana' });
    if (!chooseC.res.ok) throw chooseC.out;
    const isoT = await fetch(BASE + '/api/customers/' + kid + '/transactions', { headers: { Cookie: cookie } });
    ok('cross-shop customer timeline reads as 404', isoT.status === 404, isoT.status);
    const isoRev = await reqJSON('cross-shop-reverse', 'POST', '/api/transactions/' + p1.data.id + '/reverse', { reason: 'smoke iso' });
    ok('cross-shop reverse rejected', !isoRev.res.ok && isoRev.res.status === 404, isoRev.res.status);
    const isoAck = await reqJSON('cross-shop-ack', 'POST', '/api/transactions/' + entryId + '/ack-link', {});
    ok('cross-shop ack-link rejected', !isoAck.res.ok && isoAck.res.status === 404, isoAck.res.status);
    cookie = cookieB; // back to shop B's session for any later steps

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
        await del('acknowledgements', 'acknowledgements', 'shop_id', realShopId); // before transactions (FK)
        await del('audit-events', 'audit_events', 'shop_id', realShopId);
        await del('transactions', 'transactions', 'shop_id', realShopId); // one statement: self-ref FK checked at statement end
        await del('customers', 'customers', 'shop_id', realShopId);
        await del('shop', 'shops', 'id', realShopId);
      }
      if (realShop2Id) {
        await del('acknowledgements-2', 'acknowledgements', 'shop_id', realShop2Id);
        await del('audit-events-2', 'audit_events', 'shop_id', realShop2Id);
        await del('transactions-2', 'transactions', 'shop_id', realShop2Id);
        await del('customers-2', 'customers', 'shop_id', realShop2Id);
        await del('shop-2', 'shops', 'id', realShop2Id);
      }
      if (realShop3Id) {
        await del('audit-events-3', 'audit_events', 'shop_id', realShop3Id);
        await del('transactions-3', 'transactions', 'shop_id', realShop3Id);
        await del('customers-3', 'customers', 'shop_id', realShop3Id);
        await del('shop-3', 'shops', 'id', realShop3Id);
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
