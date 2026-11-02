// Rule-based parser for Telugu/Hindi/English ledger speech. No LLM needed.

// Number-word table: anchored whole-token => value. Includes native Telugu/Hindi
// words, English, and Devanagari/Telugu transliterations of English (Prisma may
// romanize English words like "five hundred" into "फाइव हंड्रेड" / "ఫైవ్ హండ్రెడ్").
const NUMWORDS = [
  // Telugu
  [/^ఒక(టి)?$/, 1], [/^రెండు$/, 2], [/^మూడు$/, 3], [/^నాలుగు$/, 4], [/^ఐదు$/, 5],
  [/^ఆరు$/, 6], [/^ఏడు$/, 7], [/^ఎనిమిది$/, 8], [/^తొమ్మిది$/, 9], [/^పది$/, 10],
  [/^ఇరవై$/, 20], [/^ముప్పై$/, 30], [/^యాభై$/, 50], [/^వంద(లు)?$/, 100], [/^(వెయ్యి|వేల(ు)?)$/, 1000],
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

// Extract an amount from number words ONLY when no digit is present in the text.
// Returns { amount, used:[tokens consumed] }. A digit-word followed by
// hundred/thousand multiplies (e.g. "ఐదు వందలు"/"पाँच सौ"/"five hundred" = 500).
function amountFromWords(t) {
  const toks = t.split(/[\s.,?!।]+/).filter(Boolean);
  const vals = toks.map(tok => ({ tok, val: numval(tok) }));
  for (let i = 0; i < vals.length; i++) {
    const a = vals[i];
    if (!a || a.val == null || a.val >= 100) continue;
    const b = vals[i + 1];
    if (b && b.val != null && (b.val === 100 || b.val === 1000)) {
      return { amount: a.val * b.val, used: [a.tok, b.tok] };
    }
  }
  const bare = vals.find(v => v && v.val != null);
  return bare ? { amount: bare.val, used: [bare.tok] } : { amount: null, used: [] };
}

function parse(raw) {
  let t = (raw || '').normalize('NFC').replace(/[\u200c\u200d]/g, '');
  t = t.replace(/[౦-౯]/g, c => c.charCodeAt(0) - 0xC66).replace(/[०-९]/g, c => c.charCodeAt(0) - 0x966);
  const QUERY = /(entha|ఎంత|kitna|कितना|how much|balance|బ్యాలెన్స్)/i;
  const STRONGPAY = /(jama|jamaa|జమ|జమా|जमा|paid|kattaru|kattindi|కట్టా|चुका)/i;
  const CREDIT = /(udhaar|udhar|udar|udhaari|uddhar|uddera|appu|baaki|baki|ఉద్దెర|అప్పు|బాకీ|బాకి|ఉదార్|ఉధార్|ఉదారు|ఉదార|उदार|उधार्|उधार|बाकी)/i;
  const WEAKPAY = /(ichindi|ichadu|ichaaru|ఇచ్చింది|ఇచ్చాడు|ఇచ్చారు|diya|दिया)/i;

  // Amount: prefer literal digits; fall back to number words (and remember the
  // word tokens used so we can strip them out of the name).
  let amount = null, usedNums = [];
  const m = t.match(/\d[\d,]*/);
  if (m) amount = parseInt(m[0].replace(/,/g, ''), 10);
  else { const w = amountFromWords(t); amount = w.amount; usedNums = w.used; }

  let type = null;
  if (QUERY.test(t) && !STRONGPAY.test(t)) type = 'query';
  else if (STRONGPAY.test(t)) type = 'pay';
  else if (CREDIT.test(t)) type = 'credit';
  else if (WEAKPAY.test(t)) type = 'pay';

  // Name: drop digits, any number-word tokens we consumed, keywords, stopwords.
  let name = t.replace(/\d[\d,]*/g, ' ');
  if (usedNums.length) {
    const set = new Set(usedNums);
    name = name.split(/\s+/).filter(Boolean)
      .filter(w => !set.has(w.replace(/^[.,?!।]+|[.,?!।]+$/g, '')))
      .join(' ');
  }
  name = name
    .replace(new RegExp([QUERY, STRONGPAY, CREDIT, WEAKPAY].map(r => r.source).join('|'), 'gi'), ' ')
    .replace(/\b(ki|ko|ku|rupees?|rs|rupayalu|rupaye|ra|garu)\b/gi, ' ')
    .replace(/(రూపాయలు|రూపాయల|రూ|రూపాయి|रुपये|को|की)/g, ' ')
    .replace(/[.,?!।]/g, ' ').replace(/\s+/g, ' ').trim();
  name = name.split(' ').map(w => w.replace(/(గారికి|కి|కు)$/, '')).join(' ').trim();
  return { type, amount, name, raw };
}
if (typeof module !== 'undefined') module.exports = parse;
