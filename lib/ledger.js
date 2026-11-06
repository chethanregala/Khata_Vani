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
  // rythu
  HAS_LINKED_ROWS: 'ముందు అనుబంధ నమోదులను రద్దు చేయండి · reverse the linked entries first',
  SETTLEMENT_REQUIRED: 'ఒకటి కంటే ఎక్కువ సెటిల్‌మెంట్లు ఓపెన్‌లో ఉన్నాయి — సెటిల్‌మెంట్ ఎంచుకోండి · several settlements open — pick one',
  KIND_MISMATCH: 'ఇది రైతు ఖాతా కాదు · not a farmer account',
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

// awaited select helper: throws DB_ERROR on transport or supabase errors,
// returns the data array otherwise
async function Q(p) {
  let r;
  try { r = await p; }
  catch (e) { throw Object.assign(new LedgerError('DB_ERROR'), { cause: e }); }
  if (r && r.error) throw new LedgerError('DB_ERROR');
  return r.data || [];
}

// delivery amount in paise: quantity priced per `rateUnit`. Same-unit pricing
// goes straight through lib/money; a cross-unit quote (200 kg @ ₹X per quintal)
// first converts the quantity through the kg scale, half-up to milli-units.
function deliveryAmountPaise(quantity, unit, rate, rateUnit, bagKg) {
  if (unit === rateUnit) return money.amountFromQtyRate(quantity, rate, unit, bagKg);
  if (!money.UNIT_KG[rateUnit]) throw new LedgerError('BAD_REQUEST');
  const kg = money.toKg(money.toMilli(quantity), unit, bagKg);
  const inRate = Math.round((kg / money.UNIT_KG[rateUnit]) * 1000) / 1000;
  if (!(inRate > 0)) throw new LedgerError('BAD_REQUEST');
  return money.amountFromQtyRate(inRate, rate, rateUnit, bagKg);
}

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
    if (b.workflow === 'rythu' && b.event === 'produce_delivery') {
      // the delivery amount is COMPUTED by the server from qty × rate — the
      // client amount (if any) is never trusted for this event
      row.amount = null;
      row._amountPaise = 0;
    } else {
      let amountPaise;
      try {
        amountPaise = money.toPaise(b.amount); // validate on paise
      } catch (e) {
        if (e && e.name === 'MoneyError') throw new LedgerError('BAD_REQUEST');
        throw e;
      }
      if (!(amountPaise > 0)) throw new LedgerError('BAD_REQUEST');
      // transactions.amount is numeric(12,2) RUPEES — convert paise -> rupees here;
      // rowOut() converts the stored value back to rupees for JSON responses
      row.amount = money.paiseToRupees(amountPaise);
      row._amountPaise = amountPaise; // internal, never sent to the database
    }
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
    // rythu transients: bag weight is used only to COMPUTE the delivery amount
    // (transactions has no bag-weight column — nothing to store); allow_advance
    // is the user's "record the excess as advance" confirmation
    row.bag_kg = null;
    row.allow_advance = b.allow_advance === true || b.allow_advance === 'true';
    if (b.bag_kg != null && b.bag_kg !== '') {
      try {
        const bagMilli = money.toMilli(b.bag_kg);
        row.bag_kg = bagMilli / 1000;
      } catch (e) {
        if (e && e.name === 'MoneyError') throw new LedgerError('BAD_REQUEST');
        throw e;
      }
    }
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
            // reject unsupported units early — the table is weight-only; the
            // canonical name is what gets stored ('ton' -> 'tonne' etc.)
            const canon = money.normalizeUnit(unit);
            if (!canon || !(canon in money.UNIT_KG)) throw new money.MoneyError('UNIT_UNSUPPORTED');
            row.unit = canon;
          }
        }
        row.rate_unit = typeof b.rate_unit === 'string' ? money.normalizeUnit(String(b.rate_unit).slice(0, 20)) : null;
      } catch (e) {
        if (e && e.name === 'MoneyError') throw new LedgerError('BAD_REQUEST');
        throw e;
      }
    }
    return row;
  });

  // ---- rythu row-shape validation (event set / types / required fields / amount) ----
  const RYTHU_EVENTS = new Set(['produce_delivery', 'advance', 'deduction', 'payment']);
  const DEDUCTION_CATEGORIES = new Set(['hamali', 'commission', 'transport', 'tharugu', 'other']);
  for (const row of clean) {
    if (row.workflow !== 'rythu') continue;
    if (row.event === 'reversal') continue; // offsets any rythu row — reverseTransaction only
    if (!row.event || !RYTHU_EVENTS.has(row.event)) throw new LedgerError('BAD_REQUEST');
    if (row.event === 'produce_delivery') {
      // the settlement anchor: a priced purchase. The SERVER computes the
      // amount — the client is never trusted with the money math.
      if (row.type !== 'credit') throw new LedgerError('BAD_REQUEST');
      if (!row.produce) throw new LedgerError('BAD_REQUEST');
      if (row.quantity == null || !row.unit || row.rate == null) throw new LedgerError('BAD_REQUEST');
      row.rate_unit = row.rate_unit || row.unit;
      const uUnit = money.normalizeUnit(row.unit);
      const uRate = money.normalizeUnit(row.rate_unit);
      if ((uUnit === 'bag' || uRate === 'bag') && !(row.bag_kg > 0)) {
        throw new LedgerError('BAD_REQUEST'); // a bag needs an explicit weight
      }
      if (uUnit !== uRate && (!money.UNIT_KG[uUnit] || !money.UNIT_KG[uRate])) {
        throw new LedgerError('BAD_REQUEST');
      }
      const paise = deliveryAmountPaise(row.quantity, uUnit, row.rate, uRate, row.bag_kg);
      row.amount = money.paiseToRupees(paise);
      row._amountPaise = paise;
    } else {
      if (row.type !== 'pay') throw new LedgerError('BAD_REQUEST');
      if (row.event === 'deduction') {
        if (!row.deduction_category || !DEDUCTION_CATEGORIES.has(row.deduction_category)) {
          throw new LedgerError('BAD_REQUEST');
        }
      }
    }
  }

  // ---- ownership: every customer id must belong to THIS shop ----
  const custIds = [...new Set(clean.map(r => r.customer_id))];
  let owned;
  try {
    owned = await client().from('customers').select('id, kind').eq('shop_id', shopId).in('id', custIds);
  } catch (e) { throw Object.assign(new LedgerError('DB_ERROR'), { cause: e }); }
  if (owned && owned.error) throw new LedgerError('DB_ERROR');
  const ownedIds = new Set((owned.data || []).map(x => x.id));
  if (custIds.some(id => !ownedIds.has(id))) throw new LedgerError('NOT_OWNED');
  const kindById = new Map((owned.data || []).map(x => [x.id, x.kind || 'customer']));
  // cross-kind isolation: rythu speech is stored ONLY on farmer accounts, and
  // farmer accounts only ever carry rythu rows — the two name-pools can never
  // collide (the same name in kirana vs rythu resolves to two customers)
  for (const row of clean) {
    const isFarmer = kindById.get(row.customer_id) === 'farmer';
    if ((row.workflow === 'rythu') !== isFarmer) throw new LedgerError('KIND_MISMATCH');
  }

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

    // ---- rythu linking: pick the settlement this cash row belongs to ----
    let batchRows = [row];
    if (row.workflow === 'rythu' && row.type === 'pay' && row.event !== 'reversal') {
      if (row.settlement_id) {
        // an EXPLICIT settlement id must be this farmer's NON-reversed anchor
        const ssett = await Q(client().from('transactions').select('*')
          .eq('shop_id', shopId).eq('id', row.settlement_id).limit(1));
        const s = ssett[0];
        if (!s) throw new LedgerError('NOT_FOUND');            // 404, no existence leak
        if (s.event !== 'produce_delivery') throw new LedgerError('BAD_REQUEST');
        if (s.customer_id !== row.customer_id) throw new LedgerError('CONFLICT');
        if (s.status === 'reversed') throw new LedgerError('CONFLICT'); // dead settlement
      } else {
        // AUTO-LINK when exactly one settlement is open; several open -> the
        // client must choose; none open -> unallocated (visible under the
        // farmer's "unallocated advances" list until applied)
        const open = await openRythuSettlements(row.customer_id);
        if (open.length === 1) row.settlement_id = open[0].settlement_id;
        else if (open.length > 1) throw new LedgerError('SETTLEMENT_REQUIRED');
      }
      // a payment above the settlement's remaining is refused — unless the user
      // confirmed "record the excess as advance", which SPLITS the row
      if (row.event === 'payment' && row.settlement_id) {
        const rem = await settlementRemaining(row.settlement_id);
        if (row._amountPaise > rem) {
          if (!row.allow_advance) throw new LedgerError('OVERPAYMENT');
          const linkedPaise = rem > 0 ? rem : 0;
          const excessPaise = row._amountPaise - linkedPaise;
          if (linkedPaise === 0) {
            // nothing left inside: the whole payment becomes a free advance
            row.event = 'advance';
            row.settlement_id = null;
          } else {
            row.amount = money.paiseToRupees(linkedPaise);
            row._amountPaise = linkedPaise;
            batchRows.push({ // the excess is an UNALLOCATED advance of its own
              ...row,
              event: 'advance',
              settlement_id: null,
              amount: money.paiseToRupees(excessPaise),
              _amountPaise: excessPaise,
              idempotency_key: row.idempotency_key ? row.idempotency_key + ':x' : null,
              deduction_category: null,
              reason: null,
              note: null,
            });
          }
        }
      }
    }

    for (const b of batchRows) {
      delete b._amountPaise; // internal only — never sent to the RPC
      delete b.allow_advance;
      delete b.bag_kg;
    }
    // ---- atomic insert via the SQL function ----
    let resp;
    try {
      resp = await client().rpc('post_transactions', { p_shop_id: shopId, p_rows: batchRows });
    } catch (e) { throw Object.assign(new LedgerError('LEDGER_RPC'), { cause: e }); }
    if (resp && resp.error) {
      const msg = String(resp.error.message || '');
      if (msg.indexOf('CUSTOMER_NOT_OWNED') !== -1 || msg.indexOf('REFS_NOT_OWNED') !== -1) {
        throw new LedgerError('NOT_OWNED');
      }
      if (msg.indexOf('ROW_INCOMPLETE') !== -1) {
        throw Object.assign(new LedgerError('BAD_REQUEST'), { cause: resp.error });
      }
      if (resp.error.code === '23505') throw new LedgerError('CONFLICT');
      // cause carries the PostgREST/pg error so the server can log its code
      // (never the message) on the 500 path
      throw Object.assign(new LedgerError('LEDGER_RPC'), { cause: resp.error });
    }
    const postedRows = resp.data || [];
    if (!postedRows.length) {
      // lost a race (concurrent same key) — the row exists, serve it
      if (row.idempotency_key) {
        const dup = await client().from('transactions').select('*')
          .eq('shop_id', shopId).eq('idempotency_key', row.idempotency_key).limit(1);
        const again = dup && dup.data && dup.data[0];
        if (again) {
          await anchorDelivery(shopId, again);
          out.push({ ...rowOut(again), dedup: true });
          continue;
        }
      }
      throw new LedgerError('LEDGER_RPC');
    }
    for (const posted of postedRows) {
      await anchorDelivery(shopId, posted);
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
  }
  return out;
}

// ---------------------------------------------------------------------------
// anchorDelivery — a produce_delivery row is ITS OWN settlement anchor:
// settlement_id is set to the row's own id right after the insert. A self-id is
// unknowable pre-insert inside the RPC, so this is the one legitimate mutating
// follow-up; it is idempotent (only fires when the column is still null).
// ---------------------------------------------------------------------------
async function anchorDelivery(shopId, posted) {
  if (!posted || posted.event !== 'produce_delivery' || posted.settlement_id) return;
  let upd;
  try {
    upd = await client().from('transactions').update({ settlement_id: posted.id })
      .eq('id', posted.id).eq('shop_id', shopId);
  } catch (e) { throw Object.assign(new LedgerError('DB_ERROR'), { cause: e }); }
  if (upd && upd.error) throw new LedgerError('DB_ERROR');
  posted.settlement_id = posted.id;
}

// ---------------------------------------------------------------------------
// openRythuSettlements(customerId) — non-reversed delivery anchors whose
// remaining (gross − linked cash) is not zero, oldest first.
// ---------------------------------------------------------------------------
async function openRythuSettlements(customerId) {
  if (!customerId || !UUID_RE.test(String(customerId))) throw new LedgerError('BAD_REQUEST');
  const anchors = await Q(client().from('transactions').select('*')
    .eq('customer_id', customerId).eq('event', 'produce_delivery'));
  const out = [];
  for (const s of anchors) {
    if (s.status === 'reversed') continue;
    const rem = await settlementRemaining(s.id);
    if (rem !== 0) out.push({ settlement_id: s.id, remaining: rem, created_at: s.created_at });
  }
  return out.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
}

// ---------------------------------------------------------------------------
// settlementRemaining(settlementId) — paise remaining inside one settlement:
// gross − Σ linked cash rows (id ≠ the anchor itself, never reversed, and the
// anchor row IS the only credit row that carries this settlement_id).
// ---------------------------------------------------------------------------
async function settlementRemaining(settlementId) {
  if (!settlementId || !UUID_RE.test(String(settlementId))) throw new LedgerError('BAD_REQUEST');
  let anchorPaise = 0;
  const anchor = await Q(client().from('transactions').select('type, amount, event')
    .eq('id', settlementId).limit(1));
  if (anchor.length && anchor[0].event === 'produce_delivery') {
    anchorPaise = money.toPaise(String(anchor[0].amount));
  } else {
    throw new LedgerError('NOT_FOUND');
  }
  const linked = await Q(client().from('transactions').select('id, type, amount, status')
    .eq('settlement_id', settlementId));
  let used = 0;
  for (const l of linked) {
    if (l.id === settlementId) continue;        // the anchor row itself
    if (l.status === 'reversed') continue;
    if (l.type === 'pay') used += money.toPaise(String(l.amount));
  }
  return anchorPaise - used;
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

  // HAS_LINKED_ROWS: a delivery is the settlement ANCHOR — as long as any
  // non-reversed advance/deduction/payment still points at it, the anchor
  // cannot be reversed (the shopkeeper must reverse the linked rows first).
  if (orig.event === 'produce_delivery') {
    const linked = await Q(client().from('transactions').select('id, status')
      .eq('settlement_id', orig.id).eq('shop_id', shopId));
    const blocking = linked.filter(r => r.id !== orig.id && r.status !== 'reversed');
    if (blocking.length) throw new LedgerError('HAS_LINKED_ROWS', MESSAGES.HAS_LINKED_ROWS);
  }

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

// ---------------------------------------------------------------------------
// allocateToSettlement(shopId, txnId, settlementId) — the ONLY permitted
// mutation of a committed transaction's linkage: settlement_id may move from
// null to a settlement id, never the other way, financial fields untouched.
// Used from the farmer screen's "unallocated advances → apply" action. Audited.
// ---------------------------------------------------------------------------
async function allocateToSettlement(shopId, txnId, settlementId) {
  if (!UUID_RE.test(String(shopId)) || !UUID_RE.test(String(txnId)) ||
      !UUID_RE.test(String(settlementId))) throw new LedgerError('BAD_REQUEST');
  const rows = await Q(client().from('transactions').select('*')
    .eq('id', txnId).eq('shop_id', shopId).limit(1));
  const txn = rows[0];
  if (!txn) throw new LedgerError('NOT_FOUND');           // cross-shop reads as 404
  if (txn.settlement_id) throw new LedgerError('CONFLICT');   // already allocated
  if (txn.status === 'reversed' || txn.reverses_id) throw new LedgerError('CONFLICT');
  if (txn.workflow !== 'rythu' ||
      ['advance', 'deduction', 'payment'].indexOf(txn.event) === -1) {
    throw new LedgerError('BAD_REQUEST');
  }
  const srows = await Q(client().from('transactions').select('*')
    .eq('id', settlementId).eq('shop_id', shopId).limit(1));
  const s = srows[0];
  if (!s) throw new LedgerError('NOT_FOUND');
  if (s.event !== 'produce_delivery') throw new LedgerError('BAD_REQUEST');
  if (s.status === 'reversed') throw new LedgerError('CONFLICT'); // dead settlement
  if (s.customer_id !== txn.customer_id) throw new LedgerError('CONFLICT'); // other farmer

  let upd;
  try {
    upd = await client().from('transactions').update({ settlement_id: s.id })
      .eq('id', txn.id).eq('shop_id', shopId);
  } catch (e) { throw Object.assign(new LedgerError('DB_ERROR'), { cause: e }); }
  if (upd && upd.error) throw new LedgerError('DB_ERROR');
  try {
    await client().from('audit_events').insert({
      shop_id: shopId, action: 'allocate', transaction_id: txn.id, details: {},
    });
  } catch (e) { /* best effort */ }
  return { ...rowOut(txn), settlement_id: s.id };
}

// ---------------------------------------------------------------------------
// computeSettlementsFromRows(rows) — PURE: builds the settlement cards and the
// unallocated list from raw transaction rows of ONE farmer. Settlement summary
// is COMPUTED ON READ, never stored. Rows shaped like DB rows (amounts as
// numeric strings, reversal rows carry settlement_id = null). Rhythm:
//   produce_delivery  -> the anchor (settlement_id = own id)
//   advance/deduction/payment -> linked cash, or unallocated when null
//   reversal rows -> invisible here; the original simply shows 'reversed'
// ---------------------------------------------------------------------------
function computeSettlementsFromRows(rows) {
  const toP = v => { try { return money.toPaise(String(v)); } catch { return 0; } };
  const num = v => (v == null ? null : Number(v));
  const chrono = rows.slice()
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));

  const settlements = new Map();
  for (const r of chrono) {
    if (r.event === 'produce_delivery') {
      const gross = toP(r.amount);
      settlements.set(r.id, {
        settlement_id: r.id,
        produce: r.produce || null,
        quantity: num(r.quantity),
        unit: r.unit || null,
        rate: num(r.rate),
        rate_unit: r.rate_unit || null,
        gross: money.paiseToRupees(gross),
        created_at: r.created_at,
        status: r.status || 'posted',
        advances: [], deductions: [], payments: [],
        advance_total: 0, deduction_total: 0, payment_total: 0, // rupees, filled in
        remaining: money.paiseToRupees(gross),                  // provisional
        open: gross !== 0,
      });
    }
  }
  const unallocated = [];
  for (const r of chrono) {
    if (r.event === 'reversal') continue;       // reflected by the original's status
    if (r.type !== 'pay' || r.status === 'reversed') continue;
    if (['advance', 'deduction', 'payment'].indexOf(r.event) === -1) continue;
    const paise = toP(r.amount);
    const mini = {
      id: r.id,
      amount: money.paiseToRupees(paise),
      deduction_category: r.deduction_category || null,
      created_at: r.created_at,
      source: r.source || null,
    };
    if (r.settlement_id && settlements.has(r.settlement_id)) {
      const s = settlements.get(r.settlement_id);
      s[`${r.event}s`].push(mini);
      s[`${r.event}_total`] = money.paiseToRupees(toP(s[`${r.event}_total`]) + paise);
    } else if (!r.settlement_id) {
      unallocated.push({ ...mini, event: r.event });
    }
    // rows pointing at a REVERSED (no longer listed) settlement simply don't render
  }
  const out = [];
  for (const s of settlements.values()) {
    const grossP = toP(s.gross);
    const used = s.advance_total + s.deduction_total + s.payment_total;
    const remP = grossP - toP(used);
    s.remaining = money.paiseToRupees(remP);
    s.open = s.status !== 'reversed' && remP !== 0;
    out.push(s);
  }
  out.reverse(); // newest settlement first (matches the customer's habit)
  return { settlements: out, unallocated };
}

// ---------------------------------------------------------------------------
// farmerSettlements(shopId, customerId) — the rythu farmer detail screen:
// the customer row, their rythu settlements + unallocated list, and the
// payable balance (positive = we owe the farmer, negative = advance to recover)
// ---------------------------------------------------------------------------
async function farmerSettlements(shopId, customerId) {
  if (!UUID_RE.test(String(shopId)) || !UUID_RE.test(String(customerId))) {
    throw new LedgerError('BAD_REQUEST');
  }
  const crows = await Q(client().from('customers').select('id, name, village, kind')
    .eq('shop_id', shopId).eq('id', customerId).limit(1));
  const farmer = crows[0];
  if (!farmer) throw new LedgerError('NOT_FOUND');
  if ((farmer.kind || 'customer') !== 'farmer') throw new LedgerError('KIND_MISMATCH');
  const rows = await Q(client().from('transactions').select('*').eq('customer_id', customerId));
  let bal = 0;
  for (const r of rows) {
    let p; try { p = money.toPaise(String(r.amount)); } catch { p = 0; }
    bal += r.type === 'credit' ? p : -p;
  }
  return {
    customer: { id: farmer.id, name: farmer.name, village: farmer.village || null },
    balance: money.paiseToRupees(bal),
    advance: bal < 0,
    ...computeSettlementsFromRows(rows),
  };
}

// ---------------------------------------------------------------------------
// rythuFarmers(shopId) — the rythu customer-list screen: every kind='farmer'
// customer with the payable balance, the advance-to-recover amount and the
// number of open settlements (computed on read — nothing cached).
// ---------------------------------------------------------------------------
async function rythuFarmers(shopId) {
  if (!UUID_RE.test(String(shopId))) throw new LedgerError('BAD_REQUEST');
  const farmers = await Q(client().from('customers').select('id, name, village')
    .eq('shop_id', shopId).eq('kind', 'farmer'));
  if (!farmers.length) return [];
  const rows = await Q(client().from('transactions').select(
    'id, customer_id, type, amount, event, status, settlement_id, created_at, workflow'
  ).in('customer_id', farmers.map(f => f.id)));
  const byFarmer = new Map(farmers.map(f => [f.id, []]));
  for (const r of rows) if (byFarmer.has(r.customer_id)) byFarmer.get(r.customer_id).push(r);
  return farmers.map(f => {
    const rs = byFarmer.get(f.id) || [];
    let paise = 0;
    for (const r of rs) {
      let p; try { p = money.toPaise(String(r.amount)); } catch { p = 0; }
      paise += r.type === 'credit' ? p : -p;
    }
    const open = computeSettlementsFromRows(rs).settlements
      .filter(s => s.status !== 'reversed' && s.open).length;
    return {
      id: f.id, name: f.name, village: f.village || null,
      payable: paise > 0 ? money.paiseToRupees(paise) : 0,
      advance: paise < 0 ? money.paiseToRupees(-paise) : 0,
      open_settlements: open,
    };
  });
}

// IST "today" — India buys produce between dawn and midnight IST, so the
// summary window is an IST calendar day, not a UTC one.
const IST_DATE_FMT = 'en-CA'; // yields YYYY-MM-DD
function istDay(d) {
  try {
    return new Intl.DateTimeFormat(IST_DATE_FMT, { timeZone: 'Asia/Kolkata' }).format(d);
  } catch { return new Date(d).toISOString().slice(0, 10); }
}
function istToday() { return istDay(new Date()); }

// ---------------------------------------------------------------------------
// rythuSummary(shopId, day) — the rythu Home strip, one IST day:
// purchase value, advances given, payments settled (each net of that-day
// reversals of the same event kind), plus the all-time payable/advance totals.
// ---------------------------------------------------------------------------
async function rythuSummary(shopId, day) {
  if (!UUID_RE.test(String(shopId))) throw new LedgerError('BAD_REQUEST');
  const dayStr = day ? String(day) : istToday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayStr)) throw new LedgerError('BAD_REQUEST');
  const farmers = await Q(client().from('customers').select('id')
    .eq('shop_id', shopId).eq('kind', 'farmer'));
  const stats = {
    day: dayStr, purchases: 0, advances: 0, payments: 0,
    payable_total: 0, advance_to_recover: 0,
  };
  if (!farmers.length) return stats;
  const rows = await Q(client().from('transactions').select(
    'id, customer_id, type, amount, event, status, reverses_id, created_at'
  ).in('customer_id', farmers.map(f => f.id)));
  const eventOf = new Map(rows.map(r => [r.id, r.event]));
  const revById = new Map(); // reverses_id -> the reversal row itself
  for (const r of rows) {
    if ((r.event === 'reversal') && r.reverses_id) revById.set(r.reverses_id, r);
  }
  const toP = v => { try { return money.toPaise(String(v)); } catch { return 0; } };
  const balBy = new Map(farmers.map(f => [f.id, 0]));
  for (const r of rows) {
    let p; try { p = toP(r.amount); } catch { continue; }
    if (balBy.has(r.customer_id)) {
      balBy.set(r.customer_id, balBy.get(r.customer_id) + (r.type === 'credit' ? p : -p));
    }
    if (istDay(new Date(r.created_at)) !== dayStr) continue;
    // A reversed row counts UNLESS its reversal was posted outside this day's
    // window (then the day reads as if it never happened). Counting the
    // original even when reversed is what lets a same-day reversal cancel it
    // exactly below — zeroing here AND subtracting would double-cancel.
    const undoneToday = r.status === 'reversed' && revById.has(r.id) &&
      istDay(new Date(revById.get(r.id).created_at)) === dayStr;
    const paise = (r.status === 'reversed' && !undoneToday) ? 0 : p;
    // a reversal posted today cancels its original's event kind for the day
    if (r.event === 'reversal') {
      const orig = eventOf.get(r.reverses_id);
      if (orig === 'produce_delivery') stats.purchases = Math.max(0, stats.purchases - p);
      else if (orig === 'advance') stats.advances = Math.max(0, stats.advances - p);
      else if (orig === 'payment') stats.payments = Math.max(0, stats.payments - p);
    } else if (r.event === 'produce_delivery') {
      stats.purchases += paise;
    } else if (r.event === 'advance') {
      stats.advances += paise;
    } else if (r.event === 'payment') {
      stats.payments += paise;
    }
  }
  for (const p of balBy.values()) {
    if (p > 0) stats.payable_total += p;
    else if (p < 0) stats.advance_to_recover += -p;
  }
  return {
    day: stats.day,
    purchases: money.paiseToRupees(stats.purchases),
    advances: money.paiseToRupees(stats.advances),
    payments: money.paiseToRupees(stats.payments),
    payable_total: money.paiseToRupees(stats.payable_total),
    advance_to_recover: money.paiseToRupees(stats.advance_to_recover),
  };
}

module.exports = {
  setClient, balance, postTransactions, reverseTransaction, statement,
  allocateToSettlement, computeSettlementsFromRows, farmerSettlements,
  rythuFarmers, rythuSummary, openRythuSettlements, settlementRemaining,
  LedgerError, MESSAGES,
};
