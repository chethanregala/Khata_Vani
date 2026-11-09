// tests/test-business-type.js — kirana/rythu separation rules + route guards.
// Pure rules run with zero infrastructure; route guards run the REAL app
// (requireAuth, express-rate-limit, restraint order) against a MOCK PostgREST
// Supabase so no network and no real data are touched.
// Run: node tests/test-business-type.js   (also part of `npm test`)
'use strict';
const crypto = require('crypto');
const http = require('http');
const net = require('net');
const jwt = require('jsonwebtoken');

let pass = 0, fail = 0;
function check(what, cond, detail) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + what);
  if (!cond) { console.log('      ' + String(detail == null ? '' : detail).slice(0, 300)); fail++; } else pass++;
}
const TEST_SECRET = 'bt-test-secret-' + 'z'.repeat(40);

// ---------- 1. pure rules (lib/business-type.js) ----------
const bt = require('../lib/business-type');
{ // backfill decision as a pure function
  check('decide: only rythu rows -> rythu', bt.decide({ rythuRows: 3 }) === 'rythu');
  check('decide: only farmer customers -> rythu', bt.decide({ farmerCustomers: 2 }) === 'rythu');
  check('decide: only kirana rows -> kirana', bt.decide({ kiranaRows: 5 }) === 'kirana');
  check('decide: only other-kind customers -> kirana', bt.decide({ otherCustomers: 1 }) === 'kirana');
  check('decide: both kinds of data -> null', bt.decide({ rythuRows: 1, kiranaRows: 1 }) === null);
  check('decide: farmer + kirana rows -> null', bt.decide({ farmerCustomers: 1, kiranaRows: 4 }) === null);
  check('decide: no data at all -> null', bt.decide({}) === null);
  check('decide: booleans work like counts', bt.decide({ hasRythu: true, hasKirana: true }) === null);
}
{ // change rules
  check('changeRule: null type with entries allowed (backfill legacy)', bt.changeRule(null, 5) === null);
  check('changeRule: zero transactions allowed', bt.changeRule('kirana', 0) === null);
  check('changeRule: zero transactions (null count) allowed', bt.changeRule('rythu', null) === null);
  check('changeRule: set type with entries -> locked', bt.changeRule('kirana', 3) === 'BUSINESS_TYPE_LOCKED');
  check('isValid: only kirana/rythu', bt.isValid('kirana') && bt.isValid('rythu') && !bt.isValid('dairy') && !bt.isValid(null));
  check('workflowOf: rythu type -> rythu workflow', bt.workflowOf('rythu') === 'rythu');
  check('workflowOf: kirana and null -> kirana workflow', bt.workflowOf('kirana') === 'kirana' && bt.workflowOf(null) === 'kirana');
  check('kindOf: rythu -> farmer, kirana -> customer', bt.kindOf('rythu') === 'farmer' && bt.kindOf('kirana') === 'customer');
}

// ---------- 2. route guards against a mock PostgREST ----------
const redactKeepaliveToken = require('../security.js').redactKeepaliveToken;
check('redactKeepaliveToken redacts k=<token>', redactKeepaliveToken('GET /keepalive?k=sekrit&x=1') === 'GET /keepalive?k=<redacted>&x=1');
check('redactKeepaliveToken leaves other params', redactKeepaliveToken('/x?s=1') === '/x?s=1');

// mock Supabase (PostgREST-shaped). The app's supabase-js client talks to it.
const DB = {
  shop: { id: '11111111-1111-1111-1111-111111111111', business_type: null, owner_name: 't', shop_name: 't', address: 't' },
  customers: [],
  txCount: 0,
};
const pg = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    const accept = String(req.headers.accept || '');
    const single = accept.indexOf('vnd.pgrst.object') !== -1;
    const shape = obj => res.end(JSON.stringify(single ? obj : [obj]));
    const u = new URL(req.url, 'http://mock');
    const p = u.pathname;            // e.g. /rest/v1/shops?select=...
    const tbl = p.split('/').pop();  // 'shops' | 'customers' | ...
    res.setHeader('content-type', 'application/json');
    if (p.includes('/rpc/')) return shape([]);
    if (req.method === 'GET' && tbl === 'shops') return shape(DB.shop);
    if (req.method === 'HEAD' && tbl === 'transactions') {
      res.setHeader('content-range', '*/' + DB.txCount);
      return res.end();
    }
    if (req.method === 'PATCH' && tbl === 'shops') {
      try { Object.assign(DB.shop, JSON.parse(body || '{}')); } catch (_) {}
      return shape(DB.shop);
    }
    if (req.method === 'GET' && (tbl === 'customers' || tbl === 'transactions')) {
      return res.end(JSON.stringify(DB.customers));
    }
    if (req.method === 'POST' && tbl === 'customers') {
      let row = {};
      try { row = JSON.parse(body || '{}'); } catch (_) {}
      row.id = row.id || crypto.randomUUID();
      row.created_at = row.created_at || new Date().toISOString();
      DB.customers.push(row);
      return shape(row);
    }
    return shape([]);
  });
});

const SHOP_ID = DB.shop.id;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = TEST_SECRET;
process.env.TTS_CACHE_DIR = require('os').tmpdir() + '/kv-bt-tts-cache'; // keep the real cache pristine
process.env.APP_ORIGIN = '';

let PORT_SB, PORT_APP;
const sessionCookie = phone => {
  const token = jwt.sign({ shopId: SHOP_ID, phone: phone || '9000000000' }, TEST_SECRET, { expiresIn: '1h' });
  const sig = crypto.createHmac('sha256', TEST_SECRET).update(token).digest('base64').replace(/=+$/, '');
  return 'session=s:' + token + '.' + sig;
};

async function call(method, p, body, cookie) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch('http://127.0.0.1:' + PORT_APP + p, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await r.json(); } catch (_) {}
  return { status: r.status, json };
}

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  s.on('error', reject);
});

(async () => {
  PORT_SB = await freePort(); PORT_APP = await freePort();
  process.env.SUPABASE_URL = 'http://127.0.0.1:' + PORT_SB;
  process.env.SUPABASE_SERVICE_KEY = 'mock-key-never-logged';
  await new Promise(r => pg.listen(PORT_SB, '127.0.0.1', r));
  // app loads AFTER the env points at the mock (dotenv never overrides)
  const { app } = require('../server.js');
  await new Promise(r => app.listen(PORT_APP, '127.0.0.1', r));

  // ---- keepalive token behaviour (fresh server per token snapshot) ----
  // ---- untyped shop: every ledger route is blocked until the choice ----
  DB.shop.business_type = null;
  let r = await call('GET', '/api/customers', undefined, sessionCookie());
  check('untyped: /api/customers -> 403 BUSINESS_TYPE_REQUIRED',
    r.status === 403 && r.json && r.json.code === 'BUSINESS_TYPE_REQUIRED', JSON.stringify(r.json));
  r = await call('GET', '/api/rythu/farmers', undefined, sessionCookie());
  check('untyped: /api/rythu/farmers -> 403 REQUIRED (not MISMATCH)',
    r.status === 403 && r.json && r.json.code === 'BUSINESS_TYPE_REQUIRED');
  r = await call('GET', '/api/me', undefined, sessionCookie());
  check('untyped: /api/me still works and returns business_type',
    r.status === 200 && r.json && 'business_type' in r.json.shop);

  // ---- business-type choice endpoint ----
  r = await call('PUT', '/api/me/business-type', { business_type: 'dairy' }, sessionCookie());
  check('business-type: invalid value -> 400 BAD_BUSINESS_TYPE',
    r.status === 400 && r.json && r.json.code === 'BAD_BUSINESS_TYPE');
  DB.txCount = 0;
  r = await call('PUT', '/api/me/business-type', { business_type: 'kirana' }, sessionCookie());
  check('business-type: zero transactions -> choice succeeds',
    r.status === 200 && r.json && r.json.shop && r.json.shop.business_type === 'kirana');
  DB.txCount = 9; // all evidence rows arrived after entries
  r = await call('PUT', '/api/me/business-type', { business_type: 'rythu' }, sessionCookie());
  check('business-type: set type + entries -> 409 LOCKED',
    r.status === 409 && r.json && r.json.code === 'BUSINESS_TYPE_LOCKED', JSON.stringify(r.json));

  // ---- kirana shop guards ----
  r = await call('POST', '/api/customers', { name: 'x', kind: 'farmer' }, sessionCookie());
  check('kirana shop: kind=farmer -> 403 MISMATCH',
    r.status === 403 && r.json && r.json.code === 'BUSINESS_TYPE_MISMATCH');
  r = await call('GET', '/api/rythu/farmers', undefined, sessionCookie());
  check('kirana shop: /api/rythu/farmers -> 403 MISMATCH',
    r.status === 403 && r.json && r.json.code === 'BUSINESS_TYPE_MISMATCH');
  r = await call('GET', '/api/rythu/summary', undefined, sessionCookie());
  check('kirana shop: /api/rythu/summary -> 403 MISMATCH', r.status === 403);
  r = await call('POST', '/api/transactions',
    { workflow: 'rythu', type: 'credit', event: 'produce_delivery', customer_id: crypto.randomUUID(),
      produce: 'paddy', quantity: '1', unit: 'quintal', rate: '100', rate_unit: 'quintal' },
    sessionCookie());
  check('kirana shop: rythu row -> 403 MISMATCH (before the ledger runs)',
    r.status === 403 && r.json && r.json.code === 'BUSINESS_TYPE_MISMATCH');
  r = await call('POST', '/api/voice/propose', { transcript: 'nothing to see', workflow: 'rythu' }, sessionCookie());
  check('kirana shop: propose derives kirana, ignores client rythu',
    r.status === 200 && r.json && !('workflow' in r.json) &&
    (r.json.missingFields || []).includes('TRANSCRIPT'), JSON.stringify(r.json));
  r = await call('POST', '/api/customers', { name: 'x' }, sessionCookie());
  check('kirana shop: creating without kind defaults to kind=customer',
    r.status === 201 && r.json && r.json.kind === 'customer', JSON.stringify(r.json));

  // ---- rythu shop guards (switch the mock shop) ----
  DB.shop.business_type = 'rythu';
  r = await call('GET', '/api/rythu/farmers', undefined, sessionCookie());
  check('rythu shop: /api/rythu/farmers -> 200', r.status === 200);
  r = await call('POST', '/api/customers', { name: 'x', kind: 'customer' }, sessionCookie());
  check('rythu shop: kind=customer -> 403 MISMATCH',
    r.status === 403 && r.json && r.json.code === 'BUSINESS_TYPE_MISMATCH');
  r = await call('POST', '/api/customers', { name: 'x' }, sessionCookie());
  check('rythu shop: creating without kind defaults to kind=farmer',
    r.status === 201 && r.json && r.json.kind === 'farmer', JSON.stringify(r.json));
  r = await call('POST', '/api/transactions',
    { workflow: 'kirana', type: 'credit', event: 'goods_credit', amount: 10,
      customer_id: crypto.randomUUID() },
    sessionCookie());
  check('rythu shop: kirana row -> 403 MISMATCH',
    r.status === 403 && r.json && r.json.code === 'BUSINESS_TYPE_MISMATCH');
  r = await call('POST', '/api/voice/propose', { transcript: 'nothing to see', workflow: 'kirana' }, sessionCookie());
  check('rythu shop: propose derives rythu, ignores client kirana',
    r.status === 200 && r.json && r.json.workflow === 'rythu', JSON.stringify(r.json));

  // ---- keepalive (fresh sub-listener per token config: the route snapshot is
  // taken at module load, so each token shape gets a fresh server) ----
  const keepalive = async token => {
    process.env.KEEPALIVE_TOKEN = token;
    for (const k of Object.keys(require.cache)) { delete require.cache[k]; }
    const { app: a2 } = require('../server.js');
    const p2 = await freePort();
    const h2 = a2.listen(p2, '127.0.0.1');
    await new Promise(res => h2.once('listening', res));
    const go = async q => {
      const rr = await fetch('http://127.0.0.1:' + p2 + q);
      let jj = null; try { jj = await rr.json(); } catch (_) {}
      return { status: rr.status, json: jj };
    };
    const out = { go, h2 };
    return out;
  };
  {
    const ctx = await keepalive('ka-correct-token');
    const missing = await ctx.go('/keepalive');
    const wrong = await ctx.go('/keepalive?k=nope');
    const right = await ctx.go('/keepalive?k=ka-correct-token');
    check('keepalive: missing token -> generic 404', missing.status === 404 &&
      missing.json && missing.json.error && !('ok' in missing.json), JSON.stringify(missing.json));
    check('keepalive: wrong token -> generic 404', wrong.status === 404);
    check('keepalive: right token -> {ok:true}', right.status === 200 &&
      right.json && right.json.ok === true, JSON.stringify(right.json));
    // 30/min per IP: burn the rest of the bucket with wrong tokens (they count)
    let last = null;
    for (let i = 0; i < 30; i++) last = await ctx.go('/keepalive?k=nope');
    check('keepalive: 31st request inside a minute -> 429', last.status === 429, String(last.status));
    await new Promise(res => ctx.h2.close(res));
  }

  console.log('\n[business-type] ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('test-business-type crashed: ' + ((e && (e.code || e.name)) || 'ERROR'));
  console.error(String(e && e.message || '').slice(0, 400));
  process.exit(1);
});
