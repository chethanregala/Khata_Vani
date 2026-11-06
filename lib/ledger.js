// ledger.js — server-side ledger operations for Khata Vani sprint 1.
//
// All amounts are integer PAISE (see lib/money.js). Every query is scoped by
// shop_id; ids arriving from the client are re-checked against the session shop.
// The Supabase client is injected with setClient(sb) so tests can run fully
// hermetic (no spin-up needed — the fake client is passed in directly).
'use strict';

const money = require('./money');

let SB = null;
function setClient(sb) { SB = sb || null; }
function client() {
  if (!SB) {
    const e = new Error('ledger not configured');
    e.code = 'NO_LEDGER';
    throw e;
  }
  return SB;
}

// ledger errors carry machine codes only — never amounts / names / phones
const MESSAGES = {
  NOT_FOUND: 'నమోదు దొరకలేదు · entry not found',
  ALREADY_REVERSED: 'ఈ నమోదు ఇప్పటికే రద్దు అయింది · already reversed',
  NOT_REVERSIBLE: 'రద్దు నమోదును రద్దు చేయలేము · a reversal cannot be reversed',
  OVERPAYMENT: 'జమ మిగిలిన బాకీ కంటే ఎక్కువ. మొత్తం సరిచూసి చెప్పండి · repayment exceeds the outstanding balance',
  BAD_REQUEST: 'సరైన నమోదు కాదు · invalid ledger entry',
  NOT_OWNED: 'నమోదు దొరకలేదు · entry not found', // ownership failure reads as 404, never a leak
  CONFLICT: 'నమోదు పూర్తి అవ్వలేదు, మళ్లీ ప్రయత్నించండి · entry not saved, try again',
  LEDGER_RPC: 'నమోదు పూర్తి అవ్వలేదు, మళ్లీ ప్రయత్నించండి · entry not saved, try again',
  DB_ERROR: 'నమోదు పూర్తి అవ్వలేదు, మళ్లీ ప్రయత్నించండి · entry not saved, try again',
};
class LedgerError extends Error {
  constructor(code, message) {
    super(message || MESSAGES[code] || MESSAGES.DB_ERROR);
    this.name = 'LedgerError';
    this.code = code;
  }
}

const EVENTS = new Set(['goods_credit', 'repayment', 'produce_delivery', 'advance',
  'deduction', 'payment', 'milk_collection', 'reversal', 'adjustment']);
const WORKFLOWS = new Set(['kirana', 'rythu', 'dairy']);
const DIRECTIONS = new Set(['receivable', 'payable']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// balance(customerId, direction) — ALWAYS Σ(credit) − Σ(pay) over ALL rows of
// that customer, including reversal rows (an offsetting pair cancels to zero).
//   receivable: positive => they owe us.   pay rows below zero are blocked.
//   payable:    positive => we owe them. A NEGATIVE balance is allowed and
//               means "advance to recover" (money already settled ahead).
// direction never changes the arithmetic — only the meaning of the sign.
// ---------------------------------------------------------------------------
async function balance(customerId, direction) {
  if (!customerId || !UUID_RE.test(String(customerId))) throw new LedgerError('BAD_REQUEST');
  let res;
  try {
    res = await client().from('transactions').select('type, amount, direction')
      .eq('customer_id', customerId);
  } catch (e) { throw Object.assign(new LedgerError('DB_ERROR'), { cause: e }); }
  if (res && res.error) throw new LedgerError('DB_ERROR');
  let paise = 0;
  for (const row of (res.data || [])) {
    if (row.type === 'credit') paise += money.toPaise(String(row.amount));
    else if (row.type === 'pay') paise -= money.toPaise(String(row.amount));
  }
  return {
    paise,
    rupees: money.paiseToRupees(paise),
    direction: direction || 'receivable',
    advance: paise < 0, // payable flow shows this as "advance to recover"
  };
}

// normalize a DB row (amount may arrive as numeric string) to JSON-safe shape
function rowOut(row) {
  return { ...row, amount: money.paiseToRupees(money.toPaise(String(row.amount))) };
}

// ---------------------------------------------------------------------------
// postTransactions(shopId, rows) — validated, ownership-checked, atomic via the
// post_transactions RPC, audited in audit_events (audit details carry NO
// amounts/names/phones — counts and event kinds only).
// ---------------------------------------------------------------------------
async function postTransactions(shopId, rows) {
  if (!UUID_RE.test(String(shopId))) throw new LedgerError('BAD_REQUEST');
  if (!Array.isArray(rows)) rows = [rows];
  if (!rows.length || rows.length > 10) throw new LedgerError('BAD_REQUEST');

  // ---- validate every row BEFORE touching the database ----
  const clean = rows.map(raw => {
    const b = raw || {};
    const row = {};
    if (!b.customer_id || !UUID_RE.test(String(b.customer_id))) throw new LedgerError('BAD_REQUEST');
    row.customer_id = b.customer_id;
    if (b.type !== 'credit' && b.type !== 'pay') throw new LedgerError('BAD_REQUEST');
    row.type = b.type;
    const amountPaise = money.toPaise(b.amount); // validate on paise
    if (amountPaise <= 0) throw new LedgerError('BAD_REQUEST');
    // transactions.amount is numeric(12,2) RUPEES — convert paise -> rupees here;
    // rowOut() converts the stored value back to rupees for JSON responses
    row.amount = money.paiseToRupees(amountPaise);
    row._amountPaise = amountPaise; // internal, never sent to the database
    row.workflow = b.workflow == null || b.workflow === '' ? 'kirana' : b.workflow;
    if (!WORKFLOWS.has(row.workflow)) throw new LedgerError('BAD_REQUEST');
    row.direction = b.direction == null || b.direction === '' ? 'receivable' : b.direction;
    if (!DIRECTIONS.has(row.direction)) throw new LedgerError('BAD_REQUEST');
    row.event = b.event == null || b.event === '' ? '' : b.event;
    if (row.event && !EVENTS.has(row.event)) throw new LedgerError('BAD_REQUEST');
    if (b.reverses_id != null && !UUID_RE.test(String(b.reverses_id))) throw new LedgerError('BAD_REQUEST');
    if (b.settlement_id != null && !UUID_RE.test(String(b.settlement_id))) throw new LedgerError('BAD_REQUEST');
    row.reverses_id = b.reverses_id || null;
    row.settlement_id = b.settlement_id || null;
    // reversal rows are written ONLY by reverseTransaction() — a reversal row
    // arriving here must always carry the reverses_id it offsets
    if (row.event === 'reversal' && !row.reverses_id) throw new LedgerError('BAD_REQUEST');
    if (row.reverses_id && row.event !== 'reversal') throw new LedgerError('BAD_REQUEST');
    if (b.idempotency_key != null) {
      if (typeof b.idempotency_key !== 'string' || b.idempotency_key.length > 100) throw new LedgerError('BAD_REQUEST');
      row.idempotency_key = b.idempotency_key;
    }
    row.reason = typeof b.reason === 'string' ? b.reason.slice(0, 200) : null;
    row.note = typeof b.note === 'string' ? b.note.slice(0, 200) : null;
    row.deduction_category = typeof b.deduction_category === 'string' ? b.deduction_category.slice(0, 60) : null;
    row.produce = typeof b.produce === 'string' ? b.produce.slice(0, 100) : null;
    row.raw_transcript = typeof b.raw_transcript === 'string' ? b.raw_transcript.slice(0, 2000) : null;
    row.source = b.source === 'voice' ? 'voice' : b.source === 'screen' ? 'screen' : 'voice';
    // produce rows (rythu/dairy) may carry quantity/rate; kirana rows must not
    if (b.quantity != null || b.rate != null) {
      try {
        row.quantity = money.toMilli(b.quantity) / 1000;   // milli-units -> numeric
        row.rate = money.paiseToRupees(money.rateToPaise(b.rate));
        if (b.unit != null && typeof String(b.unit).trim() !== 'undefined') {
          const unit = String(b.unit).trim().toLowerCase().slice(0, 20);
          if (unit) {
            // reject unsupported units early — the table is weight-only
            if (!money.normalizeUnit(unit) || !(unit in money.UNIT_KG ||
              ['kilo', 'kilos', 'kgs', 'quintals', 'tonnes', 'bags', 'saari'].indexOf(unit) !== -1)) {
              throw new money.MoneyError('UNIT_UNSUPPORTED');
            }
            row.unit = unit;
          }
        }
        row.rate_unit = typeof b.rate_unit === 'string' ? b.rate_unit.slice(0, 20) : null;
      } catch (e) {
        if (e && e.name === 'MoneyError') throw new LedgerError('BAD_REQUEST');
        throw e;
      }
    }
    return row;
  });

  // ---- ownership: every customer id must belong to THIS shop ----
  const custIds = [...new Set(clean.map(r => r.customer_id))];
  let owned;
  try {
    owned = await client().from('customers').select('id').eq('shop_id', shopId).in('id', custIds);
  } catch (e) { throw Object.assign(new LedgerError('DB_ERROR'), { cause: e }); }
  if (owned && owned.error) throw new LedgerError('DB_ERROR');
  const ownedIds = new Set((owned.data || []).map(x => x.id));
  if (custIds.some(id => !ownedIds.has(id))) throw new LedgerError('NOT_OWNED');

  // ---- idempotent fast path: a key this shop already posted returns the row ----
  const keys = [...new Set(clean.map(r => r.idempotency_key).filter(Boolean))];
  const existingByKey = {};
  if (keys.length) {
    let dup;
    try {
      dup = await client().from('transactions').select('*').eq('shop_id', shopId).in('idempotency_key', keys);
    } catch (e) { throw Object.assign(new LedgerError('DB_ERROR'), { cause: e }); }
    if (dup && dup.error) throw new LedgerError('DB_ERROR');
    for (const row of (dup.data || [])) existingByKey[row.idempotency_key] = row;
  }

  const out = [];
  for (const row of clean) {
    if (row.idempotency_key && existingByKey[row.idempotency_key]) {
      out.push({ ...rowOut(existingByKey[row.idempotency_key]), dedup: true });
      continue;
    }
    // ---- kirana guard: a repayment above the outstanding is rejected ----
    // (payable direction allows going negative = "advance to recover";
    // reversal offset rows NEVER trip this guard — they must always post)
    if (row.event !== 'reversal' &&
        row.type === 'pay' && row.workflow === 'kirana' && row.direction === 'receivable') {
      const bal = await balance(row.customer_id, 'receivable');
      if (row._amountPaise > bal.paise) throw new LedgerError('OVERPAYMENT');
    }
    delete row._amountPaise; // internal only — never sent to the RPC
    // ---- atomic insert via the SQL function ----
    let resp;
    try {
      resp = await client().rpc('post_transactions', { p_shop_id: shopId, p_rows: [row] });
    } catch (e) { throw Object.assign(new LedgerError('LEDGER_RPC'), { cause: e }); }
    if (resp && resp.error) {
      const msg = String(resp.error.message || '');
      if (msg.indexOf('CUSTOMER_NOT_OWNED') !== -1 || msg.indexOf('REFS_NOT_OWNED') !== -1) {
        throw new LedgerError('NOT_OWNED');
      }
      if (msg.indexOf('ROW_INCOMPLETE') !== -1) throw new LedgerError('BAD_REQUEST');
      if (resp.error.code === '23505') throw new LedgerError('CONFLICT');
      throw new LedgerError('LEDGER_RPC');
    }
    const posted = (resp.data || [])[0];
    if (!posted) {
      // lost a race (concurrent same key) — the row exists, serve it
      if (row.idempotency_key) {
        const dup = await client().from('transactions').select('*')
          .eq('shop_id', shopId).eq('idempotency_key', row.idempotency_key).limit(1);
        const again = dup && dup.data && dup.data[0];
        if (again) { out.push({ ...rowOut(again), dedup: true }); continue; }
      }
      throw new LedgerError('LEDGER_RPC');
    }
    out.push({ ...rowOut(posted), dedup: false });
    // ---- audit: one row per posted transaction; no amounts/names/phones ----
    try {
      await client().from('audit_events').insert({
        shop_id: shopId,
        action: 'post',
        transaction_id: posted.id,
        details: { event: posted.event || null, source: posted.source || 'voice' },
      });
    } catch (e) { /* audit failure must not corrupt the ledger write result */ }
  }
  return out;
}

// ---------------------------------------------------------------------------
// reverseTransaction(shopId, txnId, reason) — writes ONE offsetting row
// (event 'reversal', reverses_id -> original) and marks the original
// 'reversed'. Deterministic idempotency key makes the operation replay-safe:
// a retry returns the same reversal row instead of a second one.
// Double reversal is rejected up front (ALREADY_REVERSED).
// ---------------------------------------------------------------------------
async function reverseTransaction(shopId, txnId, reason) {
  if (!UUID_RE.test(String(shopId)) || !UUID_RE.test(String(txnId))) throw new LedgerError('BAD_REQUEST');
  const why = String(reason == null ? '' : reason).trim();
  if (!why || why.length > 200) throw new LedgerError('BAD_REQUEST');

  let resp;
  try {
    resp = await client().from('transactions').select(
      'id, shop_id, customer_id, type, amount, workflow, direction, event, status, reverses_id'
    ).eq('id', txnId).eq('shop_id', shopId).limit(1);
  } catch (e) { throw Object.assign(new LedgerError('DB_ERROR'), { cause: e }); }
  if (resp && resp.error) throw new LedgerError('DB_ERROR');
  const orig = (resp.data || [])[0];
  if (!orig) throw new LedgerError('NOT_FOUND');           // cross-shop reads as 404
  if (orig.reverses_id) throw new LedgerError('NOT_REVERSIBLE'); // never reverse a reversal

  // IDEMPOTENT REPLAY: the deterministic key 'rev:<orig id>' lets a retried
  // reverse (network died after the row was written) return the SAME reversal
  // row instead of refusing or writing a second one. A double-tap that arrives
  // AFTER a legit reversal is still rejected as ALREADY_REVERSED below.
  let dup;
  try {
    dup = await client().from('transactions').select('*')
      .eq('shop_id', shopId).eq('idempotency_key', 'rev:' + txnId).limit(1);
  } catch (e) { throw Object.assign(new LedgerError('DB_ERROR'), { cause: e }); }
  if (dup && dup.error) throw new LedgerError('DB_ERROR');
  const existingReversal = (dup && dup.data && dup.data[0]) || null;
  if (existingReversal) {
    if (orig.status !== 'reversed') {
      const fix = await client().from('transactions').update({ status: 'reversed' })
        .eq('id', orig.id).eq('shop_id', shopId);
      if (fix && fix.error) throw new LedgerError('DB_ERROR');
    }
    return { original: { id: orig.id, status: 'reversed' }, reversal: rowOut(existingReversal) };
  }
  if (orig.status === 'reversed') throw new LedgerError('ALREADY_REVERSED');

  // audit trail: reversal stores the reason — it is shopkeeper-authored, not PII
  try {
    await client().from('audit_events').insert({
      shop_id: shopId,
      action: 'reverse-request',
      transaction_id: orig.id,
      details: {}, // reason lives in the transaction row itself, never in logs
    });
  } catch (e) { /* audit is best-effort */ }

  const offset = {
    customer_id: orig.customer_id,
    type: orig.type === 'credit' ? 'pay' : 'credit', // offsets EXACTLY
    amount: money.paiseToRupees(money.toPaise(String(orig.amount))),
    workflow: orig.workflow || 'kirana',
    direction: orig.direction || 'receivable',
    event: 'reversal',
    reverses_id: orig.id,
    reason: why,
    idempotency_key: 'rev:' + orig.id, // deterministic -> replay-safe
    source: 'screen',
    raw_transcript: null,
  };

  // postTransactions handles ownership + idempotency for the offset row
  const saved = await postTransactions(shopId, [offset]);
  const reversal = saved.find(r => r.idempotency_key === 'rev:' + orig.id);
  if (!reversal) throw new LedgerError('LEDGER_RPC');

  try {
    const upd = await client().from('transactions').update({ status: 'reversed' })
      .eq('id', orig.id).eq('shop_id', shopId);
    if (upd && upd.error) throw new LedgerError('DB_ERROR');
  } catch (e) {
    if (e.code) throw e;
    throw Object.assign(new LedgerError('DB_ERROR'), { cause: e });
  }

  try {
    await client().from('audit_events').insert({
      shop_id: shopId, action: 'reverse', transaction_id: reversal.id, details: {},
    });
  } catch (e) { /* best effort */ }

  return { original: { id: orig.id, status: 'reversed' }, reversal };
}

// ---------------------------------------------------------------------------
// statement(customerId) — the full timeline for the customer detail screen:
// posted rows, reversed rows (status flag), and the sum per direction.
// ---------------------------------------------------------------------------
async function statement(customerId) {
  const bal = await balance(customerId, 'receivable');
  let res;
  try {
    res = await client().from('transactions').select(
      'id, customer_id, type, amount, raw_transcript, created_at, event, workflow, direction, status, reverses_id'
    ).eq('customer_id', customerId);
  } catch (e) { throw Object.assign(new LedgerError('DB_ERROR'), { cause: e }); }
  if (res && res.error) throw new LedgerError('DB_ERROR');
  const rows = (res.data || []).slice()
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .map(rowOut);
  return { transactions: rows, balance: { before: bal.rupees, advance: bal.advance } };
}

module.exports = {
  setClient, balance, postTransactions, reverseTransaction, statement,
  LedgerError, MESSAGES,
};
