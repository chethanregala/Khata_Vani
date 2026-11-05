// Rule-based parser for Telugu/Hindi/English ledger speech. No LLM needed.

// Number-word table: anchored whole-token => value. Includes native Telugu/Hindi
// words, English, and Devanagari/Telugu transliterations of English (Prisma may
// romanize English words like "five hundred" into "फाइव हंड्रेड" / "ఫైవ్ హండ్రెడ్").
const NUMWORDS = [
  // Telugu
  [/^ఒక(టి)?$/, 1], [/^రెండు$/, 2], [/^మూడు$/, 3], [/^నాలుగు$/, 4], [/^ఐదు$/, 5],
  [/^ఆరు$/, 6], [/^ఏడు$/, 7], [/^ఎనిమిది$/, 8], [/^తొమ్మిది$/, 9], [/^పది$/, 10],
  [/^ఇరవై$/, 20], [/^ముప్పై$/, 30], [/^యాభై$/, 50], [/^వంద(లు|ల|ా)?$/, 100], [/^(వెయ్యి|వేల(ు)?)$/, 1000],
  // Hindi
  [/^एक$/, 1], [/^दो$/, 2], [/^तीन$/, 3], [/^चार$/, 4], [/^(पाँच|पांच)$/, 5],
  [/^छह$/, 6], [/^सात$/, 7], [/^आठ$/, 8], [/^नौ$/, 9], [/^दस$/, 10],
  [/^बीस$/, 20], [/^तीस$/, 30], [/^पचास$/, 50], [/^सौ$/, 100], [/^(हज़ार|हजार)$/, 1000],
  // English
  [/^one$/, 1], [/^two$/, 2], [/^three$/, 3], [/^four$/, 4], [/^five$/, 5],
  [/^six$/, 6], [/^seven$/, 7], [/^eight$/, 8], [/^nine$/, 9], [/^ten$/, 10],
  [/^twenty$/, 20], [/^thirty$/, 30], [/^fifty$/, 50], [/^hundred$/, 100], [/^thousand$/, 1000],
  // Devanagari transliteration of English numerals
  [/^वन$/, 1], [/^टू$/, 2], [/^थ्री$/, 3], [/^फोर$/, 4], [/^फाइव$/, 5],
  [/^सिक्स$/, 6], [/^सेवन$/, 7], [/^ऐट?$/, 8], [/^नाइन$/, 9], [/^टेन$/, 10],
  [/^ट्वेंटी$/, 20], [/^थर्टी$/, 30], [/^फिफ्टी$/, 50], [/^(हंड्रेड|हंड्रड)$/, 100], [/^(थाउज़ेंड|थाउजेंड)$/, 1000],
  // Telugu transliteration of English numerals
  [/^వన్$/, 1], [/^టూ$/, 2], [/^థ్రీ$/, 3], [/^ఫోర్$/, 4], [/^ఫైవ్$/, 5],
  [/^సిక్స్$/, 6], [/^సెవెన్$/, 7], [/^ఎయిట్$/, 8], [/^నైన్$/, 9], [/^టెన్$/, 10],
  [/^హండ్రెడ్$/, 100], [/^థౌజెండ్$/, 1000],
].map(([re, v]) => [new RegExp(re.source, 'i'), v]);

function numval(tok) {
  for (const [re, v] of NUMWORDS) if (re.test(tok)) return v;
  return null;
}

// fused Telugu number compounds: "ఐదువందలు" -> "ఐదు వందలు", "రెండువేలు" -> "రెండు వేలు".
// Applied token-wise when the utterance has no digits, before amount extraction.
const FUSED_SUFFIXES = ['వందలు', 'వందల', 'వేలు'];
function splitFusedNumbers(t) {
  return t.split(/\s+/).filter(Boolean).map(tok => {
    for (const suf of FUSED_SUFFIXES) {
      if (tok.length > suf.length && tok.endsWith(suf)) return tok.slice(0, tok.length - suf.length) + ' ' + suf;
    }
    return tok;
  }).join(' ');
}

// Compose a spoken amount from a run of consecutive number words:
//   5 100        -> 500   ("ఐదు వందలు" / "पाँच सौ" / "five hundred")
//   2 1000 5 100 -> 2500  ("రెండు వేల ఐదు వందలు" — thousands part + hundreds part)
//   5 100 50     -> 550   ("ఐదు వందల యాభై" — a tens/ones word directly following is added)
function runAmount(run) {
  let total = 0, small = 0, hasSmall = false;
  for (const { val } of run) {
    if (val === 100 || val === 1000) {
      total += (hasSmall ? small : 1) * val;
      small = 0; hasSmall = false;
    } else {
      small += val; hasSmall = true;
    }
  }
  if (hasSmall) total += small;
  return { amount: total, used: run.map(v => v.tok) };
}

// Extract an amount from number words ONLY when no digit is present in the text.
// Returns { amount, used:[tokens consumed] }. The first run of number-word
// tokens in the text is the amount (compose multiples/remainders via runAmount).
function amountFromWords(t) {
  const toks = t.split(/[\s.,?!।]+/).filter(Boolean);
  const vals = toks.map(tok => ({ tok, val: numval(tok) }));
  for (let i = 0; i < vals.length; i++) {
    if (vals[i].val == null) continue;
    let j = i;
    while (j < vals.length && vals[j].val != null) j++;
    return runAmount(vals.slice(i, j));
  }
  return { amount: null, used: [] };
}

// Verbs STT tacks onto the sentence ("... appu raayi", "... చేయి"): real words but
// never part of a customer name. Token-level strip (not a global substring
// replace) so real names are never cut inside.
const FILLERS = new Set([
  'raayi', 'raasuko', 'raayandi', 'rayi', 'chey', 'cheyyi', 'veyyi', 'vesko', 'ivvu', 'ivvandi', 'mariyu',
  'రాయి', 'రాసుకో', 'రాయండి', 'చేయి', 'చేయండి', 'వేయి', 'వేసుకో', 'ఇవ్వు', 'ఇవ్వండి', 'మరియు', 'ఇంకా',
].map(w => w.toLowerCase()));

// NB: for every stem the LONGEST variant must come first — these regexes double
// as name strippers, and a short alternative would eat the stem and leave its
// tail ("అప్పుగా" matched as "అప్పు" would leak a stray "గా" into the name).
function parse(raw) {
  let t = (raw || '').normalize('NFC').replace(/[\u200c\u200d]/g, '');
  t = t.replace(/[౦-౯]/g, c => c.charCodeAt(0) - 0xC66).replace(/[०-९]/g, c => c.charCodeAt(0) - 0x966);
  const QUERY = /(entha|ఎంత|kitna|कितना|how much|balance|బ్యాలెన్స్)/i;
  const STRONGPAY = /(chellinchaaru|చెల్లించారు|చెల్లించాడు|చెల్లించింది|కట్టారు|కట్టాడు|జమచేయి|jamaa|జమా|jama|జమ|जमा|paid|payment|kattaru|kattadu|kattindi|కట్టా|కట్టింది|चुका)/i;
  const CREDIT = /(అప్పుగా|appuga|ఉద్దారు|ఉద్ధారు|ఉద్దారి|ఉద్ధారి|udhaari|uddhaari|uddhar|uddera|bakaaya|bakaya|బకాయి|ఉద్దార్|ఉద్ధార్|ఉద్దరా|ఉద్ధరా|uddaar|uddar|udaar|udhaar|udhar|udar|baaki|baki|appu|అప్పు|బాకీ|బాకి|ఉదారి|ఉదారు|ఉదార్|ఉధార్|ఉదార|ఉద్దెర|credit|उदार|उधार्|उधार|बाकी)/i;
  const WEAKPAY = /(ichindi|ichadu|ichaaru|icharu|ichhaaru|ఇచ్చింది|ఇచ్చాడు|ఇచ్చారు|ఇచ్చెను|diya|दिया)/i;

  // Amount: prefer literal digits; fall back to number words (and remember that
  // we did, so no number-word token leaks into the name).
  let amount = null, wordPath = false;
  const dm = t.match(/\d[\d,]*/);
  if (dm) amount = parseInt(dm[0].replace(/,/g, ''), 10);
  else {
    t = splitFusedNumbers(t); // "ఐదువందలు" -> "ఐదు వందలు" before composing
    const w = amountFromWords(t);
    amount = w.amount;
    wordPath = true;
  }

  let type = null;
  if (QUERY.test(t) && !STRONGPAY.test(t)) type = 'query';
  else if (STRONGPAY.test(t)) type = 'pay';
  else if (CREDIT.test(t)) type = 'credit';
  else if (WEAKPAY.test(t)) type = 'pay';

  // Name: drop digits, any number-word tokens (when the amount came from words),
  // keywords, stopwords, filler verbs.
  let name = t.replace(/\d[\d,]*/g, ' ');
  if (wordPath) {
    // multiplier words beyond the consumed run can never belong in a name
    name = name.split(/\s+/).filter(Boolean)
      .filter(w => numval(w.replace(/^[.,?!।]+|[.,?!।]+$/g, '')) == null)
      .join(' ');
  }
  name = name
    .replace(new RegExp([QUERY, STRONGPAY, CREDIT, WEAKPAY].map(r => r.source).join('|'), 'gi'), ' ')
    .replace(/\b(ki|ko|ku|rupees?|rs|rupayalu|rupaye|ra|garu)\b/gi, ' ')
    .replace(/(రూపాయలు|రూపాయల|రూ|రూపాయి|रुपये|को|की)/g, ' ')
    .replace(/[.,?!।]/g, ' ').replace(/\s+/g, ' ').trim();
  name = name.split(/\s+/).filter(Boolean).filter(w => !FILLERS.has(w.toLowerCase())).join(' ');
  name = name.split(' ').filter(Boolean).map(w => w.replace(/(గారికి|కి|కు)$/, '')).join(' ').replace(/\s+/g, ' ').trim();
  return { type, amount, name, raw };
}

// Second entry point: what parse heard + which fields are missing, so the UI can
// ask ONE targeted follow-up question instead of guessing a missing field.
function diagnose(raw) {
  const p = parse(raw);
  const missing = [];
  if (!p.type) missing.push('type');
  if (!p.amount) missing.push('amount');
  if (!p.name) missing.push('name');
  return { type: p.type, amount: p.amount, name: p.name, missing };
}
if (typeof module !== 'undefined') { module.exports = parse; module.exports.diagnose = diagnose; }
