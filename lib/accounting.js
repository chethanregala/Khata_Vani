// accounting.js — pure helpers for Task 2 (kirana + aadhati accounting).
// No I/O, no Supabase: everything here is testable without a client.
// Money stays integer paise (lib/money.js). CSV helpers are injection-safe.
'use strict';

const money = require('./money');

// payment channels carried on repayments / advances / payments
const PAY_MODES = ['cash', 'upi', 'bank', 'other'];

// ---------------------------------------------------------------------------
// commissionPaise(amountPaise, percent) — aadhati commission, HALF-UP on paise.
// percent accepts a shop-level number like 2 or 2.5 (0 => 0, null => 0).
// ---------------------------------------------------------------------------
function commissionPaise(amountPaise, percent) {
  const amt = Number(amountPaise);
  const pct = Number(percent);
  if (!(amt > 0) || !isFinite(pct) || pct <= 0) return 0;
  const raw = amt * (pct / 100);
  return Math.floor(raw + 0.5); // half-up to the nearest whole paisa
}

// ---------------------------------------------------------------------------
// Discount (write-off) guard rules — the ONLY place these numbers live.
// A discount is allowed when:
//   • the balance before it is positive (something actually owed), and
//   • the amount is <= max(5% of that balance, ₹50) — "small leftover" only.
// Larger waivers are always blocked (do it as several payments instead).
// ---------------------------------------------------------------------------
const DISCOUNT_MIN_BASE_PAISE = money.toPaise('50'); // ₹50 absolute floor

function discountMaxPaise(balancePaise) {
  if (!(balancePaise > 0)) return 0;
  const fivePct = Math.ceil(balancePaise * 0.05); // round UP so the cap errs small
  return Math.max(fivePct, DISCOUNT_MIN_BASE_PAISE);
}

function discountAllowed(balancePaise, amountPaise) {
  const bal = Number(balancePaise);
  const amt = Number(amountPaise);
  if (!isFinite(bal) || !isFinite(amt) || !(amt > 0)) return false;
  return bal > 0 && amt <= discountMaxPaise(bal);
}

// ---------------------------------------------------------------------------
// CSV — injection-safe cell escaping. A cell that Excel would evaluate as a
// formula (leading = + - @) gets an apostrophe prefix; standard quoting wraps
// quotes/doubles; commas, newlines and quotes force full-quoting.
// ---------------------------------------------------------------------------
function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@]/.test(s)) s = "'" + s; // CSV-injection guard
  if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function toCsv(rows) {
  return rows.map(r => r.map(csvCell).join(',')).join('\r\n') + (rows.length ? '\r\n' : '');
}

// UTF-8 BOM so Excel opens Telugu folk names without mojibake
const CSV_BOM = '\uFEFF';

module.exports = {
  PAY_MODES, CSV_BOM,
  commissionPaise, discountMaxPaise, discountAllowed,
  csvCell, toCsv,
};
