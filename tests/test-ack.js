// tests/test-ack.js — hermetic Sprint 3 acknowledgement tests: token secrecy,
// single-response, expiry, revoke-on-reversal, debt rejection, cross-shop,
// public payload minimality. No network, no Supabase: a fake client with
// supabase-js chain semantics backs lib/ack.js (+ lib/ledger.js for reversals).
// Run: node tests/test-ack.js   (also part of `npm test`)
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const ack = require('../lib/ack');
const ledger = require('../lib/ledger');

let checks = 0;
const ok = (label, cond) => { assert.ok(cond, label); checks++; console.log('PASS ' + label); };
const errCode = (fn, code) => {
  try { fn(); return ok('throws ' + code + ' (none thrown — FAIL)', false); }
  catch (e) { return ok('throws ' + code + (e.code === code ? '' : ' [got ' + e.code + ']'), e.code === code); }
};
const errCodeAsync = async (p, code) => {
  try { await p; return ok('throws ' + code + ' (none thrown — FAIL)', false); }
  catch (e) { return ok('throws ' + code + (e.code === code ? '' : ' [got ' + e.code + ']'), e.code === code); }
};

// ============================================================================
// fake supabase client — extended from test-ledger.js: adds the
// acknowledgements table, `.neq` filters and auto id/created_at on inserts.
// ============================================================================
function fakeSb() {
  const db = { customers: [], transactions: [], acknowledgements: [], audits: [] };
  let idn = 0;
  const uuid = () => '00000000-0000-4000-8000-' + String(++idn).padStart(12, '0');
  const now = () => new Date().toISOString();

  const matches = (row, filters) => filters.every(f =>
    f.t === 'eq' ? row[f.col] === f.val :
    f.t === 'neq' ? row[f.col] !== f.val :
    (f.vals || []).includes(row[f.col]));

  const exec = q => {
    const rows = db[q.tbl] || [];
    if (q.op === 'insert') {
      const row = { ...q.payload };
      if (!row.id && q.tbl !== 'audit_events') { row.id = uuid(); row.created_at = now(); }
      if (!Array.isArray(db[q.tbl])) db[q.tbl] = [];
      db[q.tbl].push(row);
      if (q.tbl === 'audit_events') { db.audits.push(row); return r([row]); }
      if (q.b.single) return r(row);
      return r([row]);
    }
    if (q.op === 'update') {
      let n = 0;
      for (const row of rows) if (matches(row, q.filters)) { n++; Object.assign(row, q.payload); }
      return r(n ? [null] : []);
    }
    let out = rows.filter(row => matches(row, q.filters));
    if (q.limitN != null) out = out.slice(0, q.limitN);
    if (q.orderCol) out = out.slice().sort((a, b) => String(b[q.orderCol]).localeCompare(String(a[q.orderCol])));
    return r(out.map(row => ({ ...row })));
  };
  const r = data => ({ data, error: null });

  const chain = (tbl, q) => {
    const b = {
      select: c => { q.sel = c || '*'; if (q.op === 'insert') q.b.single = true; return b; },
      insert: p => { q.op = 'insert'; q.payload = Array.isArray(p) ? p[0] : p; return b; },
      update: p => { q.op = 'update'; q.payload = p; return b; },
      delete: () => { q.op = 'delete'; return b; },
      eq: (col, val) => { q.filters.push({ t: 'eq', col, val }); return b; },
      neq: (col, val) => { q.filters.push({ t: 'neq', col, val }); return b; },
      in: (col, vals) => { q.filters.push({ t: 'in', col, vals }); return b; },
      limit: n => { q.limitN = n; return b; },
      order: col => { q.orderCol = col; return b; },
      single: () => { q.b.single = true; return b; },
      then: (res, rej) => Promise.resolve(exec(q)).then(res, rej),
      catch: rej => Promise.resolve(exec(q)).catch(rej),
      finally: f => Promise.resolve(exec(q)).finally(f),
    };
    return b;
  };

  const rpc = (name, args) => {
    if (name !== 'post_transactions') throw new Error('unknown rpc ' + name);
    const { p_shop_id: shop, p_rows: rows } = args;
    if (!Array.isArray(rows) || !rows.length) throw { message: 'BAD_ROWS' };
    for (const x of rows) {
      if (!(db.customers.some(c => c.id === x.customer_id && c.shop_id === shop))) {
        return { data: null, error: { message: 'CUSTOMER_NOT_OWNED', code: 'P0001' } };
      }
      if (x.reverses_id && !(db.transactions.some(t => t.id === x.reverses_id && t.shop_id === shop))) {
        return { data: null, error: { message: 'REFS_NOT_OWNED', code: 'P0001' } };
      }
      if (x.customer_id == null || x.type == null || x.amount == null) {
        return { data: null, error: { message: 'ROW_INCOMPLETE', code: 'P0001' } };
      }
    }
    const out = [];
    for (const x of rows) {
      const existing = x.idempotency_key &&
        db.transactions.find(t => t.shop_id === shop && t.idempotency_key === x.idempotency_key);
      if (existing) { out.push({ ...existing }); continue; }
      const row = {
        id: uuid(), shop_id: shop, customer_id: x.customer_id, type: x.type,
        amount: Number(x.amount).toFixed(2),
        event: x.event || (x.type === 'credit' ? 'goods_credit' : 'repayment'),
        direction: x.direction || 'receivable',
        workflow: x.workflow || 'kirana',
        status: x.status || 'posted',
        ack_status: x.ack_status || 'not_required',
        reverses_id: x.reverses_id || null,
        reason: x.reason || null,
        idempotency_key: x.idempotency_key || null,
        raw_transcript: x.raw_transcript || null,
        source: x.source || 'voice',
        created_at: now(),
      };
      db.transactions.push(row);
      out.push({ ...row });
    }
    return { data: out, error: null };
  };

  return {
    from: tbl => chain(tbl, { tbl, filters: [], b: {} }),
    rpc,
    _db: db, _setCustomer: c => db.customers.push(c), _setTx: t => db.transactions.push(t),
  };
}

const SHOP = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-3333-4444-8222-222222222222';
const A = 'aaaaaaaa-0001-4111-8111-111111111111';
const B = 'bbbbbbbb-0002-4222-8111-111111111111';
const X = '99999999-0009-4999-9222-222222222222'; // owned by OTHER shop

const fresh = () => {
  const sb = fakeSb();
  sb._setCustomer({ id: A, shop_id: SHOP, name: 'cust-a', kind: 'customer', phone: '9876543210' });
  sb._setCustomer({ id: B, shop_id: SHOP, name: 'cust-b', kind: 'farmer', phone: '9123456780' });
  ledger.setClient(sb);
  ack.setClient(sb);
  return sb;
};

(async () => {
  // -- token secrecy: randomness, shape, hash-only storage --
  const t1 = ack.newToken(), t2 = ack.newToken();
  ok('tokens match the 43-char base64url shape', ack.TOKEN_RE.test(t1) && ack.TOKEN_RE.test(t2));
  ok('tokens are random (two differ)', t1 !== t2);
  ok('token hash is sha-256 hex, never the raw token',
    ack.hashToken(t1).length === 64 && ack.hashToken(t1) !== t1 &&
    /^[0-9a-f]{64}$/.test(ack.hashToken(t1)));

  // -- happy path: mint a link for one credit entry --
  let sb = fresh();
  const [entry] = await ledger.postTransactions(SHOP, [{ customer_id: A, type: 'credit', amount: 500, idempotency_key: 'k1' }]);
  const mint = () => ack.createLink(SHOP, entry.id);
  let link = await mint();
  ok('link returns a fresh raw token exactly once', ack.TOKEN_RE.test(link.token));
  const dbAck = sb._db.acknowledgements;
  ok('exactly one acknowledgement row after minting', dbAck.length === 1);
  const allDbJson = JSON.stringify(sb._db);
  ok('the raw token NEVER reaches the database', allDbJson.indexOf(link.token) === -1);
  ok('only the token HASH is stored', dbAck[0].token_hash === ack.hashToken(link.token));
  ok('entry moved to ack_status awaiting',
    sb._db.transactions.find(t => t.id === entry.id).ack_status === 'awaiting');
  ok('link expires ~14 days out', new Date(dbAck[0].expires_at).getTime() > Date.now() + 13 * 24 * 3600e3);
  ok('mint is audited (action only, no token)', sb._db.audits.some(a => a.action === 'ack-link'));

  // -- minting again revokes the previous ACTIVE link --
  const link2 = await mint();
  ok('re-mint keeps exactly ONE awaiting row',
    dbAck.filter(a => a.status === 'awaiting').length === 1 &&
    dbAck.filter(a => a.status === 'revoked').length === 1);
  const revokedHash = dbAck.find(a => a.status === 'revoked').token_hash;
  ok('the old link is the one that got revoked', revokedHash === ack.hashToken(link.token));

  // -- public view minimality (no phone/balance/other rows) --
  const looked = await ack.viewByToken(link2.token);
  ok('fresh token resolves as awaiting', looked && looked.status === 'awaiting');
  const view = ack.publicView(looked.status, looked.ack, looked.tx, 'Sai Kirana');
  const vJson = JSON.stringify(view);
  ok('public view leaks no phone', vJson.indexOf('98765') === -1);
  ok('public view leaks no customer name/id', vJson.indexOf('cust-') === -1 && vJson.indexOf(A) === -1);
  ok('public view is strictly the announced fields',
    Object.keys(view).every(k => ['status', 'shop_name', 'entry_date', 'entry_kind',
      'amount', 'item', 'responded_at', 'dispute_note'].includes(k)));
  ok('view shows the amount and shop name', view.amount === 500 && view.shop_name === 'Sai Kirana');

  // -- single-response rule: acknowledge, then repeat is a no-op --
  const first = await ack.respond(link2.token, 'acknowledge');
  ok('acknowledge resolves OK', first.code === 'OK' && first.status === 'acknowledged' && !first.repeat);
  const after = dbAck.find(a => a.id === dbAck[dbAck.length - 1].id) || dbAck[dbAck.length - 1];
  const stamp = dbAck.find(a => a.status === 'acknowledged').responded_at;
  const again = await ack.respond(link2.token, 'acknowledge');
  ok('repeat response is an idempotent no-op', again.code === 'OK' && again.repeat === true &&
    dbAck.find(a => a.status === 'acknowledged').responded_at === stamp);
  const flip = await ack.respond(link2.token, 'dispute', 'too costly');
  ok('a given answer can never flip to the other action', flip.repeat === true && flip.status === 'acknowledged');
  ok('entry ack_status acknowledged', sb._db.transactions.find(t => t.id === entry.id).ack_status === 'acknowledged');
  ok('dispute note was NOT stored on an acknowledge', after.dispute_note == null);

  // -- dispute stores a trimmed, 200-char-capped note --
  sb = fresh();
  const [e2] = await ledger.postTransactions(SHOP, [{ customer_id: B, type: 'credit', amount: 120, event: 'produce_delivery', workflow: 'rythu', direction: 'payable', idempotency_key: 'p1', produce: 'Tomato', quantity: 10, unit: 'kg', rate: 12, rate_unit: 'kg' }]);
  const l2 = await ack.createLink(SHOP, e2.id);
  const long = 'x'.repeat(300);
  const d = await ack.respond(l2.token, 'dispute', '   ' + long + '   ');
  ok('dispute response OK', d.code === 'OK' && d.status === 'disputed');
  const dRow = sb._db.acknowledgements[0];
  ok('dispute note trimmed and capped to 200', dRow.dispute_note === 'x'.repeat(200));
  ok('entry ack_status disputed', sb._db.transactions.find(t => t.id === e2.id).ack_status === 'disputed');
  ok('dispute is audited without note/ip/token',
    sb._db.audits.some(a => a.action === 'ack-response' &&
      JSON.stringify(a).indexOf('xxx') === -1 && JSON.stringify(a).indexOf(l2.token) === -1));

  // -- debt side may never be acknowledged --
  const [ePay] = await ledger.postTransactions(SHOP, [{ customer_id: A, type: 'credit', amount: 100, idempotency_key: 'kw' }]);
  const [payEntry] = await ledger.postTransactions(SHOP, [{ customer_id: A, type: 'pay', amount: 50, idempotency_key: 'k2' }]);
  await errCodeAsync(ack.createLink(SHOP, payEntry.id), 'ACK_NOT_ALLOWED');
  sb._setTx({ id: 'ded00000-0003-4111-8111-111111111111', shop_id: SHOP, customer_id: A, type: 'credit', amount: '5.00', event: 'deduction', status: 'posted', created_at: new Date().toISOString() });
  await errCodeAsync(ack.createLink(SHOP, 'ded00000-0003-4111-8111-111111111111'), 'ACK_NOT_ALLOWED');

  // -- bad states: reversed entries, unknown, cross-shop --
  const [e3] = await ledger.postTransactions(SHOP, [{ customer_id: A, type: 'credit', amount: 70, idempotency_key: 'r3' }]);
  await ledger.reverseTransaction(SHOP, e3.id, 'wrong');
  await errCodeAsync(ack.createLink(SHOP, e3.id), 'ACK_BAD_STATE');
  await errCodeAsync(ack.createLink(SHOP, '00000000-0004-4000-8000-00000000dead'), 'NOT_FOUND');
  sb._setTx({ id: 'ee000000-0004-4111-8111-111111111111', shop_id: OTHER, customer_id: X, type: 'credit', amount: '77.00', event: 'goods_credit', status: 'posted', created_at: new Date().toISOString() });
  await errCodeAsync(ack.createLink(SHOP, 'ee000000-0004-4111-8111-111111111111'), 'NOT_FOUND');
  await errCodeAsync(ack.createLink(SHOP, '0000000-000-0000-0000-00000000000'), 'ACK_BAD_STATE'); // uuid shape

  // -- revocation by reversal: link goes dead, page reads cancelled --
  sb = fresh();
  const [e4] = await ledger.postTransactions(SHOP, [{ customer_id: A, type: 'credit', amount: 300, idempotency_key: 'k4' }]);
  const l4 = await ack.createLink(SHOP, e4.id);
  await ledger.reverseTransaction(SHOP, e4.id, 'wrong entry');
  ok('reversal revokes the active link', sb._db.acknowledgements[0].status === 'revoked');
  ok('reversal moves entry ack_status to cancelled',
    sb._db.transactions.find(t => t.id === e4.id).ack_status === 'cancelled');
  const revoked = await ack.viewByToken(l4.token);
  ok('revoked token page reads as cancelled', revoked && revoked.status === 'cancelled');
  ok('revoked token cannot respond', (await ack.respond(l4.token, 'acknowledge')).code === 'NOT_FOUND');
  ok('revoked view never touches the old tx', revoked.tx == null);

  // -- expiry: link past its 14-day TTL is a generic 404 everywhere --
  sb = fresh();
  const [e5] = await ledger.postTransactions(SHOP, [{ customer_id: A, type: 'credit', amount: 90, idempotency_key: 'k5' }]);
  const l5 = await ack.createLink(SHOP, e5.id);
  sb._db.acknowledgements[0].expires_at = new Date(Date.now() - 1000).toISOString();
  const expired = await ack.viewByToken(l5.token);
  ok('expired token page reads expired', expired && expired.status === 'expired');
  ok('expired token cannot respond', (await ack.respond(l5.token, 'dispute', 'late')).code === 'NOT_FOUND');

  // -- unknown / malformed tokens are always the generic answer --
  ok('malformed token -> no page', (await ack.viewByToken('short')) === null);
  const unknownTok = crypto.randomBytes(32).toString('base64url');
  ok('unknown 43-char token -> no page', (await ack.viewByToken(unknownTok)) === null);
  ok('unknown token respond -> NOT_FOUND', (await ack.respond(unknownTok, 'acknowledge')).code === 'NOT_FOUND');
  ok('bad action shape -> NOT_FOUND', (await ack.respond(unknownTok, 'delete')).code === 'NOT_FOUND');

  // -- dispute resolution (shop side, scoped) --
  sb = fresh();
  const [e6] = await ledger.postTransactions(SHOP, [{ customer_id: A, type: 'credit', amount: 60, idempotency_key: 'k6' }]);
  const l6 = await ack.createLink(SHOP, e6.id);
  await ack.respond(l6.token, 'dispute', 'never received sugar');
  ok('shop sees the dispute via info()', (await ack.info(SHOP, e6.id)).acknowledgement.dispute_note === 'never received sugar');
  ok('cross-shop info of another shop\'s tx is invisible', (await ack.info('33333333-4444-4666-8333-333333333333', e6.id)) === null);
  await ack.resolveDispute(SHOP, e6.id, 'settled');
  ok('resolution lands on both rows',
    sb._db.transactions.find(t => t.id === e6.id).ack_status === 'resolved' &&
    sb._db.acknowledgements[0].status === 'resolved' && sb._db.acknowledgements[0].resolved_at);
  await errCodeAsync(ack.resolveDispute(SHOP, e6.id, 'again'), 'NOT_DISPUTED'); // already resolved
  await errCodeAsync(ack.resolveDispute(OTHER, e6.id, 'steal'), 'ACK_BAD_STATE'); // another shop's tx
  const [e7] = await ledger.postTransactions(SHOP, [{ customer_id: A, type: 'credit', amount: 20, idempotency_key: 'k7' }]);
  await errCodeAsync(ack.resolveDispute(SHOP, e7.id, 'nothing disputed'), 'NOT_DISPUTED');
  // -- dashboard counts + disputed badges --
  sb = fresh();
  const [e8] = await ledger.postTransactions(SHOP, [{ customer_id: A, type: 'credit', amount: 40, idempotency_key: 'k8' }]);
  await ack.createLink(SHOP, e8.id); // awaiting
  const [e9] = await ledger.postTransactions(SHOP, [{ customer_id: A, type: 'credit', amount: 8, idempotency_key: 'k9' }]);
  const l9 = await ack.createLink(SHOP, e9.id);
  await ack.respond(l9.token, 'acknowledge'); // acknowledged
  const [e10] = await ledger.postTransactions(SHOP, [{ customer_id: A, type: 'credit', amount: 3, idempotency_key: 'ka' }]);
  const l10 = await ack.createLink(SHOP, e10.id);
  await ack.respond(l10.token, 'dispute', 'bad tomato'); // disputed
  const sum = await ack.shopSummary(SHOP);
  ok('shopSummary counts awaiting/acknowledged/disputed',
    sum.awaiting === 1 && sum.acknowledged === 1 && sum.disputed === 1);
  const ds = await ack.disputedByCustomer(SHOP);
  ok('disputedByCustomer flags only customers with POSTED disputed entries',
    ds.size === 1 && ds.has(A) && !ds.has(B));

  // -- audit hygiene across the whole flow --
  const blobs = sb._db.audits.map(a => JSON.stringify(a)).join('|');
  ok('audits never carry raw tokens, hashes or notes',
    blobs.indexOf(l10.token) === -1 && blobs.indexOf('bad tomato') === -1 &&
    !/[0-9a-f]{64}/.test(blobs));

  console.log('\nALL ' + checks + ' CHECKS PASSED');
})().catch(e => { console.error('FAIL: ' + (e.stack || e)); process.exit(1); });
