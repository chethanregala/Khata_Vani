// Name resolution for spoken customer names. Plain JS, no DOM, unit-testable in Node
// (same pattern as parser.js):  const resolve = require('./public/resolver.js');
//
// resolve(spoken, customers) -> { status: 'none'|'one'|'many'|'fuzzy', candidates: [...] }
//   customers: [{ id, name, label, phone, aliases, ... }]  (the shop's own list)
//
// a) normalize  : lowercase, strip ZWNJ/ZWJ, collapse spaces, drop trailing Telugu
//                 suffixes (కి, కు, గారికి, గారు) — applied to the utterance AND to
//                 every stored name / alias / label so both sides match.
//   b) exact     : normalized utterance === normalized name OR any alias.
//   c) label     : extra tokens that match a customer's label narrow the shortlist
//                 ("Ramesh tailor" -> the Ramesh whose label is "tailor").
//   d) fuzzy     : Levenshtein <= 1 against a name/alias of >= 4 chars.

const SUFFIXES = ['గారికి', 'గారు', 'కి', 'కు'];

// lowercase, strip ZWNJ/ZWJ + punctuation, collapse spaces, strip trailing suffixes
function normalize(s) {
  let t = String(s == null ? '' : s).normalize('NFC').toLowerCase()
    .replace(/[\u200c\u200d]/g, '')
    .replace(/[.,?!।'"]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  const out = [];
  for (const w of t.split(' ')) {
    let x = w;
    for (;;) {
      const before = x;
      for (const suf of SUFFIXES) {
        if (x.length >= suf.length && x.endsWith(suf)) x = x.slice(0, -suf.length);
      }
      if (x === before) break;
    }
    out.push(x);
  }
  // a token that was nothing but a suffix ("రమేష్ కి") drops out of the result
  return out.filter(Boolean).join(' ');
}

// classic Levenshtein distance (small strings only)
function levenshtein(a, b) {
  a = String(a); b = String(b);
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

function finish(hits) {
  return { status: hits.length === 1 ? 'one' : 'many', candidates: hits.map(h => h.c) };
}

function resolve(spoken, customers) {
  const q = normalize(spoken);
  const items = (Array.isArray(customers) ? customers : [])
    .filter(c => c && c.name)
    .map(c => ({
      c,
      name: normalize(c.name),
      aliases: (Array.isArray(c.aliases) ? c.aliases : []).map(normalize).filter(Boolean),
      label: normalize(c.label || ''),
    }))
    .filter(i => i.name);
  if (!q || !items.length) return { status: 'none', candidates: [] };

  const isHit = (i, s) => i.name === s || i.aliases.indexOf(s) !== -1;

  // b) exact match on the whole utterance
  const exact = items.filter(i => isHit(i, q));
  if (exact.length) return finish(exact);

  // c) extra tokens matching a label narrow the shortlist
  const toks = q.split(' ');
  let fallback = null;
  for (let cut = toks.length - 1; cut >= 1; cut--) {
    const base = toks.slice(0, cut).join(' ');
    const extra = toks.slice(cut);
    const baseHits = items.filter(i => isHit(i, base));
    if (!baseHits.length) continue;
    const narrowed = baseHits.filter(i => i.label && extra.some(t => i.label.split(' ').indexOf(t) !== -1));
    if (narrowed.length) return finish(narrowed);
    if (!fallback) fallback = baseHits;
  }
  if (fallback) return finish(fallback);

  // d) fuzzy: Levenshtein <= 1, only for names/aliases of >= 4 chars
  //    (a Telugu-script utterance vs a Latin-script name is NOT a near miss -> 'none',
  //     so the app asks "New customer ...?" instead of guessing)
  if (q.length >= 4) {
    const near = items.filter(i =>
      (i.name.length >= 4 && levenshtein(q, i.name) <= 1) ||
      i.aliases.some(a => a.length >= 4 && levenshtein(q, a) <= 1));
    if (near.length) return { status: 'fuzzy', candidates: near.map(n => n.c) };
  }
  return { status: 'none', candidates: [] };
}

resolve.normalize = normalize;
resolve.levenshtein = levenshtein;
if (typeof module !== 'undefined' && module.exports) module.exports = resolve;
