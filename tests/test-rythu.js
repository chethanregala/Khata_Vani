// test-rythu.js — hermetic sprint-2 (rythu) tests: parseRythu + ledger farmer
// settlements + linking + money math. No network, no Supabase; the same fake
// client pattern as test-ledger.js, extended with kind/village + the rythu
// row fields and an `is` filter.
// Run: node test-rythu.js   (also part of `npm test`)
'use strict';

const parseRythu = require('../public/rythu-parser');
const ledger = require('../lib/ledger');

let checks = 0;
const ok = (label, cond) => { checks++; if (!cond) { console.error('FAIL ' + label); process.exitCode = 1; } else console.log('PASS ' + label); };
const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const errCode = (fn, code) => {
  try { fn(); ok('throws ' + code + ' (none thrown — FAIL)', false); }
  catch (e) { ok('throws ' + code + (e.code === code ? '' : ' [got ' + e.code + ']'), e.code === code); }
};

// ============================================================================
// parseRythu — deliveries, cash events, bags, halves, missing codes (>=20)
// ============================================================================
function ry(s) { return parseRythu(s); }
let r;

r = ry('సురేష్ 5 క్వింటాళ్లు వరి రేటు 2200');
ok('parse delivery core', r.event === 'delivery' && r.farmer === 'సురేష్' && r.produce === 'paddy');
ok('parse delivery qty/unit/rate', r.quantity === 5 && r.unit === 'quintal' && r.rate === 2200);
ok('parse delivery preview amount 5x2200=11000', r.amount === 11000 && deepEq(r.missing, []));

r = ry('సురేష్ 5 క్వింటాళ్లు వరి క్వింటాకు 2200');
ok('parse per-unit rate phrasing', r.event === 'delivery' && r.quantity === 5 && r.rate === 2200 && r.amount === 11000);

r = ry('రమేష్ పత్తి అమ్మారు 2 క్వింటాళ్లు 2300');
ok('parse bare trailing rate digit', r.event === 'delivery' && r.quantity === 2 && r.rate === 2300 && r.amount === 4600);

r = ry('సురేష్ ఒకటిన్నర క్వింటా పత్తి');
ok('parse one-and-a-half word quantity', r.quantity === 1.5 && r.unit === 'quintal' && r.produce === 'cotton');
ok('parse missing RATE without a rate', deepEq(r.missing, ['RATE']));

r = ry('సురేష్ కి 4000 అడ్వాన్స్');
ok('parse advance', r.event === 'advance' && r.amount === 4000 && deepEq(r.missing, []));

r = ry('సురేష్ కి రెండు వేలు అడ్వాన్స్');
ok('parse advance in number words', r.event === 'advance' && r.amount === 2000);

r = ry('సురేష్ 200 హమాలీ తగ్గింపు');
ok('parse deduction with category', r.event === 'deduction' && r.amount === 200 && r.category === 'hamali');

r = ry('సురేష్ 200 హమాలీ'); // typed hamali word only
ok('parse hamali as deduction', r.event === 'deduction' && r.category === 'hamali');

r = ry('సురేష్ కి 5000 చెల్లింపు');
ok('parse payment', r.event === 'payment' && r.amount === 5000);

r = ry('సురేష్ కి 3000 ఇచ్చాను');
ok('parse payment via ichaanu verb', r.event === 'payment' && r.amount === 3000);

r = ry('Suresh gave 3000 advance');
ok('parse advance in English', r.event === 'advance' && r.amount === 3000);

r = ry('సురేష్ 10 బస్తాలు 50 కిలో వరి రేటు 1500');
ok('parse bags with stated bag weight', r.event === 'delivery' && r.quantity === 10 && r.unit === 'bag' && r.bagKg === 50);
ok('parse bag delivery amount 10x1500', r.amount === 15000 && r.rateUnit === 'bag');

r = ry('సురేష్ 50 కిలోలు బస్తా వరి');
ok('kg token becomes bag weight when bag named', r.unit === 'bag' && r.bagKg === 50 && r.quantity == null);
ok('bag delivery still missing quantity+rate', deepEq(r.missing, ['QUANTITY', 'RATE']));

r = ry('సురేష్ 2 టన్నులు మొక్కజొన్న టన్నుకు 2500');
ok('parse tonnes', r.event === 'delivery' && r.quantity === 2 && r.unit === 'ton' && r.rate === 2500 && r.amount === 5000);

r = ry('సురేష్ 200 కిలోలు వరి కిలోకి 21.5');
ok('parse kg with decimal rate', r.quantity === 200 && r.unit === 'kg' && r.rate === 21.5 && r.amount === 4300);

r = ry('Suresh 5 quintal paddy rate 2200');
ok('parse English delivery', r.event === 'delivery' && r.quantity === 5 && r.amount === 11000);

r = ry('వరి 5 క్వింటాళ్లు రేటు 2200');
ok('parse missing FARMER', r.farmer == null && r.event === 'delivery' && deepEq(r.missing, ['FARMER']));

r = ry('సురేష్ అర క్వింటా వరి రేటు 2200');
ok('parse half (అర) quantity', r.quantity === 0.5 && r.amount === 1100);

r = ry('సురేష్ ఢాఈ క్వింటాళ్లు వరి రేటు 2200');
ok('parse Telugu-script Hindi half (ఢాఈ)', r.quantity === 2.5 && r.amount === 5500);

r = ry('సురేష్ 2.5 క్వింటాళ్లు వరి క్వింటాకు 2200');
ok('parse decimal quantity', r.quantity === 2.5 && r.amount === 5500);

r = ry('సురేష్ వరి తెచ్చారు');
ok('parse deliver verb without numbers', r.event === 'delivery' && r.produce === 'paddy' && r.quantity == null);

r = ry('సురేష్');
ok('parse bare name -> EVENT missing', r.event == null && r.farmer === 'సురేష్' && deepEq(r.missing, ['EVENT']));

r = ry('సురేష్ కి ఎంత ఇవ్వాలి');
ok('parse query phrase keeps event null with a farmer', r.event == null && (r.farmer || '').indexOf('సురేష్') === 0 && r.amount == null);

r = ry('సురేష్ 500 రూపాయలు అడ్వాన్స్');
ok('parse advaance with rupees word', r.event === 'advance' && r.amount === 500);

// ============================================================================
// fake supabase client — test-ledger.js pattern + kind/village + rythu fields
// ============================================================================
function fakeSb() {
  const db = { customers: [], transactions: [], audits: [] };
  let idn = 0;
  const uuid = () => '00000000-0000-4000-8000-' + String(++idn).padStart(12, '0');
  const now = () => new Date().toISOString();

  const matches = (row, filters) => filters.every(f =>
    f.t === 'eq' ? row[f.col] === f.val
      : f.t === 'is' ? row[f.col] == null
      : (f.vals || []).includes(row[f.col]));

  const exec = q => {
    const rows = db[q.tbl] || [];
    if (q.op === 'insert') return r([{ ...q.payload }]);
    if (q.op === 'update') {
      let n = 0;
      for (const row of rows) if (matches(row, q.filters)) { n++; Object.assign(row, q.payload); }
      return r(n ? [null] : []);
    }
    let out = rows.filter(row => matches(row, q.filters));
    if (q.limitN != null) out = out.slice(0, q.limitN);
    return r(out.map(row => ({ ...row })));
  };
  const r = data => ({ data, error: null });

  const chain = (tbl, q) => {
    const b = {
      select: c => { q.sel = c || '*'; return b; },
      insert: p => { q.op = 'insert'; q.payload = Array.isArray(p) ? p[0] : p; return b; },
      update: p => { q.op = 'update'; q.payload = p; return b; },
      eq: (col, val) => { q.filters.push({ t: 'eq', col, val }); return b; },
      is: (col, val) => { q.filters.push({ t: 'is', col, val }); return b; },
      in: (col, vals) => { q.filters.push({ t: 'in', col, vals }); return b; },
      limit: n => { q.limitN = n; return b; },
      then: (res, rej) => Promise.resolve(exec(q)).then(res, rej),
      catch: rej => Promise.resolve(exec(q)).catch(rej),
      finally: f => Promise.resolve(exec(q)).finally(f),
    };
    return b;
  };

  const rpc = (name, args) => {
    if (name !== 'post_transactions') throw new Error('unknown rpc ' + name);
    const { p_shop_id: shop, p_rows: rows } = args;
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
        // numeric(12,2) columns COME BACK AS STRINGS — mimic supabase-js
        amount: Number(x.amount).toFixed(2),
        event: x.event || (x.type === 'credit' ? 'goods_credit' : 'repayment'),
        direction: x.direction || 'receivable',
        workflow: x.workflow || 'kirana',
        status: 'posted',
        quantity: x.quantity == null ? null : x.quantity,
        unit: x.unit || null, rate: x.rate == null ? null : x.rate,
        rate_unit: x.rate_unit || null, produce: x.produce || null,
        deduction_category: x.deduction_category || null,
        note: x.note || null, reason: x.reason || null,
        settlement_id: x.settlement_id == null ? null : x.settlement_id,
        reverses_id: x.reverses_id || null,
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
    _db: db, _setCustomer: c => db.customers.push(c), _setTx: t => db.transactions.push(t),
  };
}

const SHOP = '33333333-3333-4333-8333-333333333333';
const OTHER = '22222222-3333-4444-8222-222222222222';
const F1 = 'fafafafa-0001-4faf-8faf-fafafafafafa'; // farmer in SHOP
const K1 = 'a2b2c3d4-0002-4a2b-8a2b-aabbccddeeff'; // kirana customer (kind undefined)
const FX = 'fafafafa-0009-4faf-8faf-999999999999'; // farmer in the OTHER shop

const ryRow = (over) => Object.assign({
  customer_id: F1, type: 'credit', workflow: 'rythu', direction: 'payable',
  event: 'produce_delivery', produce: 'paddy', quantity: '5', unit: 'quintal',
  rate: '2200', rate_unit: 'quintal', idempotency_key: 'd1',
}, over);

const fresh = () => {
  const sb = fakeSb();
  sb._setCustomer({ id: F1, shop_id: SHOP, name: 'farm-' + F1.slice(0, 4), kind: 'farmer', village: 'రామాపురం' });
  sb._setCustomer({ id: K1, shop_id: SHOP, name: 'cust-' + K1.slice(0, 4) }); // no kind -> kirana
  sb._setCustomer({ id: FX, shop_id: OTHER, name: 'other-farmer', kind: 'farmer' });
  ledger.setClient(sb);
  return sb;
};

// ============================================================================
// ledger: delivery math + self-anchored settlement
// ============================================================================
let sb = fresh();
let deliveryId = null;

(async () => {
  // -- 5 quintal @ 2200 = 11000, self-anchored --
  let rows = await ledger.postTransactions(SHOP, [ryRow({ amount: 1 })]); // client amount ignored
  const d = rows[0];
  deliveryId = d.id;
  ok('delivery stored amount = 11000 (client amount ignored)', d.amount === 11000);
  ok('delivery event/direction', d.event === 'produce_delivery' && d.type === 'credit');
  ok('delivery is its own settlement anchor', d.settlement_id === d.id);
  ok('delivery stored quantity/rate (numbers)', d.quantity === 5 && d.rate === 2200);

  // idempotent replay
  rows = await ledger.postTransactions(SHOP, [ryRow({})]);
  ok('delivery replay dedup', rows[0].dedup === true && rows[0].id === d.id);
  ok('replay created no second row', sb._db.transactions.length === 1);

  // remaining = 1100000 paise
  let rem = await ledger.settlementRemaining(d.id);
  ok('remaining 11000 paise 1100000', rem === 1100000);

  // -- advance auto-links to the sole open settlement --
  const adv = await ledger.postTransactions(SHOP, [{
    customer_id: F1, type: 'pay', direction: 'payable', workflow: 'rythu', event: 'advance', amount: 4000, idempotency_key: 'a1',
  }]);
  ok('advance auto-linked to sole open settlement', adv[0].settlement_id === d.id);
  ok('advance direction payable', adv[0].direction === 'payable');

  // deduction links too
  const ded = await ledger.postTransactions(SHOP, [{
    customer_id: F1, type: 'pay', direction: 'payable', workflow: 'rythu', event: 'deduction', amount: 200,
    deduction_category: 'hamali', idempotency_key: 'h1',
  }]);
  ok('deduction auto-linked + category kept', ded[0].settlement_id === d.id && ded[0].deduction_category === 'hamali');

  rem = await ledger.settlementRemaining(d.id);
  ok('remaining 11000-4000-200 = 6800', rem === 680000);

  // -- payment 5000 ok, remaining 1800; 9999 refused unless allow_advance --
  const pay = await ledger.postTransactions(SHOP, [{
    customer_id: F1, type: 'pay', direction: 'payable', workflow: 'rythu', event: 'payment', amount: 5000, idempotency_key: 'p1',
  }]);
  ok('payment auto-linked', pay[0].settlement_id === d.id);

  let threw = null;
  try {
    await ledger.postTransactions(SHOP, [{
      customer_id: F1, type: 'pay', direction: 'payable', workflow: 'rythu', event: 'payment', amount: 9999, idempotency_key: 'p2',
    }]);
  } catch (e) { threw = e; }
  ok('payment over remaining rejected OVERPAYMENT', threw && threw.code === 'OVERPAYMENT');
  ok('rejected overpay wrote nothing', sb._db.transactions.length === 4);

  const split = await ledger.postTransactions(SHOP, [{
    customer_id: F1, type: 'pay', direction: 'payable', workflow: 'rythu', event: 'payment', amount: 9999,
    allow_advance: true, idempotency_key: 'p3',
  }]);
  ok('allow_advance splits into 2 rows', split.length === 2 && split[0].dedup === false && split[1].dedup === false);
  ok('linked part got the remaining 1800', split[0].amount === 1800 && split[0].settlement_id === d.id);
  ok('excess became an UNALLOCATED advance row',
    split[1].event === 'advance' && split[1].amount === 8199 && split[1].settlement_id === null);
  ok('excess row uses key + ":x"', sb._db.transactions.some(t => t.idempotency_key === 'p3:x'));
  ok('settlement fully settled now', (await ledger.settlementRemaining(d.id)) === 0);

  // -- payment when NO settlement is open posts unallocated (event stays
  // 'payment' — the split-to-advance conversion needs a linked settlement) --
  const whole = await ledger.postTransactions(SHOP, [{
    customer_id: F1, type: 'pay', direction: 'payable', workflow: 'rythu', event: 'payment', amount: 500, idempotency_key: 'w1',
  }]);
  ok('payment with no open settlement -> unallocated payment row',
    whole[0].event === 'payment' && whole[0].settlement_id === null && whole[0].amount === 500);

  // -- allocate the unallocated excess advance to a NEW settlement --
  const d2rows = await ledger.postTransactions(SHOP, [ryRow({
    produce: 'cotton', quantity: '2', rate: '2300', idempotency_key: 'd2',
  })]);
  const d2 = d2rows[0];
  ok('second delivery 2x2300=4600', d2.amount === 4600);
  const xrow = sb._db.transactions.find(t => t.idempotency_key === 'p3:x');
  const alc = await ledger.allocateToSettlement(SHOP, xrow.id, d2.id);
  ok('allocate moves unallocated -> settlement', alc.settlement_id === d2.id);
  threw = null;
  try { await ledger.allocateToSettlement(SHOP, xrow.id, d2.id); }
  catch (e) { threw = e; }
  ok('double allocate CONFLICT', threw && threw.code === 'CONFLICT');
  // d2 remaining is now NEGATIVE (4600 - 8199) yet still "open"
  ok('over-allocation leaves the settlement number negative', (await ledger.settlementRemaining(d2.id)) === -359900);
  threw = null;
  try {
    await ledger.postTransactions(SHOP, [{
      customer_id: F1, type: 'pay', direction: 'payable', workflow: 'rythu', event: 'payment', amount: 100, idempotency_key: 'n1',
    }]);
  } catch (e) { threw = e; }
  ok('payment against negative-remaining settlement refused', threw && threw.code === 'OVERPAYMENT');

  // -- two open settlements -> SETTLEMENT_REQUIRED; explicit choice works --
  const d3rows = await ledger.postTransactions(SHOP, [ryRow({
    produce: 'chilli', quantity: '1', rate: '5000', idempotency_key: 'd3',
  })]);
  const d3 = d3rows[0];
  threw = null;
  try {
    await ledger.postTransactions(SHOP, [{
      customer_id: F1, type: 'pay', direction: 'payable', workflow: 'rythu', event: 'payment', amount: 500, idempotency_key: 'p4',
    }]);
  } catch (e) { threw = e; }
  ok('two open -> SETTLEMENT_REQUIRED', threw && threw.code === 'SETTLEMENT_REQUIRED');
  const explicit = await ledger.postTransactions(SHOP, [{
    customer_id: F1, type: 'pay', direction: 'payable', workflow: 'rythu', event: 'payment', amount: 500,
    settlement_id: d3.id, idempotency_key: 'p4b',
  }]);
  ok('explicit settlement id links the payment', explicit[0].settlement_id === d3.id);
  threw = null;
  try {
    await ledger.postTransactions(SHOP, [{
      customer_id: F1, type: 'pay', direction: 'payable', workflow: 'rythu', event: 'payment', amount: 100,
      settlement_id: F1, idempotency_key: 'p4c', // a customer id, not a settlement — NOT_FOUND
    }]);
  } catch (e) { threw = e; }
  ok('unknown settlement id -> NOT_FOUND (no leak)', threw && threw.code === 'NOT_FOUND');

  // -- cross-kind isolation (both directions) --
  threw = null;
  try {
    await ledger.postTransactions(SHOP, [{
      customer_id: K1, type: 'pay', direction: 'payable', workflow: 'rythu', event: 'advance', amount: 10, idempotency_key: 'ryk',
    }]);
  } catch (e) { threw = e; }
  ok('rythu row on a kirana customer -> KIND_MISMATCH', threw && threw.code === 'KIND_MISMATCH');
  threw = null;
  try {
    await ledger.postTransactions(SHOP, [{
      customer_id: F1, type: 'credit', amount: 10, idempotency_key: 'kir',
    }]);
  } catch (e) { threw = e; }
  ok('kirana row on a farmer -> KIND_MISMATCH', threw && threw.code === 'KIND_MISMATCH');

  // -- cross-shop: the other shop's farmer reads as NOT_OWNED --
  threw = null;
  try {
    await ledger.postTransactions(SHOP, [ryRow({ customer_id: FX, idempotency_key: 'xx' })]);
  } catch (e) { threw = e; }
  ok('other-shop farmer -> NOT_OWNED', threw && threw.code === 'NOT_OWNED');

  // -- row-shape validation --
  await ledger.postTransactions(SHOP, [ryRow({ event: 'sale', idempotency_key: 'ev1' })])
    .then(() => ok('unknown rythu event rejected (FAIL)', false))
    .catch(e => ok('unknown rythu event rejected BAD_REQUEST', e.code === 'BAD_REQUEST'));
  await ledger.postTransactions(SHOP, [ryRow({ unit: 'litre', idempotency_key: 'u1' })])
    .then(() => ok('unsupported unit rejected (FAIL)', false))
    .catch(e => ok('unsupported delivery unit rejected', e.code === 'BAD_REQUEST'));
  await ledger.postTransactions(SHOP, [ryRow({
    quantity: '10', unit: 'bag', rate: '1500', rate_unit: 'bag', idempotency_key: 'b1',
  })])
    .then(() => ok('bag without weight rejected (FAIL)', false))
    .catch(e => ok('bag delivery without weight rejected', e.code === 'BAD_REQUEST'));
  await ledger.postTransactions(SHOP, [{
    customer_id: F1, type: 'pay', direction: 'payable', workflow: 'rythu', event: 'deduction', amount: 100, idempotency_key: 'c1',
  }])
    .then(() => ok('deduction without category rejected (FAIL)', false))
    .catch(e => ok('deduction without category rejected', e.code === 'BAD_REQUEST'));
  // cross-unit rate: 200 kg @ 2200 per quintal = 2 x 2200 = 4400
  const xu = await ledger.postTransactions(SHOP, [ryRow({
    produce: 'paddy', quantity: '200', unit: 'kg', rate: '2200', rate_unit: 'quintal', idempotency_key: 'xu1',
  })]);
  ok('cross-unit delivery 200kg @2200/quintal = 4400', xu[0].amount === 4400);
  // bag delivery with weight computes through the bag gross too
  const bd = await ledger.postTransactions(SHOP, [ryRow({
    produce: 'maize', quantity: '10', unit: 'bag', rate: '1500', rate_unit: 'bag',
    bag_kg: '50', idempotency_key: 'bd1',
  })]);
  ok('bag delivery 10 bags @1500 = 15000', bd[0].amount === 15000);

  // -- HAS_LINKED_ROWS on the anchor; cash rows reverse freely --
  // d1 still carries the blocked... its linked rows: advance a1, hamali h1, payment 5000, split part
  threw = null;
  try { await ledger.reverseTransaction(SHOP, d.id, 'wrong qty'); }
  catch (e) { threw = e; }
  ok('delivery with linked rows -> HAS_LINKED_ROWS', threw && threw.code === 'HAS_LINKED_ROWS');
  ok('HAS_LINKED_ROWS message is Telugu', threw && threw.message.indexOf('ముందు అనుబంధ నమోదులను రద్దు చేయండి') !== -1);

  // reverse the split's linked part, then the delivery still blocked (3 linked rows left)
  const linkedRow = sb._db.transactions.find(t => t.idempotency_key === 'p3' && t.settlement_id === d.id);
  await ledger.reverseTransaction(SHOP, linkedRow.id, 'double entry');
  threw = null;
  try { await ledger.reverseTransaction(SHOP, d.id, 'wrong qty'); }
  catch (e) { threw = e; }
  ok('delivery still blocked while even one link lives', threw && threw.code === 'HAS_LINKED_ROWS');

  // reverse everything on d1, then the anchor reverses fine
  for (const t of sb._db.transactions.filter(t => t.settlement_id === d.id && t.id !== d.id && t.status === 'posted')) {
    await ledger.reverseTransaction(SHOP, t.id, 'rollback drill');
  }
  const revd = await ledger.reverseTransaction(SHOP, d.id, 'wrong qty');
  ok('delivery reversible once links are gone', revd.original.status === 'reversed' && revd.reversal.event === 'reversal');
  ok('reversal detaches the anchor', sb._db.transactions.find(t => t.id === d.id).status === 'reversed');

  // -- read models (pure + through the fake client) --
  const model = ledger.computeSettlementsFromRows(sb._db.transactions.filter(t => t.customer_id === F1));
  ok('computeSettlementsFromRows lists reversed d1 as closed', model.settlements.length >= 3 &&
    model.settlements.some(s => s.settlement_id === d.id && s.status === 'reversed' && s.open === false));
  const closed = model.settlements.find(s => s.settlement_id === d.id);
  // after the rollback drill EVERY linked row of d1 is reversed, so the card
  // shows the bare delivery again: all cash totals 0, remaining = gross
  ok('reversed d1 card math restored', closed.gross === 11000 &&
    closed.advance_total === 0 && closed.deduction_total === 0 && closed.payment_total === 0 &&
    closed.remaining === 11000);
  open2: {
    const d2ro = model.settlements.find(s => s.settlement_id === d2.id);
    ok('d2 card negative-remaining open', d2ro.open === true && d2ro.remaining === -3599);
    ok('d2 one linked advance row (the allocated x row)', d2ro.advances.length === 1 && d2ro.advances[0].amount === 8199);
  }
  const wholeModel = model.unallocated.filter(u => u.amount === 500);
  ok('unallocated list carries the no-settlement payment', wholeModel.length === 1 && wholeModel[0].event === 'payment');

  const det = await ledger.farmerSettlements(SHOP, F1);
  ok('farmerSettlements customer + balance', det.customer.id === F1 && typeof det.balance === 'number');
  ok('farmerSettlements has settlements + unallocated', Array.isArray(det.settlements) && Array.isArray(det.unallocated));

  const list = await ledger.rythuFarmers(SHOP);
  ok('rythuFarmers lists the farmer only', list.length === 1 && list[0].id === F1 && list[0].village === 'రామాపురం');
  ok('rythuFarmers open-settlement count >= 2 (d2 negative-open + d3)',
    list[0].open_settlements >= 2);

  const sum = await ledger.rythuSummary(SHOP);
  // net of the same-day reversals: d1's 11000 is cancelled by its own reversal,
  // so purchases = d2 4600 + d3 5000 + xu 4400 + bd 15000 = 29000
  ok('summary purchases net the day reversals (29000)', sum.purchases === 29000);
  ok('summary advances (a1 netted out, excess 8199 stays)', sum.advances === 8199);
  ok('summary payments (whole + p4b, drill rows netted to 0)', sum.payments === 1000);
  ok('summary day is an IST YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test(sum.day));
  threw = null;
  try { await ledger.rythuSummary(SHOP, 'not-a-date'); }
  catch (e) { threw = e; }
  ok('bad summary date -> BAD_REQUEST', threw && threw.code === 'BAD_REQUEST');

  threw = null;
  try { await ledger.farmerSettlements(SHOP, K1); }
  catch (e) { threw = e; }
  ok('farmerSettlements on a kirana customer -> KIND_MISMATCH', threw && threw.code === 'KIND_MISMATCH');

  console.log('\n' + (process.exitCode ? 'FAILURES — ' : '') + 'rythu: ' + checks + ' CHECKS' +
    (process.exitCode ? '' : ' PASSED'));
})().catch(e => {
  console.error('UNCAUGHT TEST FAILURE', e);
  process.exit(1);
});
