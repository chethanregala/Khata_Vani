// ack.js — customer acknowledgement links (Sprint 3).
//
// The shop mints a shareable link for ONE credit entry; the customer answers
// once through it (acknowledge / dispute). ONLY the SHA-256 hash of the token
// is stored; the raw token lives solely inside the URL that is returned to the
// shopkeeper exactly once and is never persisted or logged anywhere.
//
// Same shape as lib/ledger.js: a Supabase client is injected with
// setClient(sb) so tests run fully hermetic against a fake client.
//
// transactions.ack_status is a guarded column (see
// supabase/migrations/003_acknowledgements.sql: the DB trigger whitelists the
// transitions). It is written ONLY in this file — ack-link (awaiting), the
// public response (acknowledged / disputed), ack-resolve (resolved) and the
// reversal hook in lib/ledger.js (cancelled).
'use strict';

const crypto = require('crypto');
const money = require('./money');

let SB = null;
function setClient(sb) { SB = sb || null; }
function client() {
  if (!SB) {
    const e = new Error('ack not configured');
    e.code = 'NO_LEDGER';
    throw e;
  }
  return SB;
}

// ledger-style errors: machine codes + Telugu messages for the caller
const MESSAGES = {
  NOT_FOUND: 'లింక్ అందుబాటులో లేదు · link not available',
  ACK_BAD_STATE: 'ఈ ధృవీకరణ ఇప్పుడు సాధ్యం కాదు · acknowledgement not possible now',
  ACK_NOT_ALLOWED: 'ఉద్దెర/సరుకు నమోదులకు మాత్రమే లింక్ సాధ్యం · only credit/delivery entries can be acknowledged',
  NOT_DISPUTED: 'వివాదం లేదు · nothing to resolve',
};
class AckError extends Error {
  constructor(code, message) {
    super(message || MESSAGES[code] || MESSAGES.NOT_FOUND);
    this.name = 'AckError';
    this.code = code;
  }
}

// 32 random bytes, base64url (= 43 URL-safe chars, no padding)
const TOKEN_BYTES = 32;
// base64url of exactly 32 bytes: 43 chars, alphabet [A-Za-z0-9_-]
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
function newToken() { return crypto.randomBytes(TOKEN_BYTES).toString('base64url'); }
// constant-volume one-way mapping; the DB holds ONLY this
function hashToken(token) { return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex'); }

const LINK_TTL_MS = 14 * 24 * 60 * 60 * 1000;      // expires_at = now + 14 days
const DISPUTE_NOTE_MAX = 200;
// only these events may carry an acknowledgement link — payments/advances/
// deductions/reversals are refused (the customer owes nothing to acknowledge)
const ACKABLE = new Map([
  ['goods_credit', 'credit'],
  ['produce_delivery', 'credit'],
]);

// the generic 404-shaped body for every not-good public lookup (unknown /
// expired / revoked) — never reveals WHICH of the three happened
const GENERIC_404 = MESSAGES.NOT_FOUND;

// selected transaction columns needed by the link + public view. Note what is
// NOT here: customer balance, customer phone, shop address — the public view
// shows only the shop name, entry date, gesture, amount and item details.
const TX_COLS = 'id, shop_id, customer_id, type, amount, workflow, direction, event, status, ' +
  'produce, quantity, unit, rate, rate_unit, note, created_at, ack_status';

// ---------------------------------------------------------------------------
// createLink(shopId, txnId) — mint a fresh link for one entry.
//   * shop-scoped lookup: another shop's entry reads as NOT_FOUND
//   * only non-reversed rows with type 'credit' AND event goods_credit /
//     produce_delivery are allowed
//   * revokes any previous ACTIVE link of that transaction (awaiting)
//   * stores the token HASH + 14-day expiry, sets tx ack_status='awaiting'
//   * returns { token, url, hash } — the raw token NEVER touches the database
//     (the caller builds the URL with APP_ORIGIN and may cache TTS by hash)
// ---------------------------------------------------------------------------
async function createLink(shopId, txnId) {
  if (!isValidId(shopId) || !isValidId(txnId)) throw new AckError('ACK_BAD_STATE');
  let rows;
  try {
    const r = await client().from('transactions').select(TX_COLS)
      .eq('id', String(txnId)).eq('shop_id', String(shopId)).limit(1);
    if (r && r.error) throw new AckError('ACK_BAD_STATE', 'tx lookup failed');
    rows = r.data || [];
  } catch (e) { throw wrapDb(e); }
  const tx = rows[0];
  // cross-shop (or unknown) ids read as a plain 404 — no existence leak
  if (!tx) throw new AckError('NOT_FOUND');
  if (tx.status === 'reversed') throw new AckError('ACK_BAD_STATE');
  const need = ACKABLE.get(tx.event);
  if (!need || tx.type !== need) throw new AckError('ACK_NOT_ALLOWED');

  // one ACTIVE link per transaction: earlier awaiting links become 'revoked'
  await revokeActive(shopId, txnId);

  const token = newToken();
  const hash = hashToken(token);
  let ins;
  try {
    ins = await client().from('acknowledgements').insert({
      shop_id: String(shopId),
      transaction_id: String(txnId),
      token_hash: hash,
      status: 'awaiting',
      expires_at: new Date(Date.now() + LINK_TTL_MS).toISOString(),
    }).select('id, token_hash, status, expires_at').single();
  } catch (e) { throw wrapDb(e); }
  if (ins && ins.error) throw wrapDb(ins.error);
  let upd;
  try {
    upd = await client().from('transactions').update({ ack_status: 'awaiting' })
      .eq('id', String(txnId)).eq('shop_id', String(shopId));
  } catch (e) { throw wrapDb(e); }
  if (upd && upd.error) throw wrapDb(upd.error);
  try {
    await client().from('audit_events').insert({
      shop_id: String(shopId), action: 'ack-link', transaction_id: String(txnId), details: {},
    });
  } catch (e) { /* audit is best-effort, exactly like the ledger's own writes */ }
  return { token, hash, row: ins.data || null, tx };
}

async function revokeActive(shopId, txnId) {
  try {
    await client().from('acknowledgements').update({ status: 'revoked' })
      .eq('shop_id', String(shopId)).eq('transaction_id', String(txnId))
      .eq('status', 'awaiting');
  } catch (e) { throw wrapDb(e); }
}

// reversal hook (called from lib/ledger.js reverseTransaction): any ACTIVE
// link becomes 'revoked' and the entry's ack_status moves to 'cancelled' so
// summaries stop counting it. Best-effort: hermetic fakes without the
// acknowledgements table must never break a reversal.
async function cancelOnReversal(shopId, txnId) {
  try { await revokeActive(shopId, txnId); } catch (_) { return; }
  try {
    await client().from('transactions').update({ ack_status: 'cancelled' })
      .eq('id', String(txnId)).eq('shop_id', String(shopId))
      .neq('ack_status', 'not_required');
  } catch (_) { /* best-effort */ }
  try {
    await client().from('audit_events').insert({
      shop_id: String(shopId), action: 'ack-cancel', transaction_id: String(txnId), details: {},
    });
  } catch (_) { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// viewByToken(token) — the PUBLIC page/JSON view. One response rule lives in
// respond(); this read is what the page renders.
// Returns { status, view } where status ∈ awaiting|acknowledged|disputed|
// resolved|cancelled|expired, or null when the token is unknown (generic 404).
// ---------------------------------------------------------------------------
async function viewByToken(token) {
  if (!TOKEN_RE.test(String(token || ''))) return null;
  const ack = await byHash(hashToken(String(token)));
  if (!ack) return null;
  if (ack.status === 'revoked') {
    return { status: 'cancelled', ack, tx: null }; // tx lookup unnecessary — never leaked
  }
  // an already-given answer stays visible, even after the link's expiry
  if (ack.status === 'acknowledged' || ack.status === 'disputed' || ack.status === 'resolved') {
    const tx = await txById(ack);
    if (!tx) return null; // entry vanished → generic
    return { status: ack.status, ack, tx };
  }
  if (ack.expires_at && new Date(ack.expires_at).getTime() <= Date.now()) {
    return { status: 'expired', ack, tx: null };
  }
  const tx = await txById(ack);
  if (!tx) return null; // entry vanished → generic
  if (tx.status === 'reversed') {
    return { status: 'cancelled', ack, tx: null }; // reversed entries read as cancelled too
  }
  return { status: ack.status, ack, tx }; // 'awaiting'
}

// PUBLIC view data — strictly minimal fields (shop name, entry date, what
// happened, amount, item details). Never: balance, phone, address, other
// customers' entries.
function publicView(status, ack, tx, shopName) {
  const isDelivery = tx && tx.event === 'produce_delivery';
  const date = tx ? String(tx.created_at || '').slice(0, 10) : null;
  return {
    status,
    shop_name: shopName || '',
    entry_date: date,
    entry_kind: isDelivery ? 'produce_delivery' : 'goods_credit',
    amount: tx ? money.paiseToRupees(money.toPaise(String(tx.amount))) : null,
    item: isDelivery ? {
      produce: (tx.produce || null),
      quantity: tx.quantity != null ? Number(tx.quantity) : null,
      unit: tx.unit || null,
      rate: tx.rate != null ? Number(tx.rate) : null,
      rate_unit: tx.rate_unit || null,
    } : (tx && typeof tx.note === 'string' && tx.note.trim() ? { note: tx.note.trim().slice(0, 200) } : null),
    responded_at: ack && ack.responded_at ? ack.responded_at : null,
    dispute_note: ack && status !== 'awaiting' && typeof ack.dispute_note === 'string'
      ? ack.dispute_note : null, // shown back on the already-responded page
  };
}

// ---------------------------------------------------------------------------
// respond(token, action, note) — the ONE public response.
//   * constant-distance lookup: hash then a single indexed select
//   * single-response rule: an already-responded link RETURNS THE SAME STATUS
//     and changes nothing; cancelled/expired/unknown read as the generic 404
//   * writes acknowledgements.status + responded_at, transactions.ack_status,
//   * audit 'ack-response' (no IP, no token, dispute note never in the audit)
// ---------------------------------------------------------------------------
async function respond(token, action, note) {
  if (!TOKEN_RE.test(String(token || '')) || (action !== 'acknowledge' && action !== 'dispute')) {
    return { code: 'NOT_FOUND' };
  }
  const hash = hashToken(String(token));
  const ack = await byHash(hash);
  if (!ack) return { code: 'NOT_FOUND' };
  if (ack.expires_at && new Date(ack.expires_at).getTime() <= Date.now()) {
    return { code: 'NOT_FOUND' };
  }
  if (ack.status === 'revoked') return { code: 'NOT_FOUND' }; // cancelled link

  // single-response rule: the FIRST response wins, repeats are idempotent
  if (ack.status === 'acknowledged' || ack.status === 'disputed' || ack.status === 'resolved') {
    return { code: 'OK', status: ack.status, repeat: true };
  }

  const tx = await txRowById(ack); // shop still needed to scope the tx update
  if (!tx || tx.status === 'reversed') return { code: 'NOT_FOUND' };

  const newStatus = action === 'acknowledge' ? 'acknowledged' : 'disputed';
  const cleanNote = action === 'dispute' && typeof note === 'string'
    ? note.trim().slice(0, DISPUTE_NOTE_MAX)
    : null;
  try {
    const upd = await client().from('acknowledgements').update({
      status: newStatus,
      responded_at: new Date().toISOString(),
      dispute_note: newStatus === 'disputed' ? (cleanNote || null) : null,
    }).eq('id', ack.id).eq('token_hash', hash);
    if (upd && upd.error) throw wrapDb(upd.error);
  } catch (e) { throw wrapDb(e); }
  try {
    await client().from('transactions').update({ ack_status: newStatus })
      .eq('id', ack.transaction_id).eq('shop_id', ack.shop_id);
  } catch (e) { throw wrapDb(e); }
  try {
    await client().from('audit_events').insert({
      shop_id: ack.shop_id,
      action: 'ack-response',
      transaction_id: ack.transaction_id,
      details: newStatus === 'disputed' ? { result: 'disputed' } : { result: 'acknowledged' },
    });
  } catch (_) { /* best-effort; never logs note/IP/token */ }
  return { code: 'OK', status: newStatus, repeat: false, transaction_id: ack.transaction_id };
}

// ---------------------------------------------------------------------------
// resolveDispute(shopId, txnId, note) — the SHOP closes a disputed entry as
// resolved (transactions.ack_status 'resolved'; acknowledgements row mirrors
// it and stamps resolved_at). Audited.
// ---------------------------------------------------------------------------
async function resolveDispute(shopId, txnId, note) {
  if (!isValidId(shopId) || !isValidId(txnId)) throw new AckError('ACK_BAD_STATE');
  const trows = await Q(client().from('transactions').select('id, shop_id, ack_status, status')
    .eq('id', String(txnId)).eq('shop_id', String(shopId)).limit(1));
  const tx = trows[0];
  if (!tx) throw new AckError('ACK_BAD_STATE');
  if (tx.ack_status !== 'disputed') throw Object.assign(new AckError('ACK_BAD_STATE'), { code: 'NOT_DISPUTED' });
  try {
    const a = await client().from('acknowledgements').update({
      status: 'resolved', resolved_at: new Date().toISOString(),
    }).eq('shop_id', String(shopId)).eq('transaction_id', String(txnId)).eq('status', 'disputed');
    if (a && a.error) throw wrapDb(a.error);
  } catch (e) { throw wrapDb(e); }
  try {
    const u = await client().from('transactions').update({ ack_status: 'resolved' })
      .eq('id', String(txnId)).eq('shop_id', String(shopId));
    if (u && u.error) throw wrapDb(u.error);
  } catch (e) { throw wrapDb(e); }
  try {
    await client().from('audit_events').insert({
      shop_id: String(shopId), action: 'ack-resolve', transaction_id: String(txnId), details: {},
    }); // the shop resolution note has no column and never lands in logs
  } catch (_) { /* best-effort */ }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// shopSummary(shopId) — counts per ack_status for the dashboard chip strip.
// Counted from the transactions table (one ack zone per entry) so severed
// (cancelled) links drop out naturally.
// ---------------------------------------------------------------------------
async function shopSummary(shopId) {
  if (!isValidId(shopId)) return { awaiting: 0, acknowledged: 0, disputed: 0 };
  let rows;
  try {
    const r = await client().from('transactions').select('ack_status')
      .eq('shop_id', String(shopId))
      .in('ack_status', ['awaiting', 'acknowledged', 'disputed']);
    if (r && r.error) throw wrapDb(r.error);
    rows = r.data || [];
  } catch (e) { throw wrapDb(e); }
  const out = { awaiting: 0, acknowledged: 0, disputed: 0 };
  for (const r of rows) if (out[r.ack_status] != null) out[r.ack_status]++;
  return out;
}

// ---------------------------------------------------------------------------
// info(shopId, txnId) — the SHOP's view of one entry's acknowledgement: the
// tx ack_status plus the latest ack row (dispute note, timestamps). Scoped to
// the session shop; nothing here is publicly reachable.
// ---------------------------------------------------------------------------
async function info(shopId, txnId) {
  if (!isValidId(shopId) || !isValidId(txnId)) throw new AckError('ACK_BAD_STATE');
  const trows = await Q(client().from('transactions').select('id, shop_id, ack_status, status')
    .eq('id', String(txnId)).eq('shop_id', String(shopId)).limit(1));
  const tx = trows[0];
  if (!tx) return null;
  const arows = await Q(client().from('acknowledgements').select(
    'id, status, dispute_note, created_at, expires_at, responded_at, resolved_at')
    .eq('shop_id', String(shopId)).eq('transaction_id', String(txnId)));
  // newest-wins, sorted in code so fake/real clients behave identically
  const acks = (arows || []).slice().sort((x, y) => String(x.created_at).localeCompare(String(y.created_at)));
  return {
    ack_status: tx.ack_status || 'not_required',
    tx_status: tx.status || 'posted',
    acknowledgement: acks.length ? acks[acks.length - 1] : null,
  };
}

// disputed-entry badges computed on read: shop -> list of customer ids that
// have at least one POSTED disputed entry (just returned as a Set for UI use)
async function disputedByCustomer(shopId) {
  let rows;
  try {
    const r = await client().from('transactions').select('customer_id, status')
      .eq('shop_id', String(shopId)).eq('ack_status', 'disputed');
    if (r && r.error) throw wrapDb(r.error);
    rows = r.data || [];
  } catch (e) { throw wrapDb(e); }
  return new Set(rows.filter(r => r.status === 'posted').map(r => r.customer_id));
}

// ---------- helpers ----------
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidId(x) { return UUID_RE.test(String(x || '')); }
async function Q(p) {
  let r;
  try { r = await p; }
  catch (e) { throw wrapDb(e); }
  if (r && r.error) throw wrapDb(r.error);
  return r.data || [];
}
async function byHash(hash) {
  let r;
  try {
    r = await client().from('acknowledgements').select('id, shop_id, transaction_id, token_hash, status, dispute_note, created_at, expires_at, responded_at')
      .eq('token_hash', hash).limit(1);
  } catch (e) { throw wrapDb(e); }
  return (r && r.data && r.data[0]) || null;
}
async function txRowById(ack) {
  let r;
  try {
    r = await client().from('transactions').select(TX_COLS)
      .eq('id', ack.transaction_id).eq('shop_id', ack.shop_id).limit(1);
  } catch (e) { throw wrapDb(e); }
  return (r && r.data && r.data[0]) || null;
}
async function txById(ack) { return txRowById(ack); }
// unify transport + supabase shape errors into AckError DB_ERROR (500-class);
// unlike client-shape errors these must never read as a caller's fault
function wrapDb(e) {
  return Object.assign(new AckError('DB_ERROR', 'acknowledgements storage error'), { cause: e });
}

module.exports = {
  setClient,
  newToken, hashToken, TOKEN_RE, TOKEN_BYTES,
  ACKABLE, LINK_TTL_MS, GENERIC_404, DISPUTE_NOTE_MAX,
  createLink, cancelOnReversal, viewByToken, publicView, respond,
  resolveDispute, shopSummary, disputedByCustomer, info,
  AckError, MESSAGES,
};
