const parse = require('./public/parser.js');
const { diagnose } = require('./public/parser.js');

const cases = [
  // regression: existing suite must keep passing
  { in: 'Ramesh ki 500 udhaar', name: 'Ramesh', amount: 500, type: 'credit' },
  { in: 'రమేష్ కి ఐదు వందలు ఉదార్', name: 'రమేష్', amount: 500, type: 'credit' },
  { in: 'रमेश की पाँच सौ उधार', name: 'रमेश', amount: 500, type: 'credit' },
  { in: 'లక్ష్మి 200 జమ', name: 'లక్ష్మి', amount: 200, type: 'pay' },
  { in: 'Ramesh ki entha baaki', name: 'Ramesh', amount: null, type: 'query' },
  // bug fix: Telugu udhaar spellings STT produces
  { in: 'రమేష్ కి 500 ఉద్దార్', name: 'రమేష్', amount: 500, type: 'credit' },
  { in: 'రమేష్ కి 500 ఉద్ధార్', name: 'రమేష్', amount: 500, type: 'credit' },
  { in: 'రమేష్ కి 500 ఉద్దరా', name: 'రమేష్', amount: 500, type: 'credit' },
  { in: 'రమేష్ కి 500 ఉద్దారి', name: 'రమేష్', amount: 500, type: 'credit' },
  { in: 'రమేష్ కి 500 అప్పుగా', name: 'రమేష్', amount: 500, type: 'credit' },
  { in: 'రమేష్ కి 500 బకాయి', name: 'రమేష్', amount: 500, type: 'credit' },
  { in: 'Ramesh ki 500 udaar', name: 'Ramesh', amount: 500, type: 'credit' },
  { in: 'Ramesh ki 500 uddar', name: 'Ramesh', amount: 500, type: 'credit' },
  { in: 'Ramesh ki 500 uddaar', name: 'Ramesh', amount: 500, type: 'credit' },
  // bug fix: "వందల" (plural stem) used to give amount 5, name "రమేష్ వందల"
  { in: 'రమేష్ కి ఐదు వందల రూపాయలు అప్పు', name: 'రమేష్', amount: 500, type: 'credit' },
  // bug fix: fused "ఐదువందలు" used to give amount null
  { in: 'రమేష్ కి ఐదువందలు ఉద్దెర', name: 'రమేష్', amount: 500, type: 'credit' },
  { in: 'రమేష్ కి రెండువేలు జమ', name: 'రమేష్', amount: 2000, type: 'pay' },
  // composed amounts: thousands part + hundreds part, and +tens directly after
  { in: 'రెండు వేల ఐదు వందలు జమ', name: '', amount: 2500, type: 'pay' },
  { in: 'రమేష్ కి ఐదు వందల యాభై ఉద్దార్', name: 'రమేష్', amount: 550, type: 'credit' },
  // bug fix: filler verbs ("raayi") used to leak into the name
  { in: 'Ramesh ki 500 rupayalu appu raayi', name: 'Ramesh', amount: 500, type: 'credit' },
  { in: 'రమేష్‌కి 500 రూపాయలు అప్పు రాయి', name: 'రమేష్', amount: 500, type: 'credit' },
  // pay verbs: strong + weak incl. new spellings
  { in: 'రవి 300 రూపాయలు ఇచ్చాడు', name: 'రవి', amount: 300, type: 'pay' },
  { in: 'రవి 300 ఇచ్చెను', name: 'రవి', amount: 300, type: 'pay' },
  { in: 'లక్ష్మి 200 చెల్లించారు', name: 'లక్ష్మి', amount: 200, type: 'pay' },
  { in: 'Ramesh ki 500 baaki', name: 'Ramesh', amount: 500, type: 'credit' },
];

let pass = 0, fail = 0;
for (const c of cases) {
  const r = parse(c.in);
  const ok = r.name === c.name && r.amount === c.amount && r.type === c.type;
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + JSON.stringify(c.in));
  console.log('      got=' + JSON.stringify({ name: r.name, amount: r.amount, type: r.type }) +
    (ok ? '' : '\n      exp=' + JSON.stringify({ name: c.name, amount: c.amount, type: c.type })));
  ok ? pass++ : fail++;
}

// diagnose(raw) -> { type, amount, name, missing: [...] } built on parse()
const dCases = [
  {
    in: 'రమేష్ కి 500 ఉద్దార్', exp: { type: 'credit', amount: 500, name: 'రమేష్', missing: [] },
  },
  {
    // amount + name, type missing -> UI should offer credit/payment buttons
    in: 'రమేష్ కి 500', exp: { type: null, amount: 500, name: 'రమేష్', missing: ['type'] },
  },
  {
    // type + amount, name missing -> UI should show the customer picker
    in: 'జమ 300', exp: { type: 'pay', amount: 300, name: '', missing: ['name'] },
  },
  {
    // type + name, amount missing (word numbers unknown) -> UI should ask the amount
    in: 'రమేష్ కి జమ', exp: { type: 'pay', amount: null, name: 'రమేష్', missing: ['amount'] },
  },
  {
    in: 'రెండు వేల ఐదు వందలు జమ', exp: { type: 'pay', amount: 2500, name: '', missing: ['name'] },
  },
  {
    // nothing recognised -> guided examples, never a guess (two+ missing fields)
    in: 'మళ్లీ చెప్పండి', exp: { type: null, amount: null, name: 'మళ్లీ చెప్పండి', missing: ['type', 'amount'] },
  },
];
for (const c of dCases) {
  const r = diagnose(c.in);
  const ok = r.type === c.exp.type && r.amount === c.exp.amount && r.name === c.exp.name &&
    JSON.stringify(r.missing) === JSON.stringify(c.exp.missing);
  console.log((ok ? 'PASS' : 'FAIL') + '  diagnose ' + JSON.stringify(c.in));
  console.log('      got=' + JSON.stringify(r) +
    (ok ? '' : '\n      exp=' + JSON.stringify(c.exp)));
  ok ? pass++ : fail++;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
