// test-security.js — hermetic security tests for the Khata Vani hardening pass.
// - The Gnani provider is MOCKED (no real credits are spent)
// - No Supabase reads/writes: sessions are minted locally as signed JWTs
// Run: node test-security.js   (also part of `npm test`)
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const jwt = require('jsonwebtoken');

// keep the REAL word-audio cache pristine: the challenge flow synthesizes words
// into TTS_CACHE_DIR, so point it at a throwaway temp dir (removed on exit)
process.env.TTS_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kv-tts-test-cache-'));
process.on('exit', () => {
  try { fs.rmSync(process.env.TTS_CACHE_DIR, { recursive: true, force: true }); } catch (_) {}
});

// ---- mock the Gnani provider BEFORE the server module loads ----
const realFetch = global.fetch;
const gnani = { mode: 'ok', hits: 0 };
const WAV = Buffer.from('RIFF0000WAVEfmt-mock-audio-for-security-tests');
const STT_JSON = JSON.stringify({
  success: true, transcript: 'రమేష్ 500 ఉద్దెర', detected_language_code: 'te-IN', request_id: 'req-mock',
});
const UPSTREAM_SECRET = 'UPSTREAM-SECRET-DETAIL-xyz-never-leak';
global.fetch = async (url, opts) => {
  const u = String(url);
  if (u.indexOf('https://api.vachana.ai') !== 0) return realFetch(url, opts);
  gnani.hits++;
  const isStt = u.indexOf('/stt/v3') !== -1;
  switch (gnani.mode) {
    case 'timeout': {
      const e = new Error('The operation was aborted due to timeout');
      e.name = 'TimeoutError';
      throw e;
    }
    case 'network': {
      const e = new Error('connect ECONNREFUSED 127.0.0.1:443');
      e.name = 'TypeError';
      throw e;
    }
    case 'upstream':
      return new Response('{"error":"' + UPSTREAM_SECRET + '"}',
        { status: 500, headers: { 'content-type': 'application/json' } });
    default:
      return isStt
        ? new Response(STT_JSON, { status: 200, headers: { 'content-type': 'application/json' } })
        : new Response(WAV, { status: 200, headers: { 'content-type': 'audio/wav' } });
  }
};

const { app } = require('./server.js');
const { validateJwtSecret, CSP } = require('./security.js');

let pass = 0, fail = 0;
function check(what, cond, detail) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + what);
  if (!cond) { console.log('      ' + String(detail == null ? '' : detail).slice(0, 300)); fail++; } else pass++;
}

function sessionCookie(shopId, phone) {
  const p = phone || '9000000001';
  const token = jwt.sign({ shopId, phone: p }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const sig = crypto.createHmac('sha256', process.env.JWT_SECRET).update(token)
    .digest('base64').replace(/=+$/, '');
  return 'session=s:' + token + '.' + sig;
}

async function call(method, p, o) {
  const opts = o || {};
  const headers = Object.assign({}, opts.headers || {});
  if (opts.shop) headers.Cookie = sessionCookie(opts.shop);
  let body;
  if (opts.body !== undefined) {
    if (Buffer.isBuffer(opts.body)) {
      body = opts.body;
      if (!headers['Content-Type']) headers['Content-Type'] = 'audio/wav';
    } else if (typeof opts.body === 'string') {
      body = opts.body;
      if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
    } else {
      body = JSON.stringify(opts.body);
      if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
    }
  }
  const r = await realFetch('http://127.0.0.1:' + PORT + p, { method, headers, body });
  const buf = Buffer.from(await r.arrayBuffer());
  let json = null;
  try { json = JSON.parse(buf.toString('utf8')); } catch (_) {}
  return { status: r.status, headers: r.headers, buf, json, text: buf.toString('utf8') };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}
function runServer(env) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['server.js'], {
      env: Object.assign({}, process.env, env), cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', settled = false;
    const finish = extra => { if (!settled) { settled = true; clearTimeout(timer); resolve(Object.assign({ child, out }, extra)); } };
    const timer = setTimeout(() => { child.kill(); finish({ code: null, timedOut: true }); }, 10000);
    child.stdout.on('data', d => {
      out += d;
      if (out.indexOf('Khata Vani on') !== -1) finish({ code: null, started: true });
    });
    child.stderr.on('data', d => { out += d; });
    child.on('exit', code => finish({ code }));
  });
}

let PORT = 0;
(async () => {
  const srv = app.listen(0, '127.0.0.1');
  await new Promise(r => srv.once('listening', r));
  PORT = srv.address().port;
  const BASE = 'http://127.0.0.1:' + PORT;
  const AUDIO = Buffer.alloc(1200, 7);
  const tts = (text, o) => call('POST', '/api/tts', Object.assign({ body: { text } }, o || {}));
  const stt = (o) => call('POST', '/api/stt', o || {});

  // ================= 11. security headers =================
  let r = await call('GET', '/');
  const csp = r.headers.get('content-security-policy') || '';
  check('GET / -> 200', r.status === 200, r.status);
  check('CSP present', csp.length > 0, csp);
  check("CSP default-src 'self'", csp.indexOf("default-src 'self'") !== -1, csp);
  check("CSP script-src 'self' without unsafe-inline",
    csp.indexOf("script-src 'self'") !== -1 && csp.indexOf('unsafe-inline') === -1, csp);
  check('CSP allows Google Fonts styles', csp.indexOf('fonts.googleapis.com') !== -1, csp);
  check('CSP allows gstatic fonts', csp.indexOf('fonts.gstatic.com') !== -1, csp);
  check('CSP frame-ancestors none', csp.indexOf("frame-ancestors 'none'") !== -1, csp);
  check('CSP media-src blob (TTS playback)', csp.indexOf('blob:') !== -1, csp);
  check('X-Content-Type-Options nosniff', r.headers.get('x-content-type-options') === 'nosniff', r.headers.get('x-content-type-options'));
  check('X-Frame-Options DENY', r.headers.get('x-frame-options') === 'DENY', r.headers.get('x-frame-options'));
  check('Referrer-Policy set', !!r.headers.get('referrer-policy'), r.headers.get('referrer-policy'));
  check('Permissions-Policy microphone=(self)',
    String(r.headers.get('permissions-policy')).indexOf('microphone=(self)') !== -1, r.headers.get('permissions-policy'));
  check('Cross-Origin-Opener-Policy set', !!r.headers.get('cross-origin-opener-policy'), r.headers.get('cross-origin-opener-policy'));
  check('HSTS NOT sent in development', !r.headers.get('strict-transport-security'), r.headers.get('strict-transport-security'));
  check('X-Request-Id present', !!r.headers.get('x-request-id'), r.headers.get('x-request-id'));
  check('X-Powered-By removed', !r.headers.get('x-powered-by'), r.headers.get('x-powered-by'));
  check('CSP export matches applied header', CSP === csp, 'exported CSP differs');

  r = await call('GET', '/api/customers'); // 401, but headers must be there too
  check('API 401 still carries security headers',
    r.status === 401 && !!r.headers.get('content-security-policy') && !!r.headers.get('x-request-id'),
    r.status + ' ' + r.headers.get('content-security-policy'));

  // ================= A. TTS protection =================
  r = await tts('నమస్కారం');
  check('TTS unauthenticated -> 401', r.status === 401, r.status + ' ' + r.text);
  check('401 body is Telugu JSON', !!r.json && typeof r.json.error === 'string', r.text);

  const hitsBefore = gnani.hits;
  r = await tts('రమేష్ గారూ, మీ బాకీ ఉంది', { shop: 'sec-shop' });
  check('TTS authenticated -> 200 audio/wav', r.status === 200, r.status + ' ' + r.text.slice(0, 120));
  check('TTS returns the provider bytes', r.buf.equals(WAV), r.buf.length);
  check('TTS reached the (mocked) Gnani provider', gnani.hits > hitsBefore, gnani.hits + ' vs ' + hitsBefore);

  r = await tts('hello world', { shop: 'sec-shop', headers: { Origin: BASE } });
  check('same-origin TTS mutation -> 200', r.status === 200, r.status + ' ' + r.text.slice(0, 120));

  r = await tts('', { shop: 'sec-shop' });
  check('TTS empty text -> 400', r.status === 400, r.status + ' ' + r.text);
  r = await tts('   ', { shop: 'sec-shop' });
  check('TTS whitespace text -> 400', r.status === 400, r.status);
  r = await call('POST', '/api/tts', { body: { text: 123 }, shop: 'sec-shop' });
  check('TTS numeric text -> 400', r.status === 400, r.status);
  r = await call('POST', '/api/tts', { body: { text: null }, shop: 'sec-shop' });
  check('TTS null text -> 400', r.status === 400, r.status);
  r = await call('POST', '/api/tts', { body: { text: ['అ'] }, shop: 'sec-shop' });
  check('TTS array text -> 400', r.status === 400, r.status);
  r = await call('POST', '/api/tts', { body: {}, shop: 'sec-shop' });
  check('TTS missing text -> 400', r.status === 400, r.status);
  r = await tts('అ'.repeat(1001), { shop: 'sec-shop' });
  check('TTS 1001 chars -> 400', r.status === 400, r.status);
  r = await tts('అ'.repeat(1000), { shop: 'sec-shop' });
  check('TTS exactly 1000 chars -> 200', r.status === 200, r.status);
  r = await call('POST', '/api/tts', { body: 'not json at all', shop: 'sec-shop' });
  check('TTS bad JSON -> 400 JSON (not HTML)', r.status === 400 && !!r.json, r.status + ' ' + r.text.slice(0, 120));
  r = await call('POST', '/api/tts', {
    body: JSON.stringify({ text: 'x'.repeat(9000) }), shop: 'sec-shop',
    headers: { 'Content-Type': 'application/json' },
  });
  check('TTS body > 8kb -> 413', r.status === 413, r.status);
  r = await call('POST', '/api/tts', {
    body: JSON.stringify({ text: 'x', pad: 'y'.repeat(70000) }), shop: 'sec-shop',
    headers: { 'Content-Type': 'application/json' },
  });
  check('TTS body > 64kb json limit -> 413 JSON', r.status === 413 && !!r.json, r.status + ' ' + r.text.slice(0, 120));
  r = await call('POST', '/api/tts', { body: { text: 'hi' }, shop: 'sec-shop', headers: { 'Content-Type': 'text/plain' } });
  check('TTS wrong content-type -> 415', r.status === 415, r.status);

  // ================= 6. TTS rate limit per shop =================
  let code = 0, first429 = -1;
  for (let i = 1; i <= 61; i++) {
    const x = await tts('పరీక్ష ' + i, { shop: 'rl-tts-shop' });
    code = x.status;
    if (code === 429 && first429 < 0) first429 = i;
  }
  check('TTS #61 from same shop -> 429', code === 429, 'last=' + code + ' first429=' + first429);
  check('TTS 429 starts after 60 requests', first429 === 61, 'first429=' + first429);
  r = await tts('ఇంకొకటి', { shop: 'rl-other-shop' });
  check('another shop is NOT limited (per-shop bucket)', r.status === 200, r.status);
  const hitsAtLimit = gnani.hits;
  r = await tts('after limit', { shop: 'rl-tts-shop' });
  check('limited TTS never reaches Gnani', gnani.hits === hitsAtLimit, gnani.hits + ' vs ' + hitsAtLimit);

  // ================= 7+8. STT: validation + rate limit =================
  r = await stt({ body: AUDIO });
  check('STT unauthenticated -> 401', r.status === 401, r.status);
  r = await stt({ body: AUDIO, shop: 'sec-shop' });
  check('STT valid audio -> 200 transcript', r.status === 200 && r.json && typeof r.json.transcript === 'string',
    r.status + ' ' + r.text.slice(0, 120));
  check('STT forwards no raw provider payload', r.text.indexOf('req-mock') === -1, r.text.slice(0, 160));
  r = await stt({ body: Buffer.alloc(100, 7), shop: 'sec-shop' });
  check('STT tiny audio -> 400', r.status === 400, r.status);
  r = await stt({ body: AUDIO, shop: 'sec-shop', headers: { 'Content-Type': 'application/json' } });
  check('STT wrong content-type -> 415', r.status === 415, r.status);

  code = 0; first429 = -1;
  for (let i = 1; i <= 61; i++) {
    const x = await stt({ body: AUDIO, shop: 'rl-stt-shop' });
    code = x.status;
    if (code === 429 && first429 < 0) first429 = i;
  }
  check('STT #61 from same shop -> 429', code === 429, 'last=' + code + ' first429=' + first429);
  r = await tts('స్టిల్ వర్క్స్', { shop: 'rl-stt-shop' });
  check('TTS bucket independent from STT bucket', r.status === 200, r.status);

  // ================= 9+10. upstream failures are safe =================
  gnani.mode = 'timeout';
  r = await tts('టైమ్ అవుట్', { shop: 'sec-shop' });
  check('Gnani TTS timeout -> 504', r.status === 504, r.status + ' ' + r.text.slice(0, 120));
  check('timeout body is Telugu, no raw error', !!r.json && r.text.indexOf('TimeoutError') === -1, r.text.slice(0, 160));
  r = await stt({ body: AUDIO, shop: 'sec-shop' });
  check('Gnani STT timeout -> 504', r.status === 504, r.status);
  gnani.mode = 'network';
  r = await tts('నెట్వర్క్', { shop: 'sec-shop' });
  check('Gnani network failure -> 502', r.status === 502, r.status);
  check('network failure leaks no details', r.text.indexOf('ECONNREFUSED') === -1, r.text.slice(0, 160));
  gnani.mode = 'upstream';
  r = await tts('ప్రొవైడర్ ఎరర్', { shop: 'sec-shop' });
  check('Gnani 500 -> 502 mapped', r.status === 502, r.status);
  check('provider error body NOT forwarded', r.text.indexOf(UPSTREAM_SECRET) === -1, r.text.slice(0, 160));
  r = await stt({ body: AUDIO, shop: 'sec-shop' });
  check('STT provider 500 -> 502 mapped, body not forwarded',
    r.status === 502 && r.text.indexOf(UPSTREAM_SECRET) === -1, r.status + ' ' + r.text.slice(0, 160));
  gnani.mode = 'ok';
  r = await tts('బ్యాక్ టు నార్మల్', { shop: 'sec-shop' });
  check('provider recovered -> 200', r.status === 200, r.status);

  // ================= 12+13. same-origin / CSRF =================
  r = await tts('cross site', { shop: 'sec-shop', headers: { Origin: 'https://evil.example' } });
  check('evil Origin mutation -> 403', r.status === 403, r.status + ' ' + r.text.slice(0, 120));
  check('403 body is Telugu JSON', !!r.json && typeof r.json.error === 'string', r.text.slice(0, 160));
  r = await tts('null origin', { shop: 'sec-shop', headers: { Origin: 'null' } });
  check("Origin 'null' -> 403", r.status === 403, r.status);
  r = await stt({ body: AUDIO, shop: 'sec-shop', headers: { 'Sec-Fetch-Site': 'cross-site' } });
  check('no-Origin + Sec-Fetch-Site cross-site -> 403', r.status === 403, r.status);
  r = await call('PUT', '/api/me', {
    body: { owner_name: 'x', shop_name: 'y', address: 'z' }, shop: 'sec-shop',
    headers: { Origin: 'https://evil.example' },
  });
  check('cross-origin PUT rejected before any DB work', r.status === 403, r.status);
  r = await call('GET', '/api/no-such-route', { shop: 'sec-shop', headers: { Origin: 'https://evil.example' } });
  check('GETs are exempt from the Origin check', r.status !== 403, r.status);

  // legit auth flow still works (in-memory challenge, mocked TTS, no DB).
  // Options are shuffled and a wrong choice BURNS the challenge, so retry fresh
  // challenges until the correct option is picked (expected ~3 attempts; a
  // unique phone per attempt keeps the per-phone answer limiter out of the way,
  // and the cap stays under the 30/15min per-IP challenge limit)
  let voiceOkToken = null, okChallengeId = null, lastChallengeId = null;
  let attempts = 0, firstIssue = null;
  for (let i = 1; i <= 20 && !voiceOkToken; i++) {
    const phone = '9' + String(i).padStart(9, '0'); // 9xxxxxxxxx = valid format
    r = await call('GET', '/api/auth/challenge?phone=' + phone);
    attempts++;
    if (!firstIssue) firstIssue = r;
    if (r.status !== 200 || !r.json || !r.json.challengeId) break;
    lastChallengeId = r.json.challengeId;
    const a = await call('POST', '/api/auth/challenge/answer', {
      body: { challengeId: r.json.challengeId, phone, choice: r.json.options[0] },
      headers: { Origin: BASE },
    });
    if (a.status === 200 && a.json && a.json.voiceOkToken) {
      voiceOkToken = a.json.voiceOkToken;
      okChallengeId = r.json.challengeId;
    }
  }
  check('challenge issues (mocked TTS)',
    !!firstIssue && firstIssue.status === 200 && !!(firstIssue.json && firstIssue.json.challengeId),
    (firstIssue && firstIssue.status) + ' ' + (firstIssue && firstIssue.text.slice(0, 120)));
  check('same-origin challenge answer -> voiceOkToken', !!voiceOkToken, 'attempts=' + attempts);
  r = await call('GET', '/api/auth/challenge?phone=9876543210');
  const ch2 = r.json;
  r = await call('POST', '/api/auth/challenge/answer', {
    body: { challengeId: ch2.challengeId, phone: '9876543210', choice: ch2.options[0] },
    headers: { Origin: 'https://evil.example' },
  });
  check('cross-origin challenge answer -> 403', r.status === 403, r.status);
  r = await call('GET', '/api/auth/challenge/audio/' + (okChallengeId || lastChallengeId));
  check('challenge audio still served', r.status === 200 && String(r.headers.get('content-type')).indexOf('audio') === 0,
    r.status + ' ' + r.headers.get('content-type'));
  r = await call('POST', '/api/auth/logout', { headers: { Origin: BASE } });
  check('same-origin logout -> 200 + HttpOnly cookie cleared',
    r.status === 200 && String(r.headers.get('set-cookie') || '').indexOf('HttpOnly') !== -1,
    r.status + ' ' + r.headers.get('set-cookie'));

  // misc: JSON 404 + no HTML stack traces
  r = await call('GET', '/api/no-such-route', { shop: 'sec-shop' });
  check('unknown /api route -> JSON 404', r.status === 404 && !!r.json, r.status + ' ' + r.text.slice(0, 120));

  // ================= 14+15. production JWT secret validation =================
  const strong = crypto.randomBytes(48).toString('hex');
  const weak = 'change_me_to_a_long_random_string';
  check('unit: placeholder secret fatal in production',
    validateJwtSecret(weak, { production: true }).level === 'fatal',
    JSON.stringify(validateJwtSecret(weak, { production: true })));
  check('unit: short secret fatal in production',
    validateJwtSecret('short', { production: true }).level === 'fatal', '');
  check('unit: repeated-char secret fatal in production',
    validateJwtSecret('a'.repeat(64), { production: true }).level === 'fatal', '');
  check('unit: strong secret accepted in production',
    validateJwtSecret(strong, { production: true }).level === 'ok', '');
  check('unit: placeholder secret only warns in development',
    validateJwtSecret(weak, { production: false }).level === 'warn', '');
  check('unit: missing secret fatal everywhere',
    validateJwtSecret('', { production: true }).level === 'fatal' &&
    validateJwtSecret(undefined, { production: false }).level === 'fatal', '');
  const leakCheck = validateJwtSecret('my_unique_dev_secret_value_1234567890', { production: true });
  check('unit: validation messages never contain the secret',
    (leakCheck.message || '').indexOf('my_unique_dev_secret_value') === -1, leakCheck.message);

  const weakPort = await freePort();
  const weakRun = await runServer({ NODE_ENV: 'production', JWT_SECRET: weak, PORT: String(weakPort) });
  check('weak production secret -> startup fails (14)',
    weakRun.code === 1 && weakRun.out.indexOf('FATAL') !== -1,
    'code=' + weakRun.code + ' out=' + weakRun.out.slice(0, 200));
  check('startup failure never prints the secret',
    weakRun.out.indexOf(weak) === -1, weakRun.out.slice(0, 300));

  const strongPort = await freePort();
  const strongRun = await runServer({ NODE_ENV: 'production', JWT_SECRET: strong, PORT: String(strongPort) });
  check('valid production config starts (15)', !!strongRun.started, 'code=' + strongRun.code + ' out=' + strongRun.out.slice(0, 200));
  if (strongRun.started) {
    const pr = await realFetch('http://127.0.0.1:' + strongPort + '/');
    check('production sends HSTS', !!pr.headers.get('strict-transport-security'), pr.headers.get('strict-transport-security'));
    check('production still sends CSP', !!pr.headers.get('content-security-policy'), pr.headers.get('content-security-policy'));
    check('production startup log has no secrets',
      strongRun.out.indexOf(strong) === -1 && strongRun.out.indexOf(process.env.SUPABASE_SERVICE_KEY || '§') === -1,
      strongRun.out.slice(0, 300));
    strongRun.child.kill();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  srv.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('SECURITY HARNESS ERROR', e); process.exit(2); });
