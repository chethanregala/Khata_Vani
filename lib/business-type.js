// business-type.js — pure kirana/rythu separation rules.
// No client here: rules are testable in isolation (see test-business-type.js);
// server.js injects Supabase and applies them to every ledger route.
'use strict';

const BUSINESS_TYPES = ['kirana', 'rythu'];

// decide(): the backfill/onboarding rule, as a pure function.
//   rythu data  = workflow='rythu' transaction rows OR kind='farmer' customers
//   kirana data = workflow<>'rythu' rows OR kind<>'farmer' customers
//   both kinds of data, or none -> null (the shop must choose)
// counts override booleans so callers can pass either; a non-empty count is
// treated as "has data".
function decide({ rythuRows = 0, kiranaRows = 0, farmerCustomers = 0, otherCustomers = 0,
                  hasRythu = false, hasKirana = false } = {}) {
  const ry = hasRythu || rythuRows > 0 || farmerCustomers > 0;
  const ki = hasKirana || kiranaRows > 0 || otherCustomers > 0;
  if (ry && !ki) return 'rythu';
  if (ki && !ry) return 'kirana';
  return null; // both, or neither
}

function isValid(v) {
  return v === 'kirana' || v === 'rythu';
}

// who may PUT /api/me/business-type: a shop that already HAS a value may only
// switch while it still has ZERO transactions; once business happens the
// historical evidence locks the choice.
//   returns null if allowed, else the 409 error code.
function changeRule(current, transactionCount) {
  const empty = !Number(transactionCount);   // 0, null, undefined
  if (current && !empty) return 'BUSINESS_TYPE_LOCKED';
  return null;
}

// the workflow a shop is allowed to post rows under, derived server-side from
// business type (client-supplied workflow is ignored for /api/voice/propose,
// and /api/transactions rejects a mismatch outright)
const workflowOf = t => (t === 'rythu' ? 'rythu' : 'kirana');

// the customer kind a shop creates: kirana -> 'customer', rythu -> 'farmer'.
// A shop explicitly sending the other kind gets KIND_MISMATCH at the ledger,
// but the route rejects it earlier with a 403 code.
const kindOf = t => (t === 'rythu' ? 'farmer' : 'customer');

module.exports = { BUSINESS_TYPES, decide, isValid, changeRule, workflowOf, kindOf };
