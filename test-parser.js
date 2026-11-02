const parse = require('./public/parser.js');

const cases = [
  { in: 'Ramesh ki 500 udhaar', name: 'Ramesh', amount: 500, type: 'credit' },
  { in: 'రమేష్ కి ఐదు వందలు ఉదార్', name: 'రమేష్', amount: 500, type: 'credit' },
  { in: 'रमेश की पाँच सौ उधार', name: 'रमेश', amount: 500, type: 'credit' },
  { in: 'లక్ష్మి 200 జమ', name: 'లక్ష్మి', amount: 200, type: 'pay' },
  { in: 'Ramesh ki entha baaki', name: 'Ramesh', amount: null, type: 'query' },
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
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
