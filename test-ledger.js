// test-ledger.js — hermetic ledger + money tests for sprint 1.
// No network, no Supabase: a fake client with supabase-js chain semantics
// (select/eq/in/limit/insert/update/rpc + thenable) backs lib/ledger.js.
// Run: node test-ledger.js   (also part of `npm test`)
'use strict';

const assert = require('assert');
const money = require('./lib/money');
const ledger = require('./lib/ledger');

let checks = 0;
const ok = (label, cond) => { assert.ok(cond, label); checks++; console.log('PASS ' + label); };
const errCode = (fn, code) => {
  try { fn(); return ok('throws ' + code + ' (none thrown — FAIL)', false); }
  catch (e) { return ok('throws ' + code + (e.code === code ? '' : ' [got ' + e.code + ']'), e.code === code); }
};

// ============================================================================
// money: exact paise math, half-up rounding, units
// ============================================================================
ok('toPaise integer 500 -> 50000', money.toPaise(500) === 50000);
ok('toPaise "499.50" -> 49950', money.toPaise('499.50') === 49950);
ok('toPaise 0.1 float artifact -> exact 10', money.toPaise(0.1) === 10);
ok('toPaise -0.99 -> -99', money.toPaise('-0.99') === -99);
errCode(() => money.toPaise('1.999'), 'AMOUNT_PRECISION');
errCode(() => money.toPaise('1e5'), 'AMOUNT_BAD');
errCode(() => money.toPaise(''), 'AMOUNT_BAD');
errCode(() => money.toPaise('100000000000'), 'AMOUNT_TOO_LARGE'); // numeric(12,2) cap
ok('paiseToRupees 4500 -> 45', money.paiseToRupees(4500) === 45);
ok('paiseToRupees -330 -> -3.3', money.paiseToRupees(-330) === -3.3);
ok('toMilli 2.675 -> 2675', money.toMilli('2.675') === 2675);
errCode(() => money.toMilli('0.0001'), 'QUANTITY_PRECISION');
errCode(() => money.toMilli('0'), 'QUANTITY_BAD');     // quantities strictly positive
errCode(() => money.toMilli('-2'), 'QUANTITY_BAD');
ok('rateToPaise 31.25 -> 3125', money.rateToPaise('31.25') === 3125);
ok('half-up 0.005 kg x 1.00 -> 1 paise', money.qtyRatePaise(money.toMilli('0.005'), money.rateToPaise('1.00')) === 1);
ok('half-up 1.005 @ 1.00 -> 101', money.qtyRatePaise(money.toMilli('1.005'), 100) === 101);
ok('2.675 kg @ 4.00 -> 1070', money.qtyRatePaise(money.toMilli('2.675'), money.rateToPaise('4.00')) === 1070);
ok('1 quintal = 100 kg', money.toKg(money.toMilli('1'), 'quintal') === 100);
ok('1 tonne = 1000 kg', money.toKg(money.toMilli('1'), 'tonne') === 1000);
ok('2 bags x 50 kg = 100 kg', money.toKg(money.toMilli('2'), 'bag', '50') === 100);
errCode(() => money.toKg(money.toMilli('2'), 'bag'), 'MISSING_BAG_WEIGHT');
errCode(() => money.toKg(money.toMilli('5'), 'litre'), 'UNIT_UNSUPPORTED');
errCode(() => money.amountFromQtyRate('10', '0', 'kg'), 'RATE_BAD');
ok('10 kg @ 31.25 -> 31250 paise', money.amountFromQtyRate('10', '31.25', 'kg') === 31250);
ok('1 quintal @ 5000 -> 500000 paise', money.amountFromQtyRate('1', '5000', 'quintal') === 500000);

// ============================================================================
// fake supabase client
// ============================================================================
function fakeSb() {
  const db = { customers: [], transactions: [], audits: [] };
  let idn = 0;
  const uuid = () => '00000000-0000-4000-8000-' + String(++idn).padStart(12, '0');
  const now = () => new Date().toISOString();

  const matches = (row, filters) => filters.every(f =>
    f.t === 'eq' ? row[f.col] === f.val : (f.vals || []).includes(row[f.col]));

  const exec = q => {
    const rows = db[q.tbl] || [];
    if (q.op === 'insert') {
      const row = { ...q.payload };
      if (q.tbl === 'audit_events') { db.audits.push(row); return r([row]); }
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
      select: c => { q.sel = c || '*'; return b; },
      insert: p => { q.op = 'insert'; q.payload = Array.isArray(p) ? p[0] : p; return b; },
      update: p => { q.op = 'update'; q.payload = p; return b; },
      delete: () => { q.op = 'delete'; return b; },
      eq: (col, val) => { q.filters.push({ t: 'eq', col, val }); return b; },
      in: (col, vals) => { q.filters.push({ t: 'in', col, vals }); return b; },
      limit: n => { q.limitN = n; return b; },
      order: (col) => { q.orderCol = col; return b; },
      single: () => b,
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
    // ownership of every customer id (mirrors the migration's CUSTOMER_NOT_OWNED)
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
        // numeric(12,2) columns COME BACK AS STRINGS from supabase — mimic that
        amount: Number(x.amount).toFixed(2),
        event: x.event || (x.type === 'credit' ? 'goods_credit' : 'repayment'),
        direction: x.direction || 'receivable',
        workflow: x.workflow || 'kirana',
        status: x.status || 'posted',
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
    from: tbl => chain(tbl, { tbl, filters: [] }),
    rpc,
    // test-only accessors
    _db: db, _setCustomer: c => db.customers.push(c),
    _setTx: t => db.transactions.push(t), _alarms: db.audits,
  };
}

const SHOP = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-3333-4444-8222-222222222222';
const cust = id => ({ id, shop_id: SHOP, name: 'cust-' + id.slice(0, 4) });
const A = 'aaaaaaaa-0001-4111-8111-111111111111';
const B = 'bbbbbbbb-0002-4222-8111-111111111111';
const C = 'cccccccc-0003-4333-8111-111111111111';
const X = '99999999-0009-4999-9222-222222222222'; // belongs to OTHER shop

// ============================================================================
// ledger: posting, idempotency, balance, overpayment, cross-shop, reversal
// ============================================================================
const fresh = () => {
  const sb = fakeSb();
  sb._setCustomer(cust(A));
  sb._setCustomer(cust(B));
  sb._setCustomer(cust(C));
  ledger.setClient(sb);
  return sb;
};

// -- single kirana credit + balance --
let sb = fresh();
ledger.postTransactions(SHOP, [{ customer_id: A, type: 'credit', amount: 500, idempotency_key: 'k1' }])
  .then(rows => {
    ok('credit post returns 1 row', rows.length === 1);
    ok('credit amount round-trips as 500 rupees', rows[0].amount === 500 && rows[0].type === 'credit');
    ok('credit is not dedup on first post', rows[0].dedup === false);
    return ledger.balance(A, 'receivable');
  })
  .then(bal => {
    ok('balance after credit = 500', bal.rupees === 500 && bal.paise === 50000);
    // idempotent RETRY with the same key: the SAME row comes back, no second row
    return ledger.postTransactions(SHOP, [{ customer_id: A, type: 'credit', amount: 500, idempotency_key: 'k1' }]);
  })
  .then(rows => {
    ok('retry marks dedup', rows.length === 1 && rows[0].dedup === true);
    ok('retry did not create a second row', sb._db.transactions.length === 1);
    // pay 200 -> balance 300; the Chrome checklist path
    return ledger.postTransactions(SHOP, [{ customer_id: A, type: 'pay', amount: 200, idempotency_key: 'k2' }]);
  })
  .then(() => ledger.balance(A, 'receivable'))
  .then(bal => {
    ok('balance credit 500 - pay 200 = 300', bal.rupees === 300);
    // OVERPAYMENT guard: a kirana repayment above the outstanding is rejected
    return ledger.postTransactions(SHOP, [{ customer_id: A, type: 'pay', amount: 2000, idempotency_key: 'k3' }])
      .then(() => ok('overpay throws OVERPAYMENT (FAIL: no error)', false))
      .catch(e => ok('overpay rejected with OVERPAYMENT [got ' + e.code + ']', e.code === 'OVERPAYMENT'));
  })
  .then(() => {
    ok('rejected overpay inserted NOTHING', sb._db.transactions.length === 2);
    // payable direction: negative balance is LEGAL -> "advance to recover"
    return ledger.postTransactions(SHOP, [{
      customer_id: B, type: 'credit', amount: 500, direction: 'payable', workflow: 'kirana', idempotency_key: 'p1',
    }]);
  })
  .then(() => ledger.postTransactions(SHOP, [{
    customer_id: B, type: 'pay', amount: 800, direction: 'payable', workflow: 'kirana', idempotency_key: 'p2',
  }]))
  .then(rows => {
    ok('payable pay rows are NOT dedup', rows[0].dedup === false);
    return ledger.balance(B, 'payable');
  })
  .then(bal => {
    ok('payable balance 500 - 800 = -300 (allowed)', bal.rupees === -300 && bal.advance === true);
    // cross-shop: customer X is owned by another shop -> ownership reads as 404
    return ledger.postTransactions(SHOP, [{ customer_id: X, type: 'credit', amount: 100, idempotency_key: 'x1' }])
      .then(() => ok('cross-shop post throws NOT_OWNED (FAIL)', false))
      .catch(e => ok('cross-shop customer rejected as NOT_OWNED', e.code === 'NOT_OWNED'));
  })
  .then(() => ledger.statement(A))
  .then(st => {
    ok('statement lists 2 rows, newest-first, balance 300',
      st.transactions.length === 2 && st.transactions[0].created_at >= st.transactions[1].created_at &&
      st.balance.before === 300);
    // ===== reversal template =====
    return ledger.postTransactions(SHOP, [{ customer_id: C, type: 'credit', amount: 500, idempotency_key: 'r1' }]);
  })
  .then(() => ledger.reverseTransaction(SHOP, sb._db.transactions[sb._db.transactions.length - 1].id, 'తప్పు మొత్తం'))
  .then(res => {
    const rev = res.reversal;
    ok('reversal row posted (event, type, amount offset)', rev.event === 'reversal' && rev.type === 'pay' && rev.amount === 500);
    const orig = sb._db.transactions.find(t => t.id === res.original.id);
    ok('original marked reversed', orig.status === 'reversed');
    ok('reversal carries reverses_id', rev.reverses_id === res.original.id);
    return ledger.balance(C, 'receivable');
  })
  .then(bal => {
    ok('reversal offsets EXACTLY: balance back to 0', bal.paise === 0);
    // retry the SAME reverse: idempotent — one reversal row total, not two
    const orig = sb._db.transactions.find(t => t.customer_id === C && t.event === 'goods_credit');
    return ledger.reverseTransaction(SHOP, orig.id, 'తప్పు మొత్తం')
      .then(res2 => {
        const revs = sb._db.transactions.filter(t => t.customer_id === C && t.event === 'reversal');
        ok('reverse retry is idempotent (one reversal row)', revs.length === 1 && revs[0].id === res2.reversal.id);
        // the reversal row itself can never be reversed
        return ledger.reverseTransaction(SHOP, res2.reversal.id, 'again')
          .then(() => ok('reversing a reversal throws (FAIL)', false))
          .catch(e => ok('reversal row NOT_REVERSIBLE', e.code === 'NOT_REVERSIBLE'));
      });
  })
  .then(() => {
    // reversing a non-existent / other-shop id reads as 404 (no existence leak)
    return ledger.reverseTransaction(SHOP, '00000000-0000-0000-0000-000000000000', 'why')
      .then(() => ok('unknown reverse throws (FAIL)', false))
      .catch(e => ok('unknown reverse NOT_FOUND', e.code === 'NOT_FOUND'));
  })
  .then(() => {
    const evil = { id: 'ee000000-0004-4111-9111-111111111111', shop_id: OTHER, customer_id: C, type: 'credit', amount: '77.00' };
    sb._db.transactions.push(evil);
    return ledger.reverseTransaction(SHOP, evil.id, 'steal')
      .then(() => ok('cross-shop reverse throws (FAIL)', false))
      .catch(e => ok('cross-shop reverse NOT_FOUND', e.code === 'NOT_FOUND'));
  })
  .then(() => {
    // reversal rows must NEVER pass through public posting
    return ledger.postTransactions(SHOP, [{ customer_id: A, type: 'pay', amount: 5, event: 'reversal', idempotency_key: 'no' }])
      .then(() => ok('public reversal post throws (FAIL)', false))
      .catch(e => ok('reversal event without reverses_id = BAD_REQUEST', e.code === 'BAD_REQUEST'));
  })
  .then(() => {
    // audit trail: written, machine-details only (no amounts/names/phones)
    ok('audit events written for posts + reversals', sb._db.audits.length >= 3);
    const blobs = JSON.stringify(sb._db.audits);
    ok('audit details carry no amounts or names',
      blobs.indexOf('500') === -1 && blobs.indexOf('cust-') === -1);
    console.log('\nALL ' + checks + ' CHECKS PASSED');
  })
  .catch(e => { console.error('FAIL: ' + (e.stack || e)); process.exit(1); });
