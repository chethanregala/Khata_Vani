const resolve = require('./public/resolver.js');

// default fixture shop: two customers called Ramesh (the chooser case),
// an alias, a label pair, and a fuzzy near-miss.
const shop = [
  { id: 'r1', name: 'Ramesh', label: 'tailor', phone: '9848011111', aliases: [] },
  { id: 'r2', name: 'Ramesh', label: 'driver', phone: '9848022222', aliases: [] },
  { id: 'l1', name: 'Lakshmi', label: '', phone: '9848033333', aliases: ['Laxmi'] },
  { id: 'k1', name: 'Ramesh Kumar', label: 'kirana', phone: '9848044444', aliases: [] },
  { id: 's1', name: 'Srinivas', label: 'hotel', phone: '9848066666', aliases: [] },
];

const cases = [
  { what: 'two customers named Ramesh -> many', in: 'Ramesh', status: 'many', ids: ['r1', 'r2'] },
  { what: 'label narrowing "Ramesh tailor" -> one', in: 'Ramesh tailor', status: 'one', ids: ['r1'] },
  { what: 'label narrowing "ramesh driver" -> one', in: 'ramesh driver', status: 'one', ids: ['r2'] },
  { what: 'alias hit "Laxmi" -> one', in: 'Laxmi', status: 'one', ids: ['l1'] },
  { what: 'Telugu script vs Latin spelling -> none (so it asks)', in: 'రమేష్', status: 'none', ids: [] },
  { what: 'fuzzy "Srinivasa" -> fuzzy', in: 'Srinivasa', status: 'fuzzy', ids: ['s1'] },
  { what: 'fuzzy "Rameshu" -> fuzzy (both Rameshes)', in: 'Rameshu', status: 'fuzzy', ids: ['r1', 'r2'] },
  { what: 'exact unique "Lakshmi" -> one', in: 'Lakshmi', status: 'one', ids: ['l1'] },
  { what: 'label that matches nobody falls back to the base name', in: 'Lakshmi tailor', status: 'one', ids: ['l1'] },
  { what: 'completely unknown name -> none', in: 'Suresh Babu', status: 'none', ids: [] },
  { what: 'too short for fuzzy -> none', in: 'Ki', status: 'none', ids: [] },
  // Telugu suffix stripping: stored "రమేష్ గారు", spoken "రమేష్ గారికి"
  {
    what: 'Telugu suffixes గారికి/గారు stripped on both sides -> one',
    in: 'రమేష్ గారికి', status: 'one', ids: ['te'],
    customers: [{ id: 'te', name: 'రమేష్ గారు', label: '', phone: '', aliases: [] }],
  },
];

let pass = 0, fail = 0;
for (const c of cases) {
  const r = resolve(c.in, c.customers || shop);
  const ids = r.candidates.map(x => x.id);
  const ok = r.status === c.status && ids.join(',') === c.ids.join(',');
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + c.what);
  if (!ok) {
    console.log('      got=' + JSON.stringify({ status: r.status, ids }) +
      '  exp=' + JSON.stringify({ status: c.status, ids: c.ids }));
    fail++;
  } else pass++;
}

// empty / malformed input never throws
const edge = resolve('', shop);
const edgeOk = edge.status === 'none' && edge.candidates.length === 0;
console.log((edgeOk ? 'PASS' : 'FAIL') + '  empty utterance -> none');
edgeOk ? pass++ : fail++;

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
