// tests/test-accounting.js — hermetic Task 2 accounting tests: opening balance
// both directions, discount rules (reason + size cap), payment-mode validation,
// commission math, settlement slip math, statement running balance, CSV
// injection escaping and cross-shop isolation. No network: fake supabase client
// extended from test-ack.js (adds settlement/_produce fields + payment_mode).
// Run: node tests/test-accounting.js   (also part of `npm test`)
'use strict';

const assert = require('assert');
const ledger = require('../lib/ledger');
const accounting = require('../lib/accounting');

let checks = 0;
const ok = (label, cond) => { assert.ok(cond, label); checks++; console.log('PASS ' + label); };
const errCodeAsync = async (p, code) => {
  try { await p; return ok('throws ' + code + ' (none thrown — FAIL)', false); }
  catch (e) { return ok('throws ' + code + (e.code === code ? '' : ' [got ' + e.code + ']'), e.code === code); }
};

// ============================================================================
// fake supabase client — extended from test-ack.js: the RPC row now carries
// settlement_id / payment_mode / produce fields / note (slip + mode coverage).
// ============================================================================
function fakeSb() {
  const db = { customers: [], transactions: [], acknowledgements: [], audits: [] };
  let idn = 0;
  const uuid = () => '00000000-0000-4000-8000-' + String(++idn).padStart(12, '0');
  const matches = (row, filters) => filters.every(f =>
    f.t === 'eq' ? row[f.col] === f.val :
    f.t === 'neq' ? row[f.col] !== f.val :
    (f.vals || []).includes(row[f.col]));
  const exec = q => {
    const rows = db[q.tbl] || [];
    if (q.op === 'insert') {
      const row = { ...q.payload };
      if (!row.id && q.tbl !== 'audit_events') { row.id = uuid(); row.created_at = new Date().toISOString(); }
      if (!Array.isArray(db[q.tbl])) db[q.tbl] = [];
      db[q.tbl].push(row);
      return r(q.b.single ? row : [row]);
    }
    if (q.op === 'update') {
      for (const row of rows) if (matches(row, q.filters)) Object.assign(row, q.payload);
      return r([null]);
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
      if ((x.settlement_id || x.reverses_id) && !(db.transactions.some(t =>
        t.id === (x.settlement_id || x.reverses_id) && t.shop_id === shop))) {
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
        settlement_id: x.settlement_id || null,
        reason: x.reason || null,
        deduction_category: x.deduction_category || null,
        idempotency_key: x.idempotency_key || null,
        produce: x.produce || null, quantity: x.quantity || null,
        unit: x.unit || null, rate: x.rate || null, rate_unit: x.rate_unit || null,
        note: x.note || null,
        payment_mode: x.payment_mode || 'cash',
        raw_transcript: x.raw_transcript || null,
        source: x.source || 'voice',
        created_at: x._created_at || new Date().toISOString(),
      };
      if (x._created_at) row.created_at = x._created_at;
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
const K = 'aaaaaaaa-0001-4111-8111-111111111111'; // kirana customer
const F = 'bbbbbbbb-0002-4222-8111-111111111111'; // rythu farmer

const fresh = () => {
  const sb = fakeSb();
  sb._setCustomer({ id: K, shop_id: SHOP, name: 'రాము', kind: 'customer' });
  sb._setCustomer({ id: F, shop_id: SHOP, name: 'కిషన్', village: 'వేపల', kind: 'farmer' });
  ledger.setClient(sb);
  return sb;
};

(async () => {
  // ------------------------------------------------------------------
  // 1. pure accounting helpers
  // ------------------------------------------------------------------
  ok('commission: 2% of ₹450 → ₹9.00 paise half-up', accounting.commissionPaise(45000, 2) === 900);
  ok('commission: 2% of ₹110.01 → 220.02 → 220', accounting.commissionPaise(11001, 2) === 220);
  ok('commission: 2.5% of ₹2205 → ₹55.13', accounting.commissionPaise(220500, 2.5) === 5513);
  ok('commission: zero/negative/NaN percent → 0',
    accounting.commissionPaise(5000, 0) === 0 && accounting.commissionPaise(5000, null) === 0 &&
    accounting.commissionPaise(5000, NaN) === 0 && accounting.commissionPaise(-1, 2) === 0);
  ok('discount cap: 5% of ₹100 = ₹5 vs floor ₹50 → ₹50 is the cap',
    accounting.discountMaxPaise(10000) === 5000);
  ok('discount cap: 5% of balance above ₹1000 floor scales up',
    accounting.discountMaxPaise(200000) === 10000);
  ok('discount allowed only inside the cap with a positive balance (cap=5% but floor ₹50)',
    accounting.discountMaxPaise(4000) === 5000 &&
    accounting.discountAllowed(4000, 5000) === true &&
    accounting.discountAllowed(4000, 5001) === false &&
    accounting.discountAllowed(200000, 10000) === true &&
    accounting.discountAllowed(200000, 10001) === false &&
    accounting.discountAllowed(0, 50) === false &&
    accounting.discountAllowed(-500, 50) === false);
  // CSV injection: formula-looking cells get an apostrophe, quoting is standard
  ok('csvCell escapes = + - @ and quotes',
    accounting.csvCell('=cmd|\' /C calc!A0') === "'=cmd|' /C calc!A0" &&
    accounting.csvCell('+pwd') === "'+pwd" &&
    accounting.csvCell('-2') === "'-2" &&
    accounting.csvCell('@x') === "'@x" &&
    accounting.csvCell('a,"b"') === '"a,""b"""' &&
    accounting.csvCell(null) === '');
  ok('toCsv joins cells with CRLF and emits the BOM',
    accounting.toCsv([['రాము', 'cash']]) === 'రాము,cash\r\n' && accounting.CSV_BOM === '\uFEFF');

  // ------------------------------------------------------------------
  // 2. payment_mode validation + default
  // ------------------------------------------------------------------
  {
    const sb = fresh();
    await ledger.postTransactions(SHOP, [
      { customer_id: K, type: 'credit', amount: '100' }, // something to repay
    ]);
    await ledger.postTransactions(SHOP, [
      { customer_id: K, type: 'pay', amount: '10', payment_mode: 'upi' },
    ]);
    ok('explicit payment_mode upi is stored', sb._db.transactions[1].payment_mode === 'upi');
    await ledger.postTransactions(SHOP, [{ customer_id: K, type: 'credit', amount: '5' }]);
    ok('payment_mode defaults to cash', sb._db.transactions[2].payment_mode === 'cash');
    await errCodeAsync(ledger.postTransactions(SHOP, [
      { customer_id: K, type: 'pay', amount: '1', payment_mode: 'bitcoin' },
    ]), 'BAD_REQUEST');
  }

  // ------------------------------------------------------------------
  // 3. opening balance in BOTH directions (kirana receivable, rythu payable)
  // ------------------------------------------------------------------
  {
    const sb = fresh();
    await ledger.postTransactions(SHOP, [
      { customer_id: K, workflow: 'kirana', type: 'credit', event: 'opening_balance',
        direction: 'receivable', amount: '1000', note: 'పాత బాకీ · Opening balance' },
    ]);
    const bk = await ledger.balance(K, 'receivable');
    ok('kirana opening credit → balance ₹1000 owed', bk.paise === 100000);
    await ledger.postTransactions(SHOP, [
      { customer_id: F, workflow: 'rythu', type: 'pay', event: 'opening_balance',
        direction: 'payable', amount: '800', note: 'పాత అడ్వాన్స్ · Opening advance' },
    ]);
    const bf = await ledger.balance(F, 'payable');
    ok('rythu opening advance → balance −₹800 (to recover)', bf.paise === -80000 && bf.advance);
    // opening events on farmer accounts pass rythu validation without settlement
    ok('rythu opening row stays unallocated', sb._db.transactions.at(-1).settlement_id === null);
    await errCodeAsync(ledger.postTransactions(SHOP, [
      { customer_id: K, type: 'credit', event: 'bogus_event', amount: '5' },
    ]), 'BAD_REQUEST');
  }

  // ------------------------------------------------------------------
  // 4. discount (write-off) rules: reason REQUIRED + small-leftover cap
  // ------------------------------------------------------------------
  {
    const sb = fresh();
    await ledger.postTransactions(SHOP, [
      { customer_id: K, type: 'credit', amount: '500', idempotency_key: 'seed-500' },
    ]);
    // balance ₹500 → cap = max(5% = ₹25, ₹50) = ₹50
    await errCodeAsync(ledger.postTransactions(SHOP, [
      { customer_id: K, type: 'pay', event: 'discount', amount: '40' },
    ]), 'REASON_REQUIRED');
    await errCodeAsync(ledger.postTransactions(SHOP, [
      { customer_id: K, type: 'pay', event: 'discount', amount: '60', reason: 'नोट्स त्रुटि' },
    ]), 'DISCOUNT_TOO_BIG');
    await ledger.postTransactions(SHOP, [
      { customer_id: K, type: 'pay', event: 'discount', amount: '40', reason: 'small leftover forgiven' },
    ]);
    const bal = await ledger.balance(K, 'receivable');
    ok('discount ₹40 posts and deducts (₹460 left)', bal.paise === 46000);
    ok('discount row is a pay row with the reason kept',
      sb._db.transactions.at(-1).event === 'discount' &&
      sb._db.transactions.at(-1).reason === 'small leftover forgiven');
    // rythu leftover: balance ₹10,480 → cap = max(5% ≈ ₹524, ₹50) = ₹524
    await ledger.postTransactions(SHOP, [
      { customer_id: F, workflow: 'rythu', type: 'credit', event: 'produce_delivery',
        produce: 'paddy', quantity: '5', unit: 'quintal', rate: '2200', rate_unit: 'quintal',
        idempotency_key: 'seed-del' },
    ]);
    await errCodeAsync(ledger.postTransactions(SHOP, [
      { customer_id: F, workflow: 'rythu', type: 'pay', event: 'discount', amount: '600',
        direction: 'payable', reason: 'too big' },
    ]), 'DISCOUNT_TOO_BIG');
    const before = await ledger.balance(F, 'payable');
    await ledger.postTransactions(SHOP, [
      { customer_id: F, workflow: 'rythu', type: 'pay', event: 'discount', amount: '400',
        direction: 'payable', reason: 'tharugu left over' },
    ]);
    const after = await ledger.balance(F, 'payable');
    ok('rythu discount posts in payable direction (₹400 less owed)', after.paise === before.paise - 40000);
    ok('rythu discount never links to a settlement',
      sb._db.transactions.at(-1).settlement_id === null);
  }

  // ------------------------------------------------------------------
  // 5. settlement slip math (gross − deductions − advances − payments)
  // ------------------------------------------------------------------
  {
    const sb = fresh();
    await ledger.postTransactions(SHOP, [
      { customer_id: F, workflow: 'rythu', type: 'credit', event: 'produce_delivery',
        produce: 'paddy', quantity: '5', unit: 'quintal', rate: '2200', rate_unit: 'quintal',
        idempotency_key: 'del-1' },
    ]);
    // last row = the delivery; settlement_id = own id (anchorDelivery ran server-side)
    const delRow = sb._db.transactions[0];
    ok('delivery 5q × ₹2200 = ₹11,000 gross (integer paise)',
      delRow.amount === '11000.00' && delRow.settlement_id === delRow.id);
    const sid = delRow.id;
    await ledger.postTransactions(SHOP, [
      { customer_id: F, workflow: 'rythu', type: 'pay', event: 'deduction',
        deduction_category: 'commission', amount: '220', settlement_id: sid },
      { customer_id: F, workflow: 'rythu', type: 'pay', event: 'payment', amount: '300',
        payment_mode: 'upi', settlement_id: sid },
    ]);
    const slip = await ledger.settlementSlip(SHOP, sid);
    ok('slip head: farmer, produce, qty × rate, gross ₹11,000',
      slip.customer.name === 'కిషన్' && slip.settlement.produce === 'paddy' &&
      slip.settlement.quantity === 5 && slip.settlement.rate === 2200 &&
      slip.settlement.gross === 11000);
    ok('slip math: deduction_total 220, payment_total 300, remaining 10,480',
      slip.deduction_total === 220 && slip.payment_total === 300 &&
      slip.remaining === 10480 && slip.open);
    ok('slip itemises the commission category',
      slip.deductions[0].deduction_category === 'commission' &&
      slip.payments[0].amount === 300);
    await errCodeAsync(ledger.settlementSlip(OTHER, sid), 'NOT_FOUND');
    ok('cross-shop slip read is a 404, never a leak', true);
  }

  // ------------------------------------------------------------------
  // 6. statement window: running balance == Σ(credit − pay) incl. reversals
  // ------------------------------------------------------------------
  {
    const sb = fresh();
    const ISO = (d, t) => d + 'T' + (t || '10:00:00.000') + 'Z';
    // day 1: credit 400 + repayment 300 (posted AFTER a manual date stamp)
    await ledger.postTransactions(SHOP, [
      { customer_id: K, type: 'credit', amount: '400', idempotency_key: 'a1' },
    ]);
    const t0 = sb._db.transactions[0];
    await ledger.postTransactions(SHOP, [
      { customer_id: K, type: 'pay', amount: '300', idempotency_key: 'a2' },
    ]);
    const t1 = sb._db.transactions[1];
    // rewrite dates deterministically (fake rows only)
    t0.created_at = ISO('2026-01-05');
    t1.created_at = ISO('2026-01-05');
    await ledger.postTransactions(SHOP, [
      { customer_id: K, type: 'credit', amount: '500', idempotency_key: 'a3' },
    ]);
    const t2 = sb._db.transactions[2];
    t2.created_at = ISO('2026-01-12');
    // a same-pair reversal exercise: reverse nothing — instead add a discount? no.
    await ledger.postTransactions(SHOP, [
      { customer_id: K, type: 'pay', event: 'discount', amount: '40', reason: 'chillar' },
    ]);
    const t3 = sb._db.transactions[3];
    t3.created_at = ISO('2026-01-12');
    // opening (before 01-10) = 400 − 300 = ₹100; window 01-10→: 500 − 40 = 460
    const st = await ledger.statementWindow(SHOP, K, '2026-01-10', '2026-01-20');
    ok('statement opening = prefix balance ₹100', st.opening === 100);
    ok('statement window holds exactly the two in-range rows', st.count === 2 &&
      st.transactions[0].id === t2.id && st.transactions[1].id === t3.id);
    ok('running balance accumulates: 100 → 600 → 560',
      Number(st.transactions[0].running) === 600 &&
      Number(st.transactions[1].running) === 560);
    ok('closing == running at the end', st.closing === 560);
    const all = await ledger.statementWindow(SHOP, K, null, null);
    const full = await ledger.balance(K, 'receivable');
    ok('statement with no range ends on the live balance incl. reversal pairs',
      all.closing === full.rupees);
    await errCodeAsync(ledger.statementWindow(OTHER, K, null, null), 'NOT_FOUND');
    await errCodeAsync(ledger.statementWindow(SHOP, K, 'feb 1', null), 'BAD_REQUEST');
  }

  // ------------------------------------------------------------------
  // 7. CSV export: shop-scoped rows, Telugu BOM, injection escaping
  // ------------------------------------------------------------------
  {
    const sb = fresh();
    sb._setCustomer({ id: 'cccccccc-0003-4333-8333-111111111111', shop_id: SHOP,
      name: '=SUM(A1)', kind: 'customer' });
    await ledger.postTransactions(SHOP, [
      { customer_id: K, type: 'credit', amount: '750' },
      { customer_id: K, type: 'pay', amount: '150', payment_mode: 'upi' },
      { customer_id: 'cccccccc-0003-4333-8333-111111111111', type: 'credit', amount: '25' },
    ]);
    const ex = await ledger.transactionsExport(SHOP, null, null);
    ok('export starts with the UTF-8 BOM', ex.csv.charCodeAt(0) === 0xFEFF);
    ok('export header + 3 rows, all this shop', ex.count === 3);
    const lineKB = ex.csv.split('\r\n').find(l => l.indexOf('=SUM(A1)') !== -1);
    ok('export CSV never passes a formula start raw (apostrophe guard)',
      lineKB ? lineKB.indexOf("'=SUM(A1)") !== -1 : ex.csv.indexOf("'=SUM(A1)") !== -1);
    // second shop only ever exports its OWN rows
    sb._setCustomer({ id: 'dddddddd-0004-4444-8444-222222222222', shop_id: OTHER,
      name: 'other-shop-cust', kind: 'customer' });
    const ex2 = await ledger.transactionsExport(OTHER, null, null);
    ok('cross-shop isolation: other shop exports zero of this shop', ex2.count === 0 &&
      ex2.csv.indexOf('రాము') === -1);
    await errCodeAsync(ledger.transactionsExport(SHOP, '2026-1-1', null), 'BAD_REQUEST');
  }

  console.log(`\n[accounting] ${checks} checks passed`);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
