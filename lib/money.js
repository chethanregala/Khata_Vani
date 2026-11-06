// money.js — exact money/quantity math for the Khata Vani ledger.
// All ledger amounts are INTEGER PAISE internally. Floats are only ever
// accepted at the boundary and converted via STRING representation, so no
// 0.1+0.2 surprises ever reach the ledger. Rounding is HALF-UP (Indian practice).
'use strict';

const PAISE_LIMIT = 99999999999; // numeric(12,2) => ₹999,999,999.99

const MESSAGES = {
  AMOUNT_BAD: 'మొత్తం సరిలేదు · invalid amount',
  AMOUNT_PRECISION: 'మొత్తంలో రూపాయల వరకు రెండు అంకెలు మాత్రమే · max 2 decimals',
  AMOUNT_TOO_LARGE: 'మొత్తం చాలా పెద్దది · amount too large',
  QUANTITY_BAD: 'పరిమాణం సరిలేదు · invalid quantity',
  QUANTITY_PRECISION: 'పరిమాణంలో 3 దశాంశాలు మాత్రమే · max 3 decimals',
  QUANTITY_TOO_LARGE: 'పరిమాణం చాలా పెద్దది · quantity too large',
  RATE_BAD: 'రేటు సరిలేదు · invalid rate',
  RATE_PRECISION: 'రేటులో 2 దశాంశాలు మాత్రమే · max 2 decimals',
  RATE_TOO_LARGE: 'రేటు చాలా పెద్దది · rate too large',
  UNIT_UNSUPPORTED: 'ఈ యూనిట్ మద్దతు లేదు · unit not supported',
  MISSING_BAG_WEIGHT: 'సంచి బరువు తెలియాలి · explicit bag weight required',
  PRODUCT: 'money error',
};

// MoneyError carries a machine code (safe to log and return) — never the value.
class MoneyError extends Error {
  constructor(code, message) {
    super(message || MESSAGES[code] || MESSAGES.PRODUCT);
    this.name = 'MoneyError';
    this.code = code;
  }
}

// strict decimal string check: optional sign, plain digits, <= scale decimals.
// Rejects exponent notation, NaN, Infinity, whitespace noise.
function validDecimalString(s, maxScale) {
  return new RegExp('^-?\\d+(\\.\\d{1,' + maxScale + '})?$').test(s);
}

// integer digit strings -> paise, purely on digits (no float math)
function paiseFromParts(intDigits, fracDigits) {
  let intPaise = 0;
  for (const ch of intDigits) intPaise = intPaise * 10 + (ch.charCodeAt(0) - 48);
  const padded = ((fracDigits || '') + '00').slice(0, 2);
  const fracPaise = (padded.charCodeAt(0) - 48) * 10 + (padded.charAt(1).charCodeAt(0) - 48);
  return intPaise * 100 + fracPaise;
}

// Any number that JS String() gives exponent form (>=1e21, <1e-6) must be rejected
// long before it matters — enforce sanity limits here and in validateAmount.
function toPaise(v) {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new MoneyError('AMOUNT_BAD');
    v = String(v);
  }
  if (typeof v !== 'string' || !validDecimalString(v, 2)) {
    if (typeof v === 'string' && /^-?\d+\.?\d{3,}$/.test(v)) throw new MoneyError('AMOUNT_PRECISION');
    throw new MoneyError('AMOUNT_BAD');
  }
  const neg = v.charAt(0) === '-';
  const body = neg ? v.slice(1) : v;
  const dot = body.indexOf('.');
  const intDigits = dot === -1 ? body : body.slice(0, dot);
  const fracDigits = dot === -1 ? '' : body.slice(dot + 1);
  const p = paiseFromParts(intDigits, fracDigits);
  if (p > PAISE_LIMIT) throw new MoneyError('AMOUNT_TOO_LARGE');
  return neg ? -p : p;
}

// paise -> JS number for JSON responses (<= 2 decimals so it round-trips exactly)
function paiseToRupees(p) {
  const a = Math.abs(Math.round(Number(p))); // integer paise, never a float artifact
  const s = String(a);
  const whole = s.slice(0, -2) || '0';
  const frac = s.slice(-2).padStart(2, '0');
  return Number((p < 0 ? '-' : '') + whole + '.' + frac);
}

// quantity: numeric(12,3) => integer MILLI-units internally
const QUANTITY_MAX_MILLI = 999999999999;
function toMilli(v) {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new MoneyError('QUANTITY_BAD');
    v = String(v);
  }
  if (typeof v !== 'string') throw new MoneyError('QUANTITY_BAD');
  if (!validDecimalString(v, 3)) {
    if (/^-?\d+\.?\d{4,}$/.test(v)) throw new MoneyError('QUANTITY_PRECISION');
    throw new MoneyError('QUANTITY_BAD');
  }
  const neg = v.charAt(0) === '-';
  const body = neg ? v.slice(1) : v;
  const dot = body.indexOf('.');
  const intDigits = dot === -1 ? body : body.slice(0, dot);
  const frac = ((dot === -1 ? '' : body.slice(dot + 1)) + '000').slice(0, 3);
  let milli = 0;
  for (const ch of intDigits) milli = milli * 10 + (ch.charCodeAt(0) - 48);
  let fracMilli = 0;
  for (let i = 0; i < 3; i++) fracMilli = fracMilli * 10 + (frac.charCodeAt(i) - 48);
  const total = milli * 1000 + fracMilli;
  if (total > QUANTITY_MAX_MILLI) throw new MoneyError('QUANTITY_TOO_LARGE');
  const signed = (neg ? -total : total);
  if (signed <= 0) throw new MoneyError('QUANTITY_BAD'); // quantities are strictly positive
  return signed;
}

const RATE_LIMIT_PAISE = 99999999999;
function rateToPaise(v) {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new MoneyError('RATE_BAD');
    v = String(v);
  }
  if (typeof v !== 'string') throw new MoneyError('RATE_BAD');
  if (!validDecimalString(v, 2)) {
    if (/^-?\d+\.?\d{3,}$/.test(v)) throw new MoneyError('RATE_PRECISION');
    throw new MoneyError('RATE_BAD');
  }
  const neg = v.charAt(0) === '-';
  const body = neg ? v.slice(1) : v;
  const dot = body.indexOf('.');
  const intDigits = dot === -1 ? body : body.slice(0, dot);
  const frac = ((dot === -1 ? '' : body.slice(dot + 1)) + '00').slice(0, 2);
  let p = paiseFromParts(intDigits, frac);
  if (p > RATE_LIMIT_PAISE) throw new MoneyError('RATE_TOO_LARGE');
  if (neg && p > 0) throw new MoneyError('RATE_BAD'); // rates are positive or zero
  return p;
}

// quantity(milli) x rate(paise) -> paise, HALF-UP. Integer arithmetic only:
//   prod = milli * ratePaise (exact while <= 2^53), then
//   paise = floor((prod + 500) / 1000)   [half-up for positive products]
function qtyRatePaise(milliQty, rateP) {
  const prod = milliQty * rateP;
  if (!Number.isSafeInteger(prod)) {
    throw new MoneyError('QUANTITY_TOO_LARGE', 'పరిమాణం × రేటు పరిమితి మించింది · out of safe range');
  }
  return prod >= 0
    ? Math.floor((prod + 500) / 1000)
    : -Math.floor((-prod + 500) / 1000);
}

// ---------------------------------------------------------------------------
// Unit conversion — weight units only, with an EXPLICIT bag weight.
// All factors: 1 unit in kg. Bag is 1 unit per bag-weight, so `bagKg` must be
// supplied at call time (never guessed, never cached silently).
// ---------------------------------------------------------------------------
const UNIT_KG = {
  kg: 1,
  quintal: 100,     // 1 quintal = 100 kg
  tonne: 1000,      // 1 tonne = 1000 kg
  bag: null,        // requires explicit bagKg at call time
};
const KG_ALIASES = { kilo: 'kg', kilos: 'kg', kgs: 'kg', quintals: 'quintal', tonnes: 'tonne', ton: 'tonne', tons: 'tonne', bags: 'bag', saari: 'bag' };

function normalizeUnit(unit) {
  const u = String(unit == null ? '' : unit).trim().toLowerCase();
  if (!u) return null;
  return KG_ALIASES[u] || u;
}

// returns integer gram-of-kg fine? No: quantity in kg as a NUMBER is fine here —
// we only multiply milliquantities through qtyRatePaise afterwards.
// Throws UNIT_UNSUPPORTED for anything outside the table (e.g. litre) and
// MISSING_BAG_WEIGHT when unit=bag but no explicit bagKg was given.
function toKg(milliQty, unit, bagKg) {
  let u = normalizeUnit(unit);
  if (!u || !(u in UNIT_KG)) throw new MoneyError('UNIT_UNSUPPORTED');
  if (!Object.prototype.hasOwnProperty.call(UNIT_KG, u)) throw new MoneyError('UNIT_UNSUPPORTED');
  if (u === 'bag') {
    if (bagKg == null) throw new MoneyError('MISSING_BAG_WEIGHT');
    const bagMilli = toMilli(bagKg); // bag weight shares quantity precision/positivity rules
    if (bagMilli == null || typeof bagMilli === 'undefined' || isNaN(bagMilli) || !bagMilli || bagMilli <= 0) throw new MoneyError('MISSING_BAG_WEIGHT');
    // kg = (milli bags / 1000) x (bagMilli kg / 1000) -> milli x milli / 1e6
    return (milliQty * bagMilli) / 1000000; // same "kg" scale as the table factors
  }
  return (milliQty * UNIT_KG[u]) / 1000;
}

// amount (paise) for a quantity priced per `unit`: reject "incompatible" mixes by
// requiring the supported table; produce events price per their own unit, so
// amount = quantity x rate with half-up rounding at the paise level.
function amountFromQtyRate(quantity, rate, unit, bagKg) {
  const milli = toMilli(quantity);
  const rateP = rateToPaise(rate);
  if (rateP === 0) throw new MoneyError('RATE_BAD'); // a priced delivery can never be free
  // validates the unit; the result is informational (kg) — pricing is per `unit`
  toKg(milli, unit, bagKg);
  return qtyRatePaise(milli, rateP);
}

module.exports = {
  MoneyError,
  PAISE_LIMIT,
  toPaise,
  paiseToRupees,
  toMilli,
  rateToPaise,
  qtyRatePaise,
  toKg,
  normalizeUnit,
  amountFromQtyRate,
  UNIT_KG,
  MESSAGES,
};
