// rythu-parser.js — rule-based parser for Rythu (produce-buyer) speech.
// UMD: a browser global (parseRythu) and a Node module for tests.
// Separate from parser.js so kirana speech can never be mistaken for rythu events.
// Returned amount is a PREVIEW (rupees, 2dp). The server recomputes it
// authoritatively in integer paise (lib/money.js) — nothing here is ever stored.
'use strict';

// ---------------------------------------------------------------- produce --
const PROD_LIST = [
  ['వరి', 'paddy'], ['పత్తి', 'cotton'], ['మిరప', 'chilli'], ['మొక్కజొన్న', 'maize'],
  ['శనగ', 'bengal_gram'], ['కంది', 'red_gram'], ['పెసర', 'green_gram'],
  ['మినుము', 'black_gram'], ['వేరుశనగ', 'groundnut'], ['పసుపు', 'turmeric'],
  ['నువ్వులు', 'sesame'], ['జొన్న', 'jowar'],
  ['paddy', 'paddy'], ['cotton', 'cotton'], ['chilli', 'chilli'], ['maize', 'maize'],
];

// ---------------------------------------------------------------- events ---
// priority: deduction > advance > delivery > payment
const DEDUCT = /(హమాలీ|కమీషన్|రవాణా|తరుగు|తగ్గింపు|hamali|commission|transport|tharugu|thagginpu|deduction)/i;
const ADVANCE = /(అడ్వాన్స్|advance|ముందు)/i;
const DELIVER = /(తెచ్చారు|పోశారు|అమ్మారు|వేశారు|tecchaaru|techchaaru|techcharu|poashaaru|poshaaru|poshaari|ammaaru|ammaraaru|veshaaru|vesaaru|delivered|brought)/i;
const PAY = /(చెల్లింపు|చెల్లించా|ఇచ్చాను|ఇచ్చారు|chellinch|ichaanu|ichanu|payment|paid|gave)/i;

// --------------------------------------------------------- number words ----
// Composing law (same spirit as parser.js): <m> × <mult>, <mult>=100/1000.
const WORDNUM = [
  // Telugu fused half-words first
  [/^అర$/, 0.5], [/^ఒకటిన్నర$/, 1.5], [/^రెండున్నర$/, 2.5], [/^మూడున్నర$/, 3.5],
  [/^నాలుగున్నర$/, 4.5],
  [/^ఒక(టి)?$/, 1], [/^రెండు$/, 2], [/^మూడు$/, 3], [/^నాలుగు$/, 4], [/^ఐదు$/, 5],
  [/^ఆరు$/, 6], [/^ఏడు$/, 7], [/^ఎనిమిది$/, 8], [/^తొమ్మిది$/, 9], [/^పది$/, 10],
  [/^ఇరవై$/, 20], [/^ముప్పై$/, 30], [/^నలభై$/, 40], [/^యాభై$/, 50], [/^అరవై$/, 60],
  [/^డెబ్భై$/, 70], [/^ఎనభై$/, 80], [/^తొంభై$/, 90],
  [/^వంద(లు|ల|ా)?$/, 100], [/^(వెయ్యి|వేలు|వేల)$/, 1000],
  // Hindi (incl. डेढ़/ढाई and Telugu-script transliterations of them)
  [/^डेढ़$/, 1.5], [/^ढाई$/, 2.5], [/^(డేఢ|డేఢ़)$/, 1.5], [/^ఢా(ఇ|ఈ)$/, 2.5],
  [/^एक$/, 1], [/^दो$/, 2], [/^तीन$/, 3], [/^चार$/, 4], [/^(पाँच|पांच)$/, 5],
  [/^छह$/, 6], [/^सात$/, 7], [/^आठ$/, 8], [/^नौ$/, 9], [/^दस$/, 10],
  [/^बीस$/, 20], [/^तीस$/, 30], [/^चालीस$/, 40], [/^पचास$/, 50],
  [/^सौ$/, 100], [/^(हज़ार|हजार)$/, 1000],
  // English/kirana lexical reuse
  [/^one$/, 1], [/^two$/, 2], [/^three$/, 3], [/^four$/, 4], [/^five$/, 5],
  [/^six$/, 6], [/^seven$/, 7], [/^eight$/, 8], [/^nine$/, 9], [/^ten$/, 10],
  [/^twenty$/, 20], [/^thirty$/, 30], [/^forty$/, 40], [/^fifty$/, 50], [/^sixty$/, 60],
  [/^seventy$/, 70], [/^eighty$/, 80], [/^ninety$/, 90],
  [/^hundred(s)?$/, 100], [/^thousand(s)?$/, 1000],
].map(([re, v]) => [new RegExp(re.source, 'i'), v]);

function numval(tok) {
  const w = String(tok || '').toLowerCase().replace(/[.,?!।]/g, '');
  for (const [re, v] of WORDNUM) if (re.test(w)) return v;
  return null;
}
// [2,1000,5,100] -> 2500 · [5,100,50] -> 550 · [0.5] -> 0.5
function runAmount(vals) {
  let total = 0, acc = 0;
  for (const v of vals) {
    if (v >= 100) { total += (acc || 1) * v; acc = 0; }
    else acc += v;
  }
  return total + acc;
}
// fused digits/units: "5క్వింటాళ్లు" -> "5 క్వింటాళ్లు"; "ఐదువందలు" -> "ఐదు వందలు"
function splitFused(t) {
  const UN = '(క్వింటాళ్లు|క్వింటాలు|క్వింటా|కిలోలు|కిలో|కేజీ|టన్నులు|టన్ను|బస్తాలు|బస్తా)';
  t = t.replace(new RegExp('(\\d+)' + UN, 'g'), '$1 $2');
  for (const W of ['ఒక', 'రెండు', 'మూడు', 'నాలుగు', 'ఐదు', 'ఆరు', 'ఏడు', 'ఎనిమిది', 'తొమ్మిది', 'పది', 'ఇరవై', 'ముప్పై', 'నలభై', 'యాభై', 'అరవై', 'డెబ్భై', 'ఎనభై', 'తొంభై']) {
    t = t.replace(new RegExp(W + '(వందలు|వంద|వేలు|వేల|వెయ్యి)', 'g'), W + ' $1');
  }
  return t;
}
function wordRuns(t) {
  const toks = String(t).split(/[\s.,?!।]+/).filter(Boolean);
  const out = [];
  let i = 0;
  while (i < toks.length) {
    if (numval(toks[i]) == null) { i++; continue; }
    let j = i;
    while (j < toks.length && numval(toks[j]) != null) j++;
    out.push({ w: toks.slice(i, j).join(' '), value: runAmount(toks.slice(i, j).map(numval)), i, j });
    i = j;
  }
  return out;
}

// ------------------------------------------------------------------ units --
const KG_PER = { quintal: 100, kg: 1, ton: 1000, bag: null }; // bag needs a stated weight
const UNIT_RE = [
  [/^(?:క్వింటా(?:ళ్లు|ళ్ల|లు|ల)?)$/i, 'quintal'],
  [/^(?:కిలో(?:లు|ల)?|కేజీ(?:లు|ల)?)$/i, 'kg'],
  [/^(?:టన్ను(?:లు|ల)?)$/i, 'ton'],
  [/^(?:బస్తా(?:లు|ల)?)$/i, 'bag'],
];
const EN_UNITS = { quintal: /^(quintals?|quantal)$/i, kg: /^(kgs?|kilos?|kilograms?|kg)$/i, ton: /^(tons?|tonnes?)$/i, bag: /^(bags?)$/i };
function unitOf(tok) {
  const w = String(tok || '').toLowerCase().replace(/[.,?]/g, '');
  for (const [re, u] of UNIT_RE) if (re.test(w)) return u;
  for (const [u, re] of Object.entries(EN_UNITS)) if (re.test(w)) return u;
  return null;
}
// price-per phrasing: క్వింటాకు, కిలోకు, టన్నుకు…
function unitSuffixTok(tok) {
  const w = String(tok || '').toLowerCase();
  for (const u of ['quintal', 'kg', 'ton']) {
    const rootU = u === 'quintal' ? 'క్వింటా' : u === 'kg' ? 'కిలో' : 'టన్ను';
    if (new RegExp('^' + escapeRe(rootU) + '(?:క(?:ు|ి))?$').test(w)) return u;
  }
  if (/^(quintals?|kgs?|kilos?|tons?|tonnes?)\s*(?:per|each)?$/i.test(w)) return null;
  for (const [en, u] of [['quintal', 'quintal'], ['kg', 'kg'], ['ton', 'ton'], ['tonne', 'ton']]) {
    if (new RegExp('^' + en + 's?$').test(w)) return null;
  }
  return null;
}
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ----------------------------------------------------------- main entry ----
function parseRythu(raw) {
  const rawStr = String(raw == null ? '' : raw);
  const res = {
    event: null, farmer: null, produce: null, quantity: null, unit: null,
    bagKg: null, rate: null, rateUnit: null, amount: null, category: null,
    missing: [], raw: rawStr,
  };
  let t = rawStr.normalize('NFC').replace(/[\u200c\u200d]/g, '').trim();
  if (!t) { res.missing.push('FARMER', 'AMOUNT', 'EVENT'); return res; }
  t = t.replace(/[౦-౯]/g, c => c.charCodeAt(0) - 0xC66)
       .replace(/[०-९]/g, c => c.charCodeAt(0) - 0x966);
  t = splitFused(t);
  res.raw = t;

  // ---- event ----
  if (DEDUCT.test(t)) res.event = 'deduction';
  else if (ADVANCE.test(t)) res.event = 'advance';
  else if (DELIVER.test(t)) res.event = 'delivery';
  else if (PAY.test(t)) res.event = 'payment';

  // ---- tokens, units, bag weight ----
  const toks = t.split(/[\s.,?!।]+/).filter(Boolean);
  const lowered = toks.map(w => w.toLowerCase());
  let unit = null;
  let unitTokIdx = -1;
  let bagSeen = false;
  for (let i = 0; i < lowered.length; i++) {
    const u = unitOf(lowered[i]);
    if (u === 'bag') bagSeen = true;
    if (u) { if (!unit) { unit = u; unitTokIdx = i; } }
  }
  // "50 కిలోలు బస్తా" — కిలో names the bag WEIGHT, బస్తా is the unit
  if (bagSeen) unit = 'bag';
  res.unit = unit;
  if (unit === 'bag') {
    let m = lowerText(t).match(/(\d+(?:[.,]\d+)?)\s*(?:కిలోలు|కిలో|కేజీ|kgs?|kilos?)/i);
    if (!m) m = lowerText(t).match(/(?:కిలోలు|కిలో|కేజీ|kgs?|kilos?)\s*(\d+(?:[.,]\d+)?)/i);
    if (m) {
      const v = parseFloat(m[1].replace(/,/g, ''));
      if (v > 0) res.bagKg = v;
    }
  }

  // ---- digits: rate wins its slots; the next free digit-run is the quantity ----
  const digitRuns = [];
  const dRe = /\d[\d,]*(?:\.\d+)?/g;
  let dm;
  while ((dm = dRe.exec(t)) !== null) digitRuns.push(dm[0]);
  const norm = s => parseFloat(String(s).replace(/,/g, ''));
  const consumed = new Set();
  const hasComma = s => String(s).replace(/,/g, '');

  let rateDigits = null, rateUnitHint = null;
  const r1 = t.match(new RegExp('(?:రేటు|రేట్|రేటి|rate|భావ)[^0-9]*?([0-9][0-9,]*(?:\\.[0-9]+)?)', 'i'));
  if (r1) {
    rateDigits = r1[1];
    consumed.add(hasComma(rateDigits));
    const tailTok = t.slice(r1.index + r1[0].length).trim().split(/[\s.,]+/).filter(Boolean)[0];
    const ru = tailTok ? unitOf(tailTok) : null;
    if (ru) rateUnitHint = ru;
  }
  if (rateDigits == null) {
    const r2 = t.match(/([0-9][0-9,]*(?:\.[0-9]+)?)\s*(?:per|పర)\s*/i);
    if (r2) {
      rateDigits = r2[1];
      consumed.add(hasComma(rateDigits));
      const tailTok = t.slice(r2.index + r2[0].length).trim().split(/[\s]+/).filter(Boolean)[0];
      const ru = tailTok ? unitOf(tailTok) : null;
      if (ru) rateUnitHint = ru;
      else {
        // "2200 per క్వింటా" — token may carry the Telugu unit
        const uu = tailTok ? unitOf(tailTok) : null;
        if (uu) rateUnitHint = uu;
      }
    }
  }
  if (rateDigits == null) {
    // "క్వింటాకు 2200"
    for (let i = 0; i < lowered.length; i++) {
      const su = unitSuffixTok(lowered[i]);
      if (!su) continue;
      const m = t.match(new RegExp(escapeRe(toks[i]) + '\\s*([0-9][0-9,]*(?:\\.[0-9]+)?)', 'i'));
      if (m) { rateDigits = m[1]; consumed.add(hasComma(rateDigits)); rateUnitHint = su; }
      break;
    }
  }
  if (rateDigits != null) res.rate = norm(rateDigits);

  // bag weight consumes its own digits (a stated kg per bag is NEVER the qty)
  if (res.bagKg != null) {
    for (const s of digitRuns) {
      if (Math.abs(norm(s) - res.bagKg) < 1e-9 && !consumed.has(hasComma(s))) {
        consumed.add(hasComma(s));
        break;
      }
    }
  }

  let quantity = null;
  const qtyDigits = digitRuns.filter(s => !consumed.has(hasComma(s)));
  if (qtyDigits.length) quantity = norm(qtyDigits[0]);
  res.quantity = quantity;

  // ---- produce (token prefix, longest Telugu stems first) ----
  for (const [te, en] of PROD_LIST) {
    if (!te) continue;
    if (new RegExp('(?:^|[^ఀ-౿])' + escapeRe(te), 'i').test(t)) { res.produce = en; break; }
    for (const w of lowered) {
      if (w.startsWith(te.toLowerCase())) { res.produce = en; break; }
    }
    if (res.produce) break;
    if (new RegExp('(?:^|\\s)' + escapeRe(te) + '(?:$|\\s|ా)', 'i').test(t)) { res.produce = en; break; }
  }

  // ---- produce + quantity/unit without payment words ⇒ a delivery ----
  // ("సురేష్ 5 క్వింటాళ్లు వరి" — no explicit verb, still a purchase;
  //  "50 కిలో బస్తా వరి" — unit alone also implies a produce delivery)
  if (!res.event && res.produce && (res.quantity != null || res.unit)) res.event = 'delivery';

  // last resort for deliveries: exactly ONE leftover digit-run beyond the
  // quantity is the rate — "2 క్వింటాళ్లు 2300" (2300 per the quantity's unit).
  // Never applied to cash events and never without a produce context.
  if (res.rate == null && (!res.event || res.event === 'delivery') &&
      res.produce != null && qtyDigits.length === 2) {
    res.rate = norm(qtyDigits[1]);
    rateUnitHint = rateUnitHint || res.unit;
  }

  // ---- rate words when there are no digits ("రేటు రెండు వేలు") ----
  if (res.rate == null && !digitRuns.length) {
    const kw = t.toLowerCase().match(/(?:రేటు|రేట్|రేటి|rate|భావ)/i);
    if (kw) {
      const tailRuns = wordRuns(t.slice(kw.index + kw[0].length));
      if (tailRuns.length) {
        res.rate = tailRuns[0].value;
        const afterTok = (t.slice(kw.index + kw[0].length).trim().split(/[\s]+/).filter(Boolean) || [])[tailRuns[0].j] || '';
        // the unit token after the rate words (rare) — default below covers the rest
        if (afterTok) {
          const ru = unitOf(afterTok);
          if (ru) rateUnitHint = ru;
        }
      }
    }
  }

  // ---- quantity words before the unit token (digits may all be rate/bag) ----
  // word-only quantities are inferred for deliveries / undecided events only —
  // for cash events the word run IS the amount (handled below)
  if (res.quantity == null && (!res.event || res.event === 'delivery')) {
    const runs = wordRuns(t).filter(rr => unitTokIdx < 0 || rr.j <= unitTokIdx);
    if (runs.length) res.quantity = runs[0].value;
  }

  // ---- rateUnit: explicit hint, else the quantity's own unit ----
  res.rateUnit = rateUnitHint || res.unit;

  // ---- event-specific numbers ----
  if (res.event && res.event !== 'delivery') {
    // cash amount: the first free digit-run, else the first word run
    res.amount = qtyDigits.length ? norm(qtyDigits[0]) : (digitRuns.length ? null : (wordRuns(t).length ? wordRuns(t)[0].value : null));
    if (res.event === 'deduction') res.category = categorize(t);
  }
  // delivery total = quantity (via kg scale) × rate — PREVIEW only
  if (res.event === 'delivery' && res.quantity != null && res.rate != null) {
    const ru = res.rateUnit || res.unit || 'kg';
    const kU = res.unit === 'bag' ? res.bagKg : KG_PER[res.unit];
    const kR = ru === 'bag' ? res.bagKg : KG_PER[ru];
    if (kU != null && kR != null && kR > 0) {
      const kgQty = res.quantity * kU;
      res.amount = Math.round((kgQty / kR) * res.rate * 100) / 100;
    }
  }

  // ---- farmer name ----
  res.farmer = scrapeName(t);

  // ---- missing fields (the UI asks ONE question per missing field) ----
  if (!res.farmer) res.missing.push('FARMER');
  if (res.event === 'delivery') {
    if (!res.produce) res.missing.push('PRODUCE');
    if (res.quantity == null) res.missing.push('QUANTITY');
    if (!res.unit) res.missing.push('UNIT');
    if (res.unit === 'bag' && res.bagKg == null) res.missing.push('BAG_WEIGHT');
    if (res.rate == null) res.missing.push('RATE');
  } else if (res.event === 'advance') {
    if (res.amount == null) res.missing.push('AMOUNT');
  } else if (res.event === 'deduction') {
    if (res.amount == null) res.missing.push('AMOUNT');
    if (!res.category) res.missing.push('CATEGORY');
  } else if (res.event === 'payment') {
    if (res.amount == null) res.missing.push('AMOUNT');
  } else {
    res.missing.push('EVENT');
  }
  return res;
}
function lowerText(t) { return String(t || '').toLowerCase(); }

function categorize(t) {
  if (/హమాలీ|hamali/i.test(t)) return 'hamali';
  if (/కమీషన్|commission/i.test(t)) return 'commission';
  if (/రవాణా|transport/i.test(t)) return 'transport';
  if (/తరుగు|తగ్గింపు|tharugu|thagginpu|weight loss/i.test(t)) return 'tharugu';
  return null;
}
// farmer name = tokens minus digits, number words, units, produce, event words
function scrapeName(t) {
  let s = String(t || '').replace(/\d[\d,.]*/g, ' ');
  s = s.split(/[\s.,?!।]+/).filter(Boolean)
    .filter(w => numval(w) == null)                // number words never belong to a name
    .filter(w => !PROD_LIST.some(([te]) => te && w.toLowerCase().startsWith(te.toLowerCase())))
    .filter(w => !unitOf(w))
    .join(' ');
  const KEY = [DEDUCT, ADVANCE, DELIVER, PAY].map(x => x.source).join('|');
  s = s.replace(new RegExp(KEY, 'gi'), ' ')
    .replace(/(?:క్వింటా|కిలో|కేజీ|టన్ను|బస్తా)(?:ళ్ల|లు|ల|కు|కి|ా|ు|ల)*/g, ' ')
    .replace(/\b(kg|kgs|kilo|kilos|kg|quintal|quintals|ton|tons|tonne|tonnes|bag|bags|per|rate|price|each)\b/gi, ' ')
    .replace(/\b(ki|ko|ku|garu|mariyu|ra)\b/gi, ' ')
    .replace(/(రూపాయలు|రూపాయల|రూ|రూపాయి|గారు|మరియు|కు|కి|కో)/g, ' ')
    .replace(/(రేటు|రేట్|రేటి|భావ|పర్)/g, ' ')
    .replace(/[.,?!।]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  return s || null;
}
// same parse + an explicit missing list (the diagnosis entry point)
function diagnose(raw) {
  return parseRythu(raw);
}
parseRythu.diagnose = diagnose;

// UMD tail: browser global + Node module (both, load-order safe)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = parseRythu;
  module.exports.diagnose = diagnose;
} else {
  window.parseRythu = parseRythu;
}
