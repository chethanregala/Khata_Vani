require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const QRCode = require('qrcode'); // SVG QR generation for acknowledgement links
const { requestId, securityHeaders, sameOrigin, contentLength, errorHandler, validateJwtSecret, redactAckToken } = require('./security.js');
const money = require('./lib/money');
const ledger = require('./lib/ledger');
const ack = require('./lib/ack');
const bt = require('./lib/business-type');
const parseVoice = require('./public/parser');     // rule-based parse() (+ parseVoice.diagnose)
const resolveName = require('./public/resolver');  // name matcher, shared with the browser
const parseRythu = require('./public/rythu-parser'); // rythu events (+ parseRythu.diagnose)

const app = express();
const B = 'https://api.vachana.ai', K = process.env.GNANI_API_KEY;
const E = process.env;
const PORT = E.PORT || 3000;
const PROD = E.NODE_ENV === 'production';
const JWT_SECRET = E.JWT_SECRET;
// APP_ORIGIN: the canonical public origin used to build customer-facing
// acknowledgement link URLs (comma list; the first entry wins, the rest are
// extra allowed Origins for the sameOrigin CSRF check)
const APP_ORIGIN = String(E.APP_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean)[0] || '';

// ---- config checks (never print secret values) ----
// weak/placeholder secrets are fatal only in production; dev just warns
const jwtCheck = validateJwtSecret(JWT_SECRET, { production: PROD });
if (jwtCheck.level === 'fatal') { console.error('FATAL: ' + jwtCheck.message); process.exit(1); }
if (jwtCheck.level === 'warn') console.warn('WARN: ' + jwtCheck.message);

// ---- required env vars: fail fast in production, warn in development ----
// Only the VARIABLE NAME is ever reported — never any value.
const ENV_PLACEHOLDER_RE = /^(change|placeholder|example|your[_-]|secret$|password$|xxx+|dummy|test[-_]?key)/i;
const REQ_ENV = [
  ['JWT_SECRET', JWT_SECRET],
  ['GNANI_API_KEY', K],
  ['SUPABASE_URL', E.SUPABASE_URL],
  ['SUPABASE_SERVICE_KEY', E.SUPABASE_SERVICE_KEY || E.SUPABASE_SECRET_KEY],
  ...(PROD ? [['APP_ORIGIN', APP_ORIGIN]] : []),
];
const missingEnv = REQ_ENV.filter(([, v]) => !v || !String(v).trim()).map(([n]) => n);
const placeholderEnv = REQ_ENV
  .filter(([n, v]) => v && n !== 'JWT_SECRET' && ENV_PLACEHOLDER_RE.test(String(v).trim()))
  .map(([n]) => n);
if (missingEnv.length || placeholderEnv.length) {
  const msg = 'FATAL: missing required env vars [' + missingEnv.join(', ') + ']' +
    (placeholderEnv.length ? ' / placeholder values in [' + placeholderEnv.join(', ') + ']' : '') +
    ' — set them in .env (values are never logged)';
  if (PROD) { console.error(msg); process.exit(1); }
  console.warn(msg.replace('FATAL:', 'WARN:'));
}

// optional: TRUST_PROXY=1 only when behind a trusted reverse proxy, so rate
// limits see real client IPs instead of the proxy's single IP (default: off)
if (E.TRUST_PROXY) {
  app.set('trust proxy', /^\d+$/.test(String(E.TRUST_PROXY)) ? Number(E.TRUST_PROXY) : String(E.TRUST_PROXY) === 'true');
}

// Supabase — server-side only. URL/key are never sent to the browser or logged.
// Accepts SUPABASE_SERVICE_KEY or SUPABASE_SECRET_KEY (Supabase's newer name).
const SUPABASE_URL = E.SUPABASE_URL;
const SUPABASE_KEY = E.SUPABASE_SERVICE_KEY || E.SUPABASE_SECRET_KEY;
const sb = (SUPABASE_URL && SUPABASE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  : null;
const db = () => {
  if (!sb) { const e = new Error('supabase not configured'); e.code = 'NO_SUPA'; throw e; }
  return sb;
};
// the ledger module talks to Supabase through this single injected client
ledger.setClient(sb);
// acknowledgements share the same injected client (tests swap both for fakes)
ack.setClient(sb);

// shared LedgerError/MoneyError responder: machine code -> status, Telugu message
// to the caller, only the category to the server log (never amounts/names/phones)
function ledgerFail(res, e, ctx) {
  if (e && e.code === 'NO_SUPA') return res.status(503).json({ error: 'డేటాబేస్ అమరిక లేదు, యజమానిని సంప్రదించండి' });
  const status = {
    OVERPAYMENT: 409, ALREADY_REVERSED: 409, CONFLICT: 409,
    HAS_LINKED_ROWS: 409, SETTLEMENT_REQUIRED: 409, KIND_MISMATCH: 409,
    NOT_DISPUTED: 409,
    NOT_FOUND: 404, NOT_OWNED: 404,
    NOT_REVERSIBLE: 400, BAD_REQUEST: 400, ACK_BAD_STATE: 400, ACK_NOT_ALLOWED: 400,
    REASON_REQUIRED: 400, DISCOUNT_TOO_BIG: 400,
    NO_LEDGER: 500,
  }[(e && e.code)] || 0;
  const final = status || 500; // unmapped -> 500 (and it must still be logged)
  if (final >= 500) {
    const rid = (res.locals && res.locals.reqId) || '-';
    console.error('[ledger-fail] ' + ctx + ' id=' + rid + ' err=' + ((e && (e.code || e.name)) || 'ERROR') + pgDiag(e));
    return res.status(final).json({ error: 'సర్వర్ సమస్య, మళ్లీ ప్రయత్నించండి', id: rid });
  }
  return res.status(final).json({ error: e.message, code: e.code });
}
// opaque, PII-free database diagnostics: Postgres/PostgREST error CODE and,
// when the message names them, the CONSTRAINT or COLUMN identifier only —
// never the message text itself, which can carry row values / names
function pgDiag(e) {
  const p = (e && e.cause) || e;
  if (!p || typeof p !== 'object') return '';
  const out = [];
  if (p.code) out.push('pg=' + String(p.code).slice(0, 12));
  const msg = String(p.message || '');
  const con = (msg.match(/constraint "([^"]+)"/) || [])[1];
  const col = (msg.match(/column "([^"]+)"/) || [])[1];
  if (con) out.push('constraint=' + con.slice(0, 64));
  if (col) out.push('column=' + col.slice(0, 64));
  return out.length ? ' [' + out.join(' ') + ']' : '';
}
// shared error responder: Telugu message to the caller, only a non-sensitive
// error category + route + request id to the server log (never message bodies,
// PII, transcripts or upstream payloads)
function fail(res, e, ctx) {
  if (e && e.code === 'NO_SUPA') return res.status(503).json({ error: 'డేటాబేస్ అమరిక లేదు, యజమానిని సంప్రదించండి' });
  const rid = (res.locals && res.locals.reqId) || '-';
  console.error('[fail] ' + ctx + ' id=' + rid + ' err=' + ((e && (e.code || e.name)) || 'ERROR'));
  return res.status(500).json({ error: 'సర్వర్ సమస్య, మళ్లీ ప్రయత్నించండి', id: rid });
}

// TTS word cache: data/tts-cache/<sha1(word)>.wav — each word is synthesized once.
// TTS_CACHE_DIR overrides the location (test-security.js points it at a temp
// dir so tests never write into the real cache); default behavior unchanged.
const CACHE_DIR = E.TTS_CACHE_DIR || path.join(__dirname, 'data', 'tts-cache');
fs.mkdirSync(CACHE_DIR, { recursive: true });

// security middleware chain: correlation id -> headers -> same-origin (CSRF)
// -> static -> JSON body (64kb cap) -> signed cookies
app.disable('x-powered-by');
app.use(requestId);
app.use(securityHeaders({ production: PROD }));
app.use(sameOrigin({ allowedOrigins: String(E.APP_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean) }));
app.use(express.static('public'));
// STT receives audio bytes (parsed by express.raw inside the route), so reject
// wrong content types BEFORE the JSON parser ever reads the body — otherwise a
// malformed "application/json" body would surface as a parse error instead of 415
app.use((req, res, next) => {
  if (req.method === 'POST' && req.path === '/api/stt' &&
      String(req.get('Content-Type') || '').toLowerCase().indexOf('audio/') !== 0) {
    return res.status(415).json({ error: 'ఆడియో ఫైల్ మాత్రమే పంపాలి · audio content required' });
  }
  next();
});
app.use(express.json({ limit: '64kb' }));
app.use(cookieParser(JWT_SECRET));

// ---- small validators ----
const validPhone = p => /^[6-9]\d{9}$/.test(String(p == null ? '' : p).trim());
const validPin = p => /^\d{4}$/.test(String(p == null ? '' : p).trim());

// ---- session cookie (JWT, 30 days, httpOnly + signed + sameSite=lax) ----
function setSession(res, shop) {
  const token = jwt.sign({ shopId: shop.id, phone: shop.phone }, JWT_SECRET, { expiresIn: '30d' });
  res.cookie('session', token, {
    httpOnly: true, sameSite: 'lax', signed: true,
    secure: PROD, maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}
function clearSession(res) {
  res.clearCookie('session', { httpOnly: true, sameSite: 'lax', signed: true, secure: PROD, path: '/' });
}
// voiceOk token: proves the challenge word was heard; 5 minutes, bound to phone.
// IMPORTANT: this authenticates completion of the audio interaction (a human
// heard the word and picked it) — it does NOT prove ownership of the phone
// number. Proper phone verification (OTP) is a documented future requirement
// (see docs/SECURITY.md).
function voiceOkPhone(token, phone) {
  try {
    const p = jwt.verify(String(token), JWT_SECRET);
    return !!(p && p.purpose === 'voiceOk' && p.phone === phone);
  } catch (_) { return false; }
}

// ---- rate limits (all keys include req.ip so express-rate-limit validations pass) ----
const rlMsg = { error: 'చాలా ఎక్కువ ప్రయత్నాలు, కాసేపటి తర్వాత మళ్లీ ప్రయత్నించండి' };
const limiter = o => rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false, message: rlMsg, ...o });
const startLimiter = limiter({});
const challengeLimiter = limiter({});
const answerLimiter = limiter({ keyGenerator: req => `${ipKeyGenerator(req.ip)}|${(req.body && req.body.phone) || ''}` });
const signupLimiter = limiter({});
const loginLimiter = limiter({ keyGenerator: req => `${ipKeyGenerator(req.ip)}|${(req.body && req.body.phone) || ''}` });
const audioLimiter = rateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false, message: rlMsg });
// per-shop limit for STT/TTS so strangers can never burn Gnani credits
const shopApiLimiter = rateLimit({
  windowMs: 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false, message: rlMsg,
  keyGenerator: req => `${ipKeyGenerator(req.ip)}|${(req.shop && req.shop.id) || 'anon'}`,
});
// TTS: same policy as STT (60/min) but a separate bucket, so a TTS burst can
// never starve speech recognition (or vice versa) for the same shop
const ttsApiLimiter = rateLimit({
  windowMs: 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false, message: rlMsg,
  keyGenerator: req => `${ipKeyGenerator(req.ip)}|${(req.shop && req.shop.id) || 'anon'}`,
});
// public acknowledgement endpoints: 30/min per IP. The customer's browser only
// ever needs one POST, so this stays well inside normal use while a scripted
// stranger gets shut out.
const ackPublicLimiter = rateLimit({
  windowMs: 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false, message: rlMsg,
  keyGenerator: req => ipKeyGenerator(req.ip),
});
// GETs share the same 30/min-per-IP policy but a separate bucket, so page/view
// loads cannot eat the POST budget the security test measures.
const ackPublicGetLimiter = rateLimit({
  windowMs: 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false, message: rlMsg,
  keyGenerator: req => ipKeyGenerator(req.ip),
});

// ---- Gnani TTS (same call the /api/tts route uses) ----
// Explicit upstream timeouts; failures are returned as a kind + status only —
// the provider response body is never kept, logged or forwarded to clients.
const TTS_TIMEOUT_MS = 15000, STT_TIMEOUT_MS = 30000;
const timedOut = e => !!(e && (e.name === 'TimeoutError' || e.name === 'AbortError'));
async function gnaniTts(text) {
  let r;
  try {
    r = await fetch(B + '/api/v1/tts/inference', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key-ID': K },
      body: JSON.stringify({
        text, voice: E.TTS_VOICE || 'Nalini', model: E.TTS_MODEL || 'timbre-v2.5',
        language: E.TTS_LANG || 'te-IN', speed: 1.0,
        audio_config: { sample_rate: 24000, num_channels: 1, sample_width: 2, encoding: 'linear_pcm', container: 'wav' },
      }),
      signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
    });
  } catch (e) {
    return { ok: false, kind: timedOut(e) ? 'timeout' : 'network' };
  }
  if (!r.ok) return { ok: false, kind: 'upstream', status: r.status };
  try {
    return { ok: true, status: r.status, buffer: Buffer.from(await r.arrayBuffer()) };
  } catch (e) {
    return { ok: false, kind: timedOut(e) ? 'timeout' : 'network' };
  }
}
const sha1 = s => crypto.createHash('sha1').update(s, 'utf8').digest('hex');
const inflight = new Map();
// resolve a word to a cached .wav file, synthesizing at most once per word
function wordAudio(word) {
  const file = path.join(CACHE_DIR, sha1(word) + '.wav');
  if (fs.existsSync(file)) return Promise.resolve(file);
  if (inflight.has(sha1(word))) return inflight.get(sha1(word));
  const p = (async () => {
    const out = await gnaniTts(word);
    if (!out.ok) {
      throw Object.assign(new Error('TTS ' + (out.kind || out.status || 'fail')),
        { code: out.kind === 'timeout' ? 'TTS_TIMEOUT' : 'TTS_FAIL' });
    }
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, out.buffer);
    fs.renameSync(tmp, file);
    return file;
  })().finally(() => inflight.delete(sha1(word)));
  inflight.set(sha1(word), p);
  return p;
}

// whole-sentence read-through cache: s-<sha1(text)>.wav. Confirm-card and
// balance sentences repeat a lot across replays/rereads, so a cache hit skips
// a Gnani call — this is what keeps the upstream 429 rate limits from turning
// into user-visible 502s. Read-only check before synthesis; the write is
// best-effort (a failed write only costs the next hit, never breaks playback).
// The file NAME is a hash; the text or its words are never stored anywhere.
async function sentenceAudio(text) {
  const file = path.join(CACHE_DIR, 's-' + sha1(text) + '.wav');
  if (fs.existsSync(file)) {
    try { return { ok: true, cached: true, buffer: fs.readFileSync(file) }; } catch (_) {}
  }
  const out = await gnaniTts(text);
  if (out.ok) {
    try {
      const tmp = file + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, out.buffer);
      fs.renameSync(tmp, file);
    } catch (_) {}
  }
  return out;
}

// ---- Sprint 3: acknowledgement audio pre-generation ----
// ONE Telugu summary is synthesized at link-creation time and cached on disk
// as data/tts-cache/ack-<sha256.hex>.wav — keyed by the TOKEN HASH (the raw
// token never becomes a file name and the summary text is never stored; the
// file name is a hash, exactly like every other cache entry). A TTS failure
// only means the link has no audio; the link itself is unaffected.
async function pregenAckAudio(tokenHash, text) {
  const file = path.join(CACHE_DIR, 'ack-' + tokenHash + '.wav');
  if (fs.existsSync(file)) return true;
  const out = await gnaniTts(text);
  if (!out.ok) {
    console.error('[ack-audio] id=- tts=' + (out.kind || out.status || 'fail')); // kind only, no text
    return false;
  }
  try {
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, out.buffer);
    fs.renameSync(tmp, file);
    return true;
  } catch (_) { return true; } // write failure must not fail the link
}

// small server-side digits->Telugu words for the spoken summary (the TTS
// provider reads digit runs badly, same reason the browser telemetry spells
// numbers as words before sending them)
const ACK_TE_NUM = ['సున్నా', 'ఒకటి', 'రెండు', 'మూడు', 'నాలుగు', 'ఐదు', 'ఆరు', 'ఏడు', 'ఎనిమిది', 'తొమ్మిది'];
const ACK_TE_TEEN = ['పది', 'పదకొండు', 'పన్నెండు', 'పదమూడు', 'పద్నాలుగు', 'పదిహేను', 'పదహారు', 'పదిఏడు', 'పద్దెనిమిది', 'పందొమ్మది'];
const ACK_TE_TENS = { 2: 'ఇరవై', 3: 'ముప్పై', 4: 'నలభై', 5: 'యాభై', 6: 'అరవై', 7: 'డెభై', 8: 'ఎనభై', 9: 'తొంభై' };
function teWords(n) {
  n = Math.round(Number(n) || 0);
  if (n < 0) return 'మైనస్ ' + teWords(-n);
  if (n < 10) return ACK_TE_NUM[n];
  if (n < 20) return ACK_TE_TEEN[n - 10];
  if (n < 100) return ACK_TE_TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ACK_TE_NUM[n % 10] : '');
  if (n < 1000) return ACK_TE_NUM[Math.floor(n / 100)] + ' వందల' + (n % 100 ? ' ' + teWords(n % 100) : '');
  if (n < 100000) return teWords(Math.floor(n / 1000)) + ' వేల' + (n % 1000 ? ' ' + teWords(n % 1000) : '');
  if (n < 10000000) return teWords(Math.floor(n / 100000)) + ' లక్షల' + (n % 100000 ? ' ' + teWords(n % 100000) : '');
  return teWords(Math.floor(n / 10000000)) + ' కోట్ల' + (n % 10000000 ? ' ' + teWords(n % 10000000) : '');
}
const ACK_UNIT_PL = { quintal: 'క్వింటాళ్ల', kg: 'కిలోలు', tonne: 'టన్నులు', bag: 'బస్తాలు' };
const ACK_PRODUCE_TE = {
  paddy: 'వరి', cotton: 'పత్తి', chilli: 'మిరప', maize: 'మొక్కజొన్న',
  bengal_gram: 'శనగ', red_gram: 'కంది', green_gram: 'పెసర',
  black_gram: 'మినుము', groundnut: 'వేరుశనగ', turmeric: 'పసుపు',
  sesame: 'నువ్వులు', jowar: 'జొన్న',
};
// spoken summary of the entry: "<shop>: <what> <amount> రూపాయలు"
function ackSpokenText(tx, shopName) {
  const shop = String(shopName || 'దుకాణం') + ': ';
  if (tx.event === 'produce_delivery') {
    const q = tx.quantity != null ? teWords(Number(tx.quantity)) + ' ' + (ACK_UNIT_PL[tx.unit] || tx.unit || '') : '';
    const prod = ACK_PRODUCE_TE[(tx.produce || '').toLowerCase()] || (tx.produce || '');
    return shop + q + ' ' + prod + ' అందింది. మొత్తం ' + teWords(tx.amount) + ' రూపాయలు.';
  }
  return shop + 'తీసుకున్న ఉద్దెర ' + teWords(tx.amount) + ' రూపాయలు.';
}
// on-screen (non-TTS) summary used in the WhatsApp share message
function ackSummaryText(tx) {
  if (tx.event === 'produce_delivery') {
    return `${tx.quantity != null ? tx.quantity : '?'} ${tx.unit || ''} ${ACK_PRODUCE_TE[(tx.produce || '').toLowerCase()] || tx.produce || ''}`.trim();
  }
  return 'ఉద్దెర';
}

// ---- Telugu kirana word bank (voice-word check) ----
const WORDS = [
  'కందిపప్పు', 'బియ్యం', 'పంచదార', 'ఉప్పు', 'నూనె', 'పాలు', 'పసుపు', 'కారం', 'గోధుమలు',
  'చాయ్ పొడి', 'చింతపండు', 'ఉల్లిపాయలు', 'బంగాళదుంపలు', 'శనగపప్పు', 'మినపప్పు', 'పెసరపప్పు',
  'జీలకర్ర', 'ఆవాలు', 'సబ్బు', 'బిస్కెట్లు', 'పెరుగు', 'వెన్న', 'బెల్లం', 'టమోటా', 'మిరపకాయలు',
  'కొబ్బరి', 'అటుకులు', 'సేమ్యా', 'రవ్వ', 'గుడ్లు',
];

// challenges live ONLY in server memory: which option is correct is never told
// to the browser (the 3 option texts include the right word — only the audio
// reveals which one). Completing it proves the audio interaction happened — it
// is NOT proof of phone-number ownership (no OTP/provider is configured; see
// docs/SECURITY.md)
const challenges = new Map(); // id -> { phone, word, expiresAt, used }
const CHALLENGE_TTL = 2 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [id, c] of challenges) if (c.expiresAt <= now) challenges.delete(id);
}, 60 * 1000).unref();

function pickOptions(word) {
  const pool = WORDS.filter(w => w !== word);
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  const opts = [word, pool[0], pool[1]];
  for (let i = opts.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [opts[i], opts[j]] = [opts[j], opts[i]]; }
  return opts;
}

// ---- AUTH: phone + voice-word challenge + 4-digit PIN (no OTP) ----
// The spoken-word challenge verifies that the login session completed the
// audio interaction; it does NOT verify ownership of the phone number.
// Phone-ownership verification (OTP) is a future requirement — see
// docs/SECURITY.md. Do not describe this flow as phone verification.
app.post('/api/auth/start', startLimiter, async (req, res) => {
  const phone = String((req.body && req.body.phone) || '').trim();
  if (!validPhone(phone)) return res.status(400).json({ error: '10 అంకెల సరైన మొబైల్ నంబర్ నమోదు చేయండి' });
  try {
    const { data, error } = await db().from('shops').select('id').eq('phone', phone).limit(1);
    if (error) throw error;
    res.json({ exists: !!(data && data.length) });
  } catch (e) { fail(res, e, 'auth/start'); }
});

app.get('/api/auth/challenge', challengeLimiter, async (req, res) => {
  const phone = String(req.query.phone || '').trim();
  if (!validPhone(phone)) return res.status(400).json({ error: '10 అంకెల సరైన మొబైల్ నంబర్ నమోదు చేయండి' });
  try {
    const word = WORDS[Math.floor(Math.random() * WORDS.length)];
    await wordAudio(word); // generate + cache (costs Gnani credits only once per word)
    const challengeId = crypto.randomUUID();
    challenges.set(challengeId, { phone, word, expiresAt: Date.now() + CHALLENGE_TTL, used: false });
    res.json({ challengeId, audioUrl: '/api/auth/challenge/audio/' + challengeId, options: pickOptions(word) });
  } catch (e) {
    console.error('challenge id=' + (req.id || '-') + ' ' + (e && (e.code || e.name) || 'ERROR'));
    res.status(e && e.code === 'TTS_TIMEOUT' ? 504 : 502)
      .json({ error: 'ధ్వని సిద్ధం కాలేదు, మళ్లీ ప్రయత్నించండి' });
  }
});

// serves ONLY the word of that challenge (looked up in server memory, never from user input)
app.get('/api/auth/challenge/audio/:challengeId', audioLimiter, (req, res) => {
  const c = challenges.get(String(req.params.challengeId));
  if (!c || c.expiresAt <= Date.now()) return res.status(404).json({ error: 'సవాలు ముగిసింది, మళ్లీ వినండి' });
  const file = path.join(CACHE_DIR, sha1(c.word) + '.wav');
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'ఆడియో దొరకలేదు' });
  res.set('Cache-Control', 'public, max-age=604800');
  res.type('audio/wav').send(fs.readFileSync(file));
});

app.post('/api/auth/challenge/answer', answerLimiter, (req, res) => {
  const b = req.body || {};
  const bad = () => res.status(400).json({ error: 'సరిలేదు! కొత్త పదం విని మళ్లీ ప్రయత్నించండి' });
  const c = challenges.get(String(b.challengeId || ''));
  const phone = String(b.phone || '').trim();
  // single use: missing, expired, already answered, or wrong phone -> rejected
  if (!c || c.used || c.expiresAt <= Date.now() || !validPhone(phone) || phone !== c.phone) return bad();
  if (String(b.choice || '').trim() !== c.word) { c.used = true; return bad(); } // wrong answer burns it
  c.used = true;
  const voiceOkToken = jwt.sign({ phone: c.phone, purpose: 'voiceOk' }, JWT_SECRET, { expiresIn: '5m' });
  res.json({ voiceOkToken });
});

const SHOP_COLS = 'id, phone, owner_name, shop_name, address, voice_id, business_type, commission_percent, created_at';
const profileCompleteOf = s => !!(s && s.owner_name && s.shop_name && s.address);

app.post('/api/auth/signup', signupLimiter, async (req, res) => {
  const b = req.body || {};
  const phone = String(b.phone || '').trim();
  const pin = String(b.pin == null ? '' : b.pin).trim();
  if (!validPhone(phone)) return res.status(400).json({ error: '10 అంకెల సరైన మొబైల్ నంబర్ నమోదు చేయండి' });
  if (!validPin(pin)) return res.status(400).json({ error: 'పిన్ ఖచ్చితంగా 4 అంకెలు ఉండాలి' });
  if (!voiceOkPhone(b.voiceOkToken, phone)) return res.status(400).json({ error: 'ధ్వని ధృవీకరణ సరిలేదు, మళ్లీ ప్రయత్నించండి' });
  try {
    const ex = await db().from('shops').select('id').eq('phone', phone).limit(1);
    if (ex.error) throw ex.error;
    if (ex.data && ex.data.length) return res.status(409).json({ error: 'ఈ నంబర్‌తో ఇప్పటికే ఖాతా ఉంది, లాగిన్ అవ్వండి' });
    const pin_hash = await bcrypt.hash(pin, 10);
    const { data, error } = await db().from('shops').insert({
      phone, pin_hash, owner_name: '', shop_name: '', address: '', failed_pin: 0,
      created_at: new Date().toISOString(),
    }).select(SHOP_COLS).single();
    if (error) throw error;
    setSession(res, data);
    res.json({ ok: true, shop: data, profileComplete: profileCompleteOf(data) });
  } catch (e) {
    if (e && e.code === '23505') return res.status(409).json({ error: 'ఈ నంబర్‌తో ఇప్పటికే ఖాతా ఉంది, లాగిన్ అవ్వండి' });
    fail(res, e, 'auth/signup');
  }
});

app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const b = req.body || {};
  const phone = String(b.phone || '').trim();
  const pin = String(b.pin == null ? '' : b.pin).trim();
  // generic message — never reveals whether the phone exists
  const generic = () => res.status(401).json({ error: 'ఫోన్ నంబర్ లేదా పిన్ సరిలేదు' });
  if (!validPhone(phone) || !validPin(pin)) return generic();
  if (!voiceOkPhone(b.voiceOkToken, phone)) return res.status(400).json({ error: 'ధ్వని ధృవీకరణ సరిలేదు, మళ్లీ ప్రయత్నించండి' });
  try {
    const { data, error } = await db().from('shops')
      .select(SHOP_COLS + ', pin_hash, failed_pin, locked_until')
      .eq('phone', phone).limit(1);
    if (error) throw error;
    const shop = data && data[0];
    if (!shop) return generic();
    if (shop.locked_until && new Date(shop.locked_until).getTime() > Date.now()) {
      return res.status(429).json({ error: 'చాలా ప్రయత్నాలు చేశారు. 15 నిమిషాల తర్వాత మళ్లీ ప్రయత్నించండి.' });
    }
    const okPin = await bcrypt.compare(pin, shop.pin_hash || '');
    if (!okPin) {
      const failed = (shop.failed_pin || 0) + 1;
      const upd = { failed_pin: failed };
      if (failed >= 5) upd.locked_until = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      await db().from('shops').update(upd).eq('id', shop.id);
      return generic();
    }
    if (shop.failed_pin || shop.locked_until) await db().from('shops').update({ failed_pin: 0, locked_until: null }).eq('id', shop.id);
    const safe = { id: shop.id, phone: shop.phone, owner_name: shop.owner_name, shop_name: shop.shop_name, address: shop.address, voice_id: shop.voice_id, business_type: shop.business_type, created_at: shop.created_at };
    setSession(res, safe);
    res.json({ ok: true, shop: safe, profileComplete: profileCompleteOf(safe) });
  } catch (e) { fail(res, e, 'auth/login'); }
});

app.post('/api/auth/logout', (req, res) => { clearSession(res); res.json({ ok: true }); });

// ---- health probe (Render): no auth, returns a constant only — no secrets ----
app.get('/healthz', (req, res) => res.json({ ok: true }));

// ---------------------------------------------------------------------------
// Keep-alive for free-tier cold starts (Render): a cron (e.g. cron-job.org,
// every 5 minutes) pings GET /keepalive?k=<KEEPALIVE_TOKEN>. The token is
// compared in constant time and the k value is NEVER echoed or logged; a
// wrong/missing token (or a server with no token configured) reads as the
// same generic 404 that every unknown route gets. The body confirms load-out
// with one cheap Supabase read so the DB pool stays warm too. /healthz above
// stays public, secret-free and needs no env.
// ---------------------------------------------------------------------------
const KEEPALIVE_TOKEN = String(E.KEEPALIVE_TOKEN || '').trim();
const keepaliveLimiter = rateLimit({
  windowMs: 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false,
  message: { error: 'రూట్ దొరకలేదు · route not found' }, // generic: no rate/bucket hints
  keyGenerator: req => ipKeyGenerator(req.ip),
});
// length-independent constant-time compare (hash both sides to fixed size)
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a == null ? '' : a), 'utf8').digest();
  const hb = crypto.createHash('sha256').update(String(b == null ? '' : b), 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}
app.get('/keepalive', keepaliveLimiter, async (req, res) => {
  const k = req.query.k;
  if (!KEEPALIVE_TOKEN || typeof k !== 'string' || !safeEqual(k, KEEPALIVE_TOKEN)) {
    return res.status(404).json({ error: 'రూట్ దొరకలేదు · route not found' });
  }
  try {
    // the one cheap read keeps the Supabase connection warm; a failure must
    // still answer ok (cron wants the app awake, not a DB status report) and
    // is logged without any request data
    await db().from('shops').select('id').limit(1);
  } catch (_) {}
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Sprint 3 — PUBLIC customer-acknowledgement endpoints (no auth, NO COOKIES:
// nothing here reads or sets a session).
// These live OUTSIDE the requireAuth/cookie machinery but INSIDE the same
// security.js chain: identical CSP, nosniff, frame-deny and the sameOrigin
// origin/CSRF check on the mutating POST. Every response is noindex and
// no-store; the token itself is never logged (redactAckToken keeps any URL
// that reaches a log line secret-free).
// ---------------------------------------------------------------------------
const ACK_NO_CACHE = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
};

// GET /a/:token — the customer-facing page (self-contained: /ack.html + /ack.js
// + /ack.css, all CSP-safe with no inline scripts/styles/handlers). The token
// shape is NOT validated here on purpose: an odd URL simply shows the generic
// not-found state, while browsers get noCancelled red — same page either way.
app.get('/a/:token', ackPublicGetLimiter, (req, res) => {
  res.set(ACK_NO_CACHE);
  console.log('[ack] page id=' + req.id + ' path=' + redactAckToken(req.originalUrl));
  res.sendFile(path.join(__dirname, 'public', 'ack.html'));
});

// GET /a/:token/audio — the pre-generated summary wav, only for a VALID,
// ACTIVE (awaiting, unexpired) token.
app.get('/a/:token/audio', ackPublicGetLimiter, async (req, res) => {
  res.set(ACK_NO_CACHE);
  try {
    const v = await ack.viewByToken(String(req.params.token));
    if (!v || v.status !== 'awaiting') {
      // expired / revoked / unknown / already answered: one generic sound-less 404
      return res.status(404).json({ error: ack.GENERIC_404, code: 'NOT_FOUND' });
    }
    const file = path.join(CACHE_DIR, 'ack-' + v.ack.token_hash + '.wav');
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'ఆడియో లేదు · no audio', code: 'NO_AUDIO' });
    res.type('audio/wav').send(fs.readFileSync(file));
  } catch (e) {
    console.error('[ack] audio id=' + req.id + ' err=' + ((e && e.code) || 'ERROR'));
    res.status(500).json({ error: 'సర్వర్ సమస్య, మళ్లీ ప్రయత్నించండి' });
  }
});

// GET /api/public/ack/:token — the JSON the page renders. Shows ONLY: shop
// name, entry date, what happened, amount, item details, response state.
// NEVER: other entries, balances, phone numbers or the shop address.
app.get('/api/public/ack/:token', ackPublicGetLimiter, async (req, res) => {
  res.set(ACK_NO_CACHE);
  try {
    const v = await ack.viewByToken(String(req.params.token));
    if (!v) return res.status(404).json({ error: ack.GENERIC_404, code: 'NOT_FOUND', status: 'not_found' });
    if (v.status === 'expired') {
      return res.status(404).json({ error: 'లింక్ గడువు ముగిసింది · link expired', code: 'ACK_EXPIRED', status: 'expired' });
    }
    // shop name by the ACK's own shop_id (cancelled links have no tx to read)
    const shopRows = await db().from('shops').select('shop_name')
      .eq('id', (v.tx && v.tx.shop_id) || v.ack.shop_id).limit(1);
    if (shopRows && shopRows.error) throw shopRows.error;
    const shopName = ((shopRows.data || [])[0] || {}).shop_name || '';
    const view = ack.publicView(v.status, v.ack, v.tx, shopName);
    // audio availability for the awaiting page: does the cache file exist?
    if (v.status === 'awaiting') {
      view.audio = fs.existsSync(path.join(CACHE_DIR, 'ack-' + v.ack.token_hash + '.wav'));
    } else {
      view.audio = false; // a responded/cancelled link never plays the summary
    }
    return res.json(view);
  } catch (e) {
    console.error('[ack] view id=' + req.id + ' err=' + ((e && e.code) || 'ERROR'));
    return res.status(500).json({ error: 'సర్వర్ సమస్య, మళ్లీ ప్రయత్నించండి' });
  }
});

// POST /api/public/ack/:token — THE customer's single response
// { action: 'acknowledge' | 'dispute', note? }. Single-response rule: the
// first answer wins and any repeat returns the SAME status; unknown/expired/
// revoked tokens read as the same generic 404. 30/min per IP; the sameOrigin
// guard upstream covers CSRF; the audit row records NO ip and NO token.
app.post('/api/public/ack/:token', ackPublicLimiter, async (req, res) => {
  const b = req.body || {};
  const action = b.action === 'dispute' ? 'dispute' : b.action === 'acknowledge' ? 'acknowledge' : null;
  if (!action) return res.status(400).json({ error: 'చర్య సరిలేదు · unknown action', code: 'BAD_ACTION' });
  try {
    const out = await ack.respond(String(req.params.token), action,
      typeof b.note === 'string' ? b.note : '');
    if (out.code === 'NOT_FOUND') return res.status(404).json({ error: ack.GENERIC_404, code: 'NOT_FOUND' });
    console.log('[ack] respond id=' + req.id + ' result=' + out.status + (out.repeat ? ' repeat' : ''));
    return res.json({ ok: true, status: out.status, repeat: !!out.repeat });
  } catch (e) {
    console.error('[ack] respond id=' + req.id + ' err=' + ((e && e.code) || 'ERROR'));
    return res.status(500).json({ error: 'సర్వర్ సమస్య, మళ్లీ ప్రయత్నించండి' });
  }
});

// ---- requireAuth: every /api route except /api/auth/* ----
function requireAuth(req, res, next) {
  const token = req.signedCookies && req.signedCookies.session;
  if (!token) return res.status(401).json({ error: 'లాగిన్ కావాలి' });
  try {
    const p = jwt.verify(token, JWT_SECRET);
    if (!p || !p.shopId) throw new Error('no shop');
    req.shop = { id: p.shopId, phone: p.phone }; // shop id comes from the session, never the body
    next();
  } catch (_) { res.status(401).json({ error: 'సెషన్ ముగిసింది, మళ్లీ లాగిన్ అవ్వండి' }); }
}
app.use('/api', requireAuth);

// ---- business-type separation (kirana vs rythu) --------------------------
// A shop that has not chosen a business type is blocked from every ledger
// route (403 BUSINESS_TYPE_REQUIRED) until it does; once chosen, the type
// decides which routes / kinds / workflows the shop may touch. /api/me and
// PUT /api/me/business-type stay open so onboarding can complete.
const BIZ_REQUIRED = { error: 'వ్యాపార రకం ఎంచుకోండి · choose your business type', code: 'BUSINESS_TYPE_REQUIRED' };
const BIZ_MISMATCH = { error: 'ఈ రూట్ మీ దుకాణ రకానికి అందుబాటులో లేదు · not available for your business type', code: 'BUSINESS_TYPE_MISMATCH' };
// load the shop's current business_type once per request (the JWT carries
// none, so a newly-chosen type takes effect immediately without re-login)
async function loadBiz(req) {
  if (req.shop.business_type !== undefined) return req.shop.business_type;
  const { data, error } = await db().from('shops').select('business_type').eq('id', req.shop.id).single();
  if (error) throw error;
  req.shop.business_type = data ? data.business_type : null;
  return req.shop.business_type;
}
function requireBizType(req, res, next) {
  loadBiz(req).then(v => {
    if (!bt.isValid(v)) return res.status(403).json(BIZ_REQUIRED);
    next();
  }).catch(e => fail(res, e, 'biz-type/load'));
}
// route-scoped guard: e.g. a kirana shop can never call /api/rythu/*
const onlyBiz = t => function requireBiz(req, res, next) {
  requireBizType(req, res, () => {
    if (req.shop.business_type !== t) return res.status(403).json(BIZ_MISMATCH);
    next();
  });
};
const rythuOnly = onlyBiz('rythu');

app.get('/api/me', async (req, res) => {
  try {
    const { data, error } = await db().from('shops').select(SHOP_COLS).eq('id', req.shop.id).single();
    if (error || !data) return res.status(404).json({ error: 'ఖాతా దొరకలేదు' });
    res.json({ shop: data, profileComplete: profileCompleteOf(data) }); // never pin_hash
  } catch (e) { fail(res, e, 'me/get'); }
});

app.put('/api/me', async (req, res) => {
  const b = req.body || {};
  const owner = String(b.owner_name == null ? '' : b.owner_name).trim();
  const shopName = String(b.shop_name == null ? '' : b.shop_name).trim();
  const address = String(b.address == null ? '' : b.address).trim();
  if (!owner || !shopName || !address) return res.status(400).json({ error: 'అన్ని వివరాలు తప్పనిసరి' });
  if (owner.length > 80 || shopName.length > 120 || address.length > 500) {
    return res.status(400).json({ error: 'వివరాలు చాలా పొడవుగా ఉన్నాయి (పేరు 80, దుకాణం 120, చిరునామా 500 అక్షరాలు)' });
  }
  // optional aadhati commission suggestion % (0–100); absent = leave as-is
  const upd = { owner_name: owner, shop_name: shopName, address };
  if (b.commission_percent !== undefined) {
    if (b.commission_percent === null || b.commission_percent === '') {
      upd.commission_percent = null;
    } else {
      const pct = Number(b.commission_percent);
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
        return res.status(400).json({ error: 'కమీషన్ 0-100% మధ్య ఉండాలి' });
      }
      upd.commission_percent = pct;
    }
  }
  try {
    const { data, error } = await db().from('shops')
      .update(upd)
      .eq('id', req.shop.id).select(SHOP_COLS).single();
    if (error) throw error;
    res.json({ shop: data, profileComplete: true });
  } catch (e) { fail(res, e, 'me/put'); }
});

// PUT /api/me/business-type { business_type } — the one-time onboarding choice.
// Allowed while the type is still null OR the shop has zero transactions; once
// entries exist the evidence locks the choice (409 BUSINESS_TYPE_LOCKED).
app.put('/api/me/business-type', async (req, res) => {
  const v = String((req.body || {}).business_type || '').trim();
  if (!bt.isValid(v)) return res.status(400).json({ error: 'వ్యాపార రకం "kirana" లేదా "rythu" కావాలి', code: 'BAD_BUSINESS_TYPE' });
  try {
    const [sq, tq] = await Promise.all([
      db().from('shops').select('business_type').eq('id', req.shop.id).single(),
      db().from('transactions').select('id', { count: 'exact', head: true }).eq('shop_id', req.shop.id),
    ]);
    if (sq.error) throw sq.error;
    if (tq.error) throw tq.error;
    const cur = sq.data ? sq.data.business_type : null;
    const locked = bt.changeRule(cur, tq.count);
    if (locked) {
      return res.status(409).json({
        error: 'ఎంట్రీల తర్వాత వ్యాపార రకం మార్చలేరు · cannot change after entries exist',
        code: locked,
      });
    }
    const { data, error } = await db().from('shops')
      .update({ business_type: v }).eq('id', req.shop.id).select(SHOP_COLS).single();
    if (error) throw error;
    res.json({ ok: true, shop: data });
  } catch (e) { fail(res, e, 'me/business-type'); }
});

// ---- STT (Gnani Prisma proxy: auth + per-shop limit + timeout, no raw
// provider payloads or transcripts are ever logged or forwarded) ----
const STT_FAIL_MSG = 'గుర్తించడం సాధ్యం కాలేదు, మళ్లీ చెప్పండి · transcription failed';
const STT_TIMEOUT_MSG = 'గుర్తించడానికి సమయం ఎక్కువైంది, మళ్లీ చెప్పండి · transcription timed out';
// language may be chosen per request (query) with STT_LANG as the env default.
// Empty responses are retried once by the client with indic-auto (same audio).
const STT_LANG_RE = /^(indic-auto|[a-z]{2}-IN(,[a-z]{2}-IN){0,3})$/;
// custom terms: <=200 short phrases, documented Gnani Prisma v3.0 form field
// "keyterms" (docs.gnani.ai/api/STT/models/prisma-v3#context). The client sends
// them base64url(JSON) in X-KV-Terms; nothing here is ever logged.
function sttTermsFromHeader(h) {
  if (typeof h !== 'string' || !h || h.length > 12000) return [];
  let arr;
  try { arr = JSON.parse(Buffer.from(h, 'base64url').toString('utf8')); } catch (_) { return []; }
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const raw of arr) {
    if (typeof raw !== 'string') continue;
    const t = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 60);
    if (!t || t.indexOf('<|') !== -1 || t.indexOf('|>') !== -1) continue;
    if (out.indexOf(t) === -1) out.push(t);
    if (out.length >= 200) break; // documented keyterms limit
  }
  return out;
}
app.post('/api/stt', shopApiLimiter, express.raw({ type: () => true, limit: '5mb' }), async (req, res) => {
  const ct = String(req.get('Content-Type') || '').toLowerCase();
  if (ct.indexOf('audio/') !== 0) return res.status(415).json({ error: 'ఆడియో ఫైల్ మాత్రమే పంపాలి · audio content required' });
  if (!Buffer.isBuffer(req.body) || req.body.length < 1000) {
    return res.status(400).json({ error: 'ఆడియో ఖాళీ/చాలా చిన్నది · empty or invalid audio body' });
  }
  const t0 = Date.now();
  const asked = String(req.query.lang || '').trim();
  const lang = STT_LANG_RE.test(asked) ? asked : (E.STT_LANG || 'te-IN');
  const terms = sttTermsFromHeader(req.get('X-KV-Terms'));
  try {
    const f = new FormData();
    f.append('audio_file', new Blob([req.body], { type: 'audio/wav' }), 'a.wav');
    f.append('model', 'prisma-v3.0');
    f.append('format', 'transcribe');
    f.append('language_code', lang);
    if (terms.length) f.append('keyterms', JSON.stringify(terms));
    let r;
    try {
      r = await fetch(B + '/stt/v3', {
        method: 'POST', headers: { 'X-API-Key-ID': K }, body: f,
        signal: AbortSignal.timeout(STT_TIMEOUT_MS),
      });
    } catch (e) {
      console.error('[stt] id=' + req.id + ' upstream ' + (timedOut(e) ? 'timeout' : 'network-error') + ' ms=' + (Date.now() - t0));
      return res.status(timedOut(e) ? 504 : 502).json({ error: timedOut(e) ? STT_TIMEOUT_MSG : STT_FAIL_MSG });
    }
    if (!r.ok) {
      // never forward raw provider errors — map to a safe status + Telugu message
      console.error('[stt] id=' + req.id + ' upstream-status=' + r.status + ' ms=' + (Date.now() - t0));
      return res.status(502).json({ error: STT_FAIL_MSG });
    }
    let j = null;
    try { j = JSON.parse(await r.text()); } catch (_) {}
    if (!j || typeof j.transcript !== 'string') {
      console.error('[stt] id=' + req.id + ' invalid-upstream-response ms=' + (Date.now() - t0));
      return res.status(502).json({ error: STT_FAIL_MSG });
    }
    // numbers only: language, term count, character count, duration — no content
    console.log('[stt] id=' + req.id + ' upstream=200 lang=' + lang + ' terms=' + terms.length +
      ' transcript_chars=' + j.transcript.length + ' ms=' + (Date.now() - t0));
    // forward only the fields the client uses — not the whole provider payload
    return res.json({ transcript: j.transcript, detected_language_code: j.detected_language_code || null });
  } catch (e) {
    console.error('[stt] id=' + req.id + ' ' + (e && (e.code || e.name) || 'ERROR') + ' ms=' + (Date.now() - t0));
    return res.status(500).json({ error: 'సర్వర్ సమస్య, మళ్లీ ప్రయత్నించండి' });
  }
});

// ---- TTS (Gnani Timbre proxy: auth + per-shop 60/min limit + strict body
// validation, so strangers can never consume Gnani credits) ----
const TTS_TEXT_MAX = 1000;
const TTS_FAIL_MSG = 'ధ్వని సిద్ధం కాలేదు, మళ్లీ ప్రయత్నించండి · speech service failed';
const TTS_TIMEOUT_MSG = 'ధ్వని సేవ సమయం ముగిసింది, మళ్లీ ప్రయత్నించండి · speech service timed out';
app.post('/api/tts', ttsApiLimiter, contentLength(8 * 1024), async (req, res) => {
  const t0 = Date.now();
  const ct = String(req.get('Content-Type') || '').toLowerCase();
  if (ct.indexOf('application/json') !== 0) {
    return res.status(415).json({ error: 'JSON అభ్యర్థన కావాలి · application/json required' });
  }
  const b = req.body;
  if (!b || typeof b !== 'object' || Array.isArray(b)) {
    return res.status(400).json({ error: 'సరైన అభ్యర్థన నిర్మాణం కాదు · invalid request body' });
  }
  if (typeof b.text !== 'string') {
    return res.status(400).json({ error: 'టెక్స్ట్ పాఠ్యంగా ఉండాలి · text must be a string' });
  }
  if (!b.text.trim()) {
    return res.status(400).json({ error: 'టెక్స్ట్ ఖాలీగా ఉంది · text is empty' });
  }
  if (b.text.length > TTS_TEXT_MAX) {
    return res.status(400).json({
      error: `టెక్స్ట్ ${TTS_TEXT_MAX} అక్షరాల లోపల ఉండాలి · max ${TTS_TEXT_MAX} characters`,
    });
  }
  // read-through sentence cache (see sentenceAudio): repeated sentences hit the
  // local cache instead of the upstream TTS, avoiding 429 rate-limit 502s
  const out = await sentenceAudio(b.text.trim());
  if (!out.ok) {
    console.error('[tts] id=' + req.id + ' upstream ' + out.kind + (out.status ? ' status=' + out.status : '') + ' ms=' + (Date.now() - t0));
    return res.status(out.kind === 'timeout' ? 504 : 502)
      .json({ error: out.kind === 'timeout' ? TTS_TIMEOUT_MSG : TTS_FAIL_MSG });
  }
  console.log('[tts] id=' + req.id + (out.cached ? ' cache=hit' : ' upstream=200') + ' bytes=' + out.buffer.length + ' ms=' + (Date.now() - t0));
  res.type('audio/wav').send(out.buffer);
});

// ---- LEDGER (all scoped to the session shop; business-type gated) ----
app.get('/api/customers', requireBizType, async (req, res) => {
  try {
    const [c, t] = await Promise.all([
      db().from('customers').select('id, name, label, phone, aliases, kind, village, credit_limit, promise_date, created_at')
        .eq('shop_id', req.shop.id).order('name', { ascending: true }),
      db().from('transactions').select('customer_id, type, amount, created_at, status, ack_status')
        .eq('shop_id', req.shop.id),
    ]);
    if (c.error) throw c.error;
    if (t.error) throw t.error;
    // balance, last_activity, last_payment_at (latest 'pay' transaction or null)
    const map = new Map((c.data || []).map(row => [row.id, { ...row, balance: 0, last_activity: null, last_payment_at: null }]));
    for (const tx of (t.data || [])) {
      const cust = map.get(tx.customer_id);
      if (!cust) continue;
      // disputed-entry badge feed: any LIVE disputed entry on the account
      if (tx.ack_status === 'disputed' && tx.status === 'posted') cust.disputed = true;
      const amt = Number(tx.amount) || 0;
      cust.balance += tx.type === 'credit' ? amt : -amt; // balance = credit - pay
      if (!cust.last_activity || new Date(tx.created_at) > new Date(cust.last_activity)) cust.last_activity = tx.created_at;
      if (tx.type === 'pay' && (!cust.last_payment_at || new Date(tx.created_at) > new Date(cust.last_payment_at))) {
        cust.last_payment_at = tx.created_at;
      }
    }
    res.json([...map.values()]);
  } catch (e) { fail(res, e, 'customers/get'); }
});

app.post('/api/customers', requireBizType, async (req, res) => {
  const b = req.body || {};
  const name = String(b.name == null ? '' : b.name).trim().replace(/\s+/g, ' ');
  const label = b.label != null && String(b.label).trim() !== '' ? String(b.label).trim() : null;
  const phone = b.phone != null && String(b.phone).trim() !== '' ? String(b.phone).trim() : null;
  // each business type creates exactly its own kind of counterparty: kirana
  // -> kind='customer', rythu -> kind='farmer'. Asking for the other kind is
  // a 403, and the default is derived server-side (never from the client).
  const kind = bt.kindOf(req.shop.business_type);
  if (b.kind != null && b.kind !== kind) return res.status(403).json({ ...BIZ_MISMATCH });
  const village = b.village != null && String(b.village).trim() !== ''
    ? String(b.village).trim().slice(0, 60) : null;
  if (!name) return res.status(400).json({ error: 'కస్టమర్ పేరు తప్పనిసరి' });
  if (name.length > 100) return res.status(400).json({ error: 'పేరు చాలా పొడవుగా ఉంది' });
  if (label && label.length > 60) return res.status(400).json({ error: 'లేబుల్ చాలా పొడవుగా ఉంది' });
  if (phone && !/^[+0-9]{7,15}$/.test(phone)) return res.status(400).json({ error: 'ఫోన్ నంబర్ సరిలేదు' });
  // optional opening balance from the paper notebook (a VALIDATED amount; the
  // ledger row is posted AFTER the account exists and is reversible like any row)
  let openingPaise = null;
  if (b.opening_balance != null && String(b.opening_balance).trim() !== '') {
    try {
      openingPaise = money.toPaise(b.opening_balance);
    } catch (e) {
      if (e && e.name === 'MoneyError') return res.status(400).json({ error: 'ఓపెనింగ్ బ్యాలెన్స్ సరికాదు' });
      throw e;
    }
    if (!(openingPaise > 0)) return res.status(400).json({ error: 'ఓపెనింగ్ బ్యాలెన్స్ సరికాదు' });
  }
  try {
    const { data, error } = await db().from('customers').insert({
      shop_id: req.shop.id, name, label, phone, kind, village,
      aliases: [], created_at: new Date().toISOString(),
    }).select('id, name, label, phone, aliases, kind, village, created_at').single();
    if (error) throw error;
    let openingPosted = false;
    if (openingPaise != null) {
      // kirana: they owed you at book-start (credit / receivable). rythu: you
      // had already paid them (pay / payable — an advance to recover).
      const opening = {
        customer_id: data.id,
        type: kind === 'farmer' ? 'pay' : 'credit',
        amount: money.paiseToRupees(openingPaise),
        workflow: bt.workflowOf(req.shop.business_type),
        direction: kind === 'farmer' ? 'payable' : 'receivable',
        event: 'opening_balance',
        note: 'పాత బాకీ / ఓపెనింగ్ · Opening balance',
        payment_mode: 'cash',
        source: 'screen',
        idempotency_key: 'opening:' + data.id + ':' + Date.now(),
      };
      try {
        const posted = await ledger.postTransactions(req.shop.id, [opening]);
        openingPosted = !!(posted && posted.length && !posted[0].dedup);
      } catch (le) {
        // the account exists; never 500 the create because the opening row
        // glitched — surface it so the UI can prompt a retry
        console.error('opening-balance post failed', le.code || 'DB');
      }
    }
    res.status(201).json({ ...data, balance: 0, last_activity: null, opening_posted: openingPosted });
  } catch (e) { fail(res, e, 'customers/post'); }
});

// ---- two-step voice save, step 2: the actual post (idempotent) ----
// The client first previews via POST /api/voice/propose (this route writes
// nothing) and then confirms here with the idempotency key from the preview.
// Retrying the same key can never create a second row (shop_id+key unique).
app.post('/api/transactions', requireBizType, async (req, res) => {
  const b = req.body || {};
  try {
    const row = {
      customer_id: b.customer_id, type: b.type, amount: b.amount,
      workflow: b.workflow === 'rythu' || b.workflow === 'dairy' ? b.workflow : 'kirana',
      // rythu buys produce: the farmer account is always direction='payable'
      direction: b.direction === 'payable' ? 'payable'
        : b.workflow === 'rythu' ? 'payable' : 'receivable',
      event: b.event, note: b.note, reason: b.reason, payment_mode: b.payment_mode,
      produce: b.produce,
      deduction_category: b.deduction_category,
      quantity: b.quantity, rate: b.rate, unit: b.unit, rate_unit: b.rate_unit,
      bag_kg: b.bag_kg,                       // rythu only: bag weight for the amount math
      settlement_id: b.settlement_id,         // rythu only: explicit settlement choice
      allow_advance: b.allow_advance === true, // rythu only: "record excess as advance"
      raw_transcript: b.raw_transcript,
      // the preview's key keeps confirm/retry consistent; a missing key still
      // gets one so a disconnected double-tap can never double-post
      idempotency_key: typeof b.idempotency_key === 'string' && b.idempotency_key
        ? b.idempotency_key : crypto.randomUUID(),
      source: b.source === 'screen' ? 'screen' : 'voice',
    };
    // business-type separation on the ledger itself: a kirana shop can never
    // post rythu/dairy rows and a rythu shop can never post kirana rows
    if (row.workflow !== bt.workflowOf(req.shop.business_type)) {
      return res.status(403).json({ ...BIZ_MISMATCH });
    }
    const out = await ledger.postTransactions(req.shop.id, [row]);
    const posted = out && out[0];
    if (!posted) throw Object.assign(new Error('no row'), { code: 'LEDGER_RPC' });
    res.status(201).json({ ...posted, dedup: !!posted.dedup });
  } catch (e) { ledgerFail(res, e, 'transactions/post'); }
});

// ---- reverse: undo a mistake with ONE offsetting row (never a hard delete) ----
app.post('/api/transactions/:id/reverse', requireBizType, async (req, res) => {
  const reason = String((req.body || {}).reason == null ? '' : (req.body || {}).reason).trim();
  if (!reason) return res.status(400).json({ error: 'రద్దు కారణం తప్పనిసరి · reason required' });
  try {
    const r = await ledger.reverseTransaction(req.shop.id, String(req.params.id), reason);
    res.json(r);
  } catch (e) { ledgerFail(res, e, 'transactions/reverse'); }
});

// ---- propose: creates NOTHING. Preview the parsed candidate, missing fields,
// balance before/after and the confirm idempotency key — then the client POSTs
// /api/transactions with that key to actually save. Editable transcript is
// re-proposed (debounced) by the client; each propose may mint a fresh key.
// separators: ",", " and ", " aur ", " mariyu ", "మరియు", "ఔరు", "తరువాత"
// (comma must be followed by whitespace so "1,000" stays one amount)
function splitTranscript(raw) {
  const SEP = /\s*,\s+|,\s*$|\s+and\s+|\s+aur\s+|\s+mariyu\s+|\s+మరియు\s+|\s+ఔరు?\s+|\s+తరువాత\s+/gi;
  return String(raw || '').split(SEP).map(s => s.trim()).filter(Boolean);
}
// later parts inherit only type/name context from the previous part;
// the amount always comes from the part itself (never copied)
function buildEntries(parts) {
  const out = [];
  let prev = null;
  for (const part of parts) {
    let parsed;
    try { parsed = parseVoice(part); } catch (_) { continue; }
    const type = parsed.type === 'query' ? null : parsed.type;
    const name = parsed.name || (prev && prev.name);
    const entryType = type || (prev && prev.type);
    const amount = parsed.amount;
    if (!amount || !entryType || !name) continue;
    const e = { type: entryType, amount, name, raw: part };
    out.push(e); prev = e;
  }
  return out;
}
// rythu parts inherit only farmer/produce context between parts; each part
// carries its own numbers (same rule as kirana's buildEntries)
// preview-text money format (Indian digit grouping: 1,10,000)
function fmtRupees(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v.toLocaleString('en-IN') : '?';
}
function buildRythuEntries(parts, roster) {
  const out = [];
  let prev = null;
  for (const part of parts) {
    let p;
    try { p = parseRythu(part); } catch (_) { continue; }
    if (!p.event) continue;
    // a later part may omit the farmer name -> inherits from the previous part
    p.farmer = p.farmer || (prev && prev.farmer);
    if (p.event === 'delivery') p.produce = p.produce || (prev && prev.produce);
    const m = resolveName(p.farmer || '', roster);
    const status = m.status;
    const candidates = (m.candidates || []).slice(0, 5).map(x => ({ id: x.id, name: x.name }));
    const customerId = status === 'one' && candidates[0] ? candidates[0].id : null;
    const missing = [...(p.missing || [])];
    if (p.farmer && !customerId) {
      missing.push(status === 'many' || status === 'fuzzy' ? 'CUSTOMER_AMBIGUOUS' : 'CUSTOMER_UNKNOWN');
    }
    out.push({
      event: p.event, name: p.farmer, transcript: part,
      produce: p.produce, quantity: p.quantity, unit: p.unit,
      bag_kg: p.bagKg, rate: p.rate, rateUnit: p.rateUnit,
      amount: p.amount, category: p.category,
      customer_id: customerId, status, candidates,
      idempotency_key: crypto.randomUUID(), missing, warnings: [],
    });
    prev = p;
  }
  return out;
}

app.post('/api/voice/propose', requireBizType, async (req, res) => {
  const b = req.body || {};
  if (typeof b.transcript !== 'string' || !b.transcript.trim()) {
    return res.status(400).json({ error: 'మాట లేదు · transcript required' });
  }
  if (b.transcript.length > 2000) {
    return res.status(400).json({ error: 'వాక్యం చాలా పొడవుగా ఉంది · sentence too long' });
  }
  try {
    // the workflow comes from the SHOP's business type — any client-supplied
    // workflow is ignored, so one shop can never parse as the other type
    const wf = bt.workflowOf(req.shop.business_type);
    if (wf === 'rythu') {
      // -- rythu: resolution runs against kind='farmer' ONLY so the same name
      // in the two modes never collides --
      const customers = await db().from('customers')
        .select('id, name, village, aliases').eq('shop_id', req.shop.id).eq('kind', 'farmer');
      if (customers.error) throw customers.error;
      const roster = (customers.data || []).map(c => ({ ...c, label: c.village || null }));
      const parts = splitTranscript(b.transcript).slice(0, 10);
      const entries = buildRythuEntries(parts, roster);
      if (!entries.length) {
        return res.json({
          workflow: 'rythu', candidate: [], missingFields: ['EVENT'],
          ambiguities: [], previewText: '', balanceBefore: 0, balanceAfter: 0,
        });
      }
      // per-entry preview + open-settlement hint for cash events
      for (const e of entries) {
        if (!e.customer_id || !e.event || e.event === 'delivery') continue;
        const open = await ledger.openRythuSettlements(e.customer_id);
        e.settlement_hint = open.length === 1 ? open[0].settlement_id
          : open.length > 1 ? 'CHOOSE' : null;
        // payments beyond the sole settlement's remaining are forewarned (409
        // comes from the save unless the user confirms "record as advance")
        if (e.event === 'payment' && e.settlement_hint && e.settlement_hint !== 'CHOOSE' &&
            e.amount != null) {
          const rem = await ledger.settlementRemaining(e.settlement_hint);
          if (Math.round(e.amount * 100) > rem) e.warnings.push('OVERPAYMENT');
        }
      }
      const missingFields = [...new Set(entries.flatMap(x => x.missing))];
      const ambiguities = entries
        .filter(x => x.status === 'many' || x.status === 'fuzzy' || x.status === 'none')
        .map(x => ({ name: x.name, status: x.status, options: x.candidates }));
      const focus = entries.find(x => x.customer_id);
      let balanceBefore = 0;
      if (focus) balanceBefore = (await ledger.balance(focus.customer_id, 'payable')).rupees;
      const previewText = entries.map(e => {
        const who = e.name || '—';
        if (e.event === 'delivery') {
          const q = e.quantity != null ? `${e.quantity} ${e.unit || ''}`.trim() : '?';
          const prod = e.produce || '?';
          const r = e.rate != null ? `₹${fmtRupees(e.rate)}/${e.rateUnit || ''}`.trim() : '';
          const a = e.amount != null ? ` = ₹${fmtRupees(e.amount)}` : '';
          return `${who}: ${q} ${prod} ${r}${a}`;
        }
        if (e.event === 'advance') return `${who} అడ్వాన్స్ ₹${e.amount != null ? fmtRupees(e.amount) : '?'}`;
        if (e.event === 'deduction') {
          return `${who} ${e.category || ''} తగ్గింపు ₹${e.amount != null ? fmtRupees(e.amount) : '?'}`;
        }
        if (e.event === 'payment') return `${who} చెల్లింపు ₹${e.amount != null ? fmtRupees(e.amount) : '?'}`;

        return `${who}: ?`;
      }).join(' · ');
      return res.json({
        workflow: 'rythu', candidate: entries, missingFields, ambiguities,
        previewText, balanceBefore, balanceAfter: balanceBefore,
      });
    }
    const customers = await db().from('customers')
      .select('id, name, label, phone, aliases').eq('shop_id', req.shop.id);
    if (customers.error) throw customers.error;
    const roster = customers.data || [];
    const parts = splitTranscript(b.transcript).slice(0, 10);
    const parsed = buildEntries(parts);
    if (!parsed.length) {
      return res.json({
        candidate: [], missingFields: ['TRANSCRIPT'], ambiguities: [],
        previewText: '', balanceBefore: 0, balanceAfter: 0,
      });
    }
    const entries = parsed.map(e => {
      const key = crypto.randomUUID();
      let status = 'none', candidates = [], customerId = null;
      const m = resolveName(e.name, roster);
      status = m.status; candidates = (m.candidates || []).slice(0, 5).map(x => ({ id: x.id, name: x.name }));
      if (status === 'one' && candidates[0]) customerId = candidates[0].id;
      // (an ambiguous/unresolved name reads as a missing field; the client's
      // chooser or new-customer flow resolves it, the save enforces ownership)
      const missing = [];
      if (!customerId) missing.push(status === 'many' || status === 'fuzzy' ? 'CUSTOMER_AMBIGUOUS' : 'CUSTOMER_UNKNOWN');
      if (e.amount == null) missing.push('AMOUNT'); // parser always fills; defensive
      return {
        type: e.type, amount: e.amount, name: e.name, transcript: e.raw,
        customer_id: customerId, status, candidates,
        idempotency_key: key, missing, warnings: [], dedup: false,
      };
    });
    const missingFields = [...new Set(entries.flatMap(x => x.missing))];
    const ambiguities = entries
      .filter(x => x.status === 'many' || x.status === 'fuzzy' || x.status === 'none')
      .map(x => ({ name: x.name, status: x.status, options: x.candidates }));

    // balance for the customer this batch touches (first matched entry wins)
    const focus = entries.find(x => x.customer_id);
    let balanceBefore = 0;
    if (focus) {
      const bal = await ledger.balance(focus.customer_id, 'receivable');
      balanceBefore = bal.rupees;
    }
    const previewText = entries
      .map(e => `${e.name} ₹${String(e.amount)} ${e.type === 'credit' ? 'ఉద్దెర' : 'జమ'}`)
      .join(' · ');
    // kirana overpayment forewarning: the save itself will hard-reject with 409
    if (focus && entries.length === 1 && entries[0].type === 'pay' && Number(entries[0].amount) > Number(balanceBefore)) {
      entries[0].warnings.push('OVERPAYMENT');
    }
    res.json({
      candidate: entries, missingFields, ambiguities, previewText,
      balanceBefore, balanceAfter: balanceBefore, // recomputed client-side per edit
    });
  } catch (e) { fail(res, e, 'voice/propose'); }
});

// ---- customer helpers: every id from the client is re-checked against THIS shop ----
const CUST_COLS = 'id, name, label, phone, aliases, kind, village, credit_limit, promise_date, created_at';
async function ownCustomer(req, id) {
  const { data, error } = await db().from('customers').select(CUST_COLS)
    .eq('id', String(id == null ? '' : id)).eq('shop_id', req.shop.id).limit(1);
  if (error) throw error;
  return (data && data[0]) || null;
}
const squeeze = v => String(v == null ? '' : v).trim().replace(/\s+/g, ' ');

// PATCH /api/customers/:id — edit name / label / phone / aliases / village.
// kind is intentionally NOT settable here — mode flips only at creation.
app.patch('/api/customers/:id', requireBizType, async (req, res) => {
  const b = req.body || {};
  try {
    const cur = await ownCustomer(req, req.params.id);
    if (!cur) return res.status(404).json({ error: 'కస్టమర్ దొరకలేదు' });
    const upd = {};
    if (b.name !== undefined) {
      const n = squeeze(b.name);
      if (!n) return res.status(400).json({ error: 'కస్టమర్ పేరు తప్పనిసరి' });
      if (n.length > 100) return res.status(400).json({ error: 'పేరు చాలా పొడవుగా ఉంది' });
      upd.name = n;
    }
    if (b.label !== undefined) {
      const l = squeeze(b.label);
      if (l.length > 60) return res.status(400).json({ error: 'లేబుల్ చాలా పొడవుగా ఉంది' });
      upd.label = l || null;
    }
    if (b.phone !== undefined) {
      const p = squeeze(b.phone);
      if (p && !/^[+0-9]{7,15}$/.test(p)) return res.status(400).json({ error: 'ఫోన్ నంబర్ సరిలేదు' });
      upd.phone = p || null;
    }
    if (b.aliases !== undefined) {
      if (!Array.isArray(b.aliases)) return res.status(400).json({ error: 'మారుపేర్లు జాబితాలో ఉండాలి' });
      const seen = new Set([squeeze(cur.name).toLowerCase()]);
      upd.aliases = [];
      for (const a of b.aliases) {
        const s = squeeze(a);
        const k = s.toLowerCase();
        if (!s || s.length > 100 || seen.has(k)) continue;
        seen.add(k);
        upd.aliases.push(s);
        if (upd.aliases.length >= 20) break;
      }
    }
    if (b.village !== undefined) {
      const v = squeeze(b.village);
      if (v.length > 60) return res.status(400).json({ error: 'గ్రామం పేరు చాలా పొడవుగా ఉంది' });
      upd.village = v || null;
    }
    // kirana credit discipline: credit_limit (amount, null clears it)
    if (b.credit_limit !== undefined) {
      if (b.credit_limit === null || b.credit_limit === '') upd.credit_limit = null;
      else {
        let p; try { p = money.toPaise(b.credit_limit); } catch (e) { p = null; }
        if (p == null || !(p >= 0)) return res.status(400).json({ error: 'క్రెడిట్ లిమిట్ సరికాదు' });
        upd.credit_limit = money.paiseToRupees(p);
      }
    }
    // promise date (YYYY-MM-DD, null clears it); other business types may set
    // nothing here — they simply never send the field
    if (b.promise_date !== undefined) {
      if (b.promise_date === null || b.promise_date === '') upd.promise_date = null;
      else if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.promise_date))) {
        return res.status(400).json({ error: 'తేదీ సరిలేదు (YYYY-MM-DD)' });
      } else upd.promise_date = String(b.promise_date);
    }
    if (!Object.keys(upd).length) return res.status(400).json({ error: 'మార్పు ఏమీ లేదు' });
    const { data, error } = await db().from('customers').update(upd)
      .eq('id', cur.id).eq('shop_id', req.shop.id).select(CUST_COLS).single();
    if (error) throw error;
    res.json(data);
  } catch (e) { fail(res, e, 'customers/patch'); }
});

// POST /api/customers/merge — move remove_id's transactions onto keep_id, then delete it
app.post('/api/customers/merge', requireBizType, async (req, res) => {
  const b = req.body || {};
  const keepId = String(b.keep_id || ''), removeId = String(b.remove_id || '');
  if (!keepId || !removeId) return res.status(400).json({ error: 'రెండు కస్టమర్ల ఐడీలు కావాలి' });
  if (keepId === removeId) return res.status(400).json({ error: 'ఒకే కస్టమర్‌ని కలపలేము' });
  try {
    const [keep, remove] = await Promise.all([ownCustomer(req, keepId), ownCustomer(req, removeId)]);
    if (!keep || !remove) return res.status(404).json({ error: 'కస్టమర్ దొరకలేదు' });
    const { error: e1 } = await db().from('transactions').update({ customer_id: keep.id })
      .eq('shop_id', req.shop.id).eq('customer_id', remove.id);
    if (e1) throw e1;
    // removed name + aliases become aliases of the kept customer (deduped, capped)
    const seen = new Set([squeeze(keep.name).toLowerCase()]);
    const aliases = [];
    for (const a of [...(keep.aliases || []), remove.name, ...(remove.aliases || [])]) {
      const s = squeeze(a), k = s.toLowerCase();
      if (!s || s.length > 100 || seen.has(k)) continue;
      seen.add(k); aliases.push(s);
      if (aliases.length >= 20) break;
    }
    const { error: e2 } = await db().from('customers').update({ aliases }).eq('id', keep.id).eq('shop_id', req.shop.id);
    if (e2) throw e2;
    const { error: e3 } = await db().from('customers').delete().eq('id', remove.id).eq('shop_id', req.shop.id);
    if (e3) throw e3;
    const customer = await ownCustomer(req, keep.id);
    res.json({ ok: true, customer });
  } catch (e) { fail(res, e, 'customers/merge'); }
});

// GET /api/customers/:id/transactions — that customer's entries, newest first
app.get('/api/customers/:id/transactions', requireBizType, async (req, res) => {
  try {
    const c = await ownCustomer(req, req.params.id);
    if (!c) return res.status(404).json({ error: 'కస్టమర్ దొరకలేదు' });
    const { data, error } = await db().from('transactions')
      .select('id, customer_id, type, amount, raw_transcript, created_at, event, workflow, direction, status, reverses_id, reason, payment_mode, ack_status')
      .eq('shop_id', req.shop.id).eq('customer_id', c.id)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ customer: c, transactions: data || [] });
  } catch (e) { fail(res, e, 'customers/tx'); }
});

// DELETE /api/transactions/:id — RETIRED in sprint 1: ledger rows are financial
// records and are never hard-deleted. The replacement is
// POST /api/transactions/:id/reverse { reason }, which writes one offsetting
// row and marks the original reversed (audit-safe). The old today-IST-only
// delete would silently vanish history; clients get 410 Gone.
app.delete('/api/transactions/:id', (req, res) => {
  res.status(410).json({
    error: 'నమోదును తొలగించడం ఇప్పుడు లేదు — బదులుగా రద్దు (reverse) వాడండి · entries can no longer be deleted; use reverse',
  });
});

// date interpreted in Asia/Kolkata (UTC+5:30)
const istOffsetMs = (5 * 60 + 30) * 60 * 1000;
const istToday = () => new Date(Date.now() + istOffsetMs).toISOString().slice(0, 10);
// IST day boundaries (UTC) for YYYY-MM-DD, or null when the date is invalid
function istDayRange(date) {
  const [y, m, d] = String(date).split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null;
  const start = new Date(probe.getTime() - istOffsetMs);           // IST midnight -> UTC
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}

app.get('/api/transactions', requireBizType, async (req, res) => {
  // ?recent=N -> the shop's last N entries across all days (Home screen)
  if (req.query.recent !== undefined) {
    const n = parseInt(String(req.query.recent), 10);
    if (!Number.isInteger(n) || n < 1 || n > 50) return res.status(400).json({ error: 'recent 1-50 మధ్య ఉండాలి' });
    try {
      const [t, c] = await Promise.all([
        db().from('transactions').select('id, customer_id, type, amount, raw_transcript, created_at')
          .eq('shop_id', req.shop.id).order('created_at', { ascending: false }).limit(n),
        db().from('customers').select('id, name').eq('shop_id', req.shop.id),
      ]);
      if (t.error) throw t.error;
      if (c.error) throw c.error;
      const names = new Map((c.data || []).map(x => [x.id, x.name]));
      return res.json({ transactions: (t.data || []).map(x => ({ ...x, customer_name: names.get(x.customer_id) || null })) });
    } catch (e) { return fail(res, e, 'transactions/recent'); }
  }
  let date = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : istToday();
  const range = istDayRange(date);
  if (!range) return res.status(400).json({ error: 'తేదీ సరిలేదు (YYYY-MM-DD)' });
  const { start, end } = range;
  try {
    const [t, c] = await Promise.all([
      db().from('transactions').select('id, customer_id, type, amount, raw_transcript, created_at')
        .eq('shop_id', req.shop.id)
        .gte('created_at', start.toISOString()).lt('created_at', end.toISOString())
        .order('created_at', { ascending: false }),
      db().from('customers').select('id, name').eq('shop_id', req.shop.id),
    ]);
    if (t.error) throw t.error;
    if (c.error) throw c.error;
    const names = new Map((c.data || []).map(x => [x.id, x.name]));
    // opening_balance is book-start history, not a today entry — it lives in
    // the statement, never in the day's entry list/counts
    const transactions = (t.data || [])
      .filter(x => x.event !== 'opening_balance')
      .map(x => ({ ...x, customer_name: names.get(x.customer_id) || null }));
    res.json({ date, transactions });
  } catch (e) { fail(res, e, 'transactions/get'); }
});

// ---------------- RYTHU (produce-buyer) ROUTES ----------------
// Farmers are customers with kind='farmer'. Every route is session-shop-scoped
// through the ledger; summaries are computed on read, never stored.

// GET /api/rythu/farmers — the rythu customer list (rythu shops only)
app.get('/api/rythu/farmers', rythuOnly, async (req, res) => {
  try {
    res.json({ farmers: await ledger.rythuFarmers(req.shop.id) });
  } catch (e) { ledgerFail(res, e, 'rythu/farmers'); }
});

// GET /api/rythu/farmers/:id/settlements — settlement cards + unallocated list
app.get('/api/rythu/farmers/:id/settlements', rythuOnly, async (req, res) => {
  try {
    res.json(await ledger.farmerSettlements(req.shop.id, String(req.params.id)));
  } catch (e) { ledgerFail(res, e, 'rythu/settlements'); }
});

// GET /api/rythu/summary — the rythu Home strip for one IST day
app.get('/api/rythu/summary', rythuOnly, async (req, res) => {
  const day = typeof req.query.date === 'string' && req.query.date ? req.query.date : undefined;
  try {
    res.json(await ledger.rythuSummary(req.shop.id, day));
  } catch (e) { ledgerFail(res, e, 'rythu/summary'); }
});

// POST /api/transactions/:id/allocate { settlement_id } — apply an unallocated
// advance/deduction/payment to a settlement (null -> id, the only linkage move)
app.post('/api/transactions/:id/allocate', rythuOnly, async (req, res) => {
  const settlementId = (req.body || {}).settlement_id;
  if (!settlementId) return res.status(400).json({ error: 'సెటిల్‌మెంట్ ఎంపిక తప్పనిసరి · settlement required' });
  try {
    res.json(await ledger.allocateToSettlement(req.shop.id, String(req.params.id), String(settlementId)));
  } catch (e) { ledgerFail(res, e, 'transactions/allocate'); }
});

// ---------------- STATEMENTS + EXPORT (Task 2) ----------------
const QUERY_DATE = v => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);

// GET /api/statements/customer/:id?from&to — ONE customer's date-windowed
// statement with running balance (kirana statement, rythu farmer ledger too)
app.get('/api/statements/customer/:id', requireBizType, async (req, res) => {
  try {
    res.json(await ledger.statementWindow(
      req.shop.id, String(req.params.id),
      QUERY_DATE(req.query.from), QUERY_DATE(req.query.to),
    ));
  } catch (e) { ledgerFail(res, e, 'statements/customer'); }
});

// GET /api/statements/settlement/:id — the aadhati పట్టీ (one settlement slip)
app.get('/api/statements/settlement/:id', rythuOnly, async (req, res) => {
  try {
    res.json(await ledger.settlementSlip(req.shop.id, String(req.params.id)));
  } catch (e) { ledgerFail(res, e, 'statements/settlement'); }
});

// GET /api/export/transactions.csv?from&to — shop-scoped CSV (Excel-safe BOM)
app.get('/api/export/transactions.csv', requireBizType, async (req, res) => {
  try {
    const out = await ledger.transactionsExport(
      req.shop.id, QUERY_DATE(req.query.from), QUERY_DATE(req.query.to),
    );
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="khata-vani-transactions-${istToday()}.csv"`);
    res.send(out.csv);
  } catch (e) { ledgerFail(res, e, 'export/transactions'); }
});

// ---------------------------------------------------------------------------
// Sprint 3 — shop-facing acknowledgement routes (requireAuth + shop-scoped).
// ack_status is a DB-guarded column (migration 003 trigger): the ONLY writers
// are ack-link (awaiting), the public response route (acknowledged/disputed),
// ack-resolve (resolved) and the reversal path (cancelled).
// ---------------------------------------------------------------------------

// POST /api/transactions/:id/ack-link — mint a fresh acknowledgement link for
// a credit row (goods_credit / produce_delivery only). Any previous ACTIVE
// link for the entry is revoked first; the response carries the raw token
// exactly ONCE. A Telugu summary is pre-synthesized (best-effort) into the
// disk cache keyed by the token hash.
app.post('/api/transactions/:id/ack-link', requireBizType, async (req, res) => {
  try {
    const { token, hash, tx } = await ack.createLink(req.shop.id, String(req.params.id));
    // the shareable URL: APP_ORIGIN first, fall back to the request's own host
    const origin = APP_ORIGIN || req.protocol + '://' + req.get('Host');
    const url = origin.replace(/\/+$/, '') + '/a/' + token;
    // pre-generate ONE Telugu audio of the entry summary, cached by the hash
    let shopName = '';
    try {
      const s = await db().from('shops').select('shop_name').eq('id', req.shop.id).limit(1);
      if (s && s.error) throw s.error;
      shopName = ((s.data || [])[0] || {}).shop_name || '';
    } catch (_) { /* shop name is cosmetic in the spoken summary */ }
    const audio = await pregenAckAudio(hash, ackSpokenText(tx, shopName));
    // QR is generated server-side; its encoded payload is exactly the URL
    const qrSvg = await QRCode.toString(url, {
      type: 'svg', margin: 1, errorCorrectionLevel: 'M', width: 512,
    });
    res.json({ url, qrSvg, audio });
  } catch (e) { ledgerFail(res, e, 'ack/link'); }
});

// POST /api/transactions/:id/ack-resolve { note? } — the SHOP closes a
// disputed acknowledgement as resolved (ack_status becomes 'resolved').
// Audited. The optional note is accepted for API clarity but has no storage
// column — the customer's dispute_note stays untouched.
app.post('/api/transactions/:id/ack-resolve', requireBizType, async (req, res) => {
  const note = String(((req.body || {}).note) == null ? '' : req.body.note).trim();
  if (note.length > 200) return res.status(400).json({ error: 'సందేశం చాలా పొడవు · note too long' });
  try {
    res.json(await ack.resolveDispute(req.shop.id, String(req.params.id)));
  } catch (e) { ledgerFail(res, e, 'ack/resolve'); }
});

// GET /api/acknowledgements/summary — counts of awaiting / acknowledged /
// disputed for this shop (dashboard strip).
app.get('/api/acknowledgements/summary', requireBizType, async (req, res) => {
  try {
    res.json(await ack.shopSummary(req.shop.id));
  } catch (e) { ledgerFail(res, e, 'ack/summary'); }
});

// GET /api/transactions/:id/ack — the shop reads ONE entry's acknowledgement
// detail (status + the customer's dispute note; a red chip shows it back)
app.get('/api/transactions/:id/ack', requireBizType, async (req, res) => {
  try {
    const info = await ack.info(req.shop.id, String(req.params.id));
    if (!info) return res.status(404).json({ error: 'ధృవీకరణ లేదు · no acknowledgement', code: 'NOT_FOUND' });
    res.json(info);
  } catch (e) { ledgerFail(res, e, 'ack/get'); }
});

// ---- startup: log configuration STATE only, never values ----
console.log('Gnani API key:', K ? 'configured' : 'MISSING', K === 'your_key_here' ? '(STILL THE PLACEHOLDER!)' : '');
console.log('Supabase:', sb ? 'configured' : 'NOT CONFIGURED (set SUPABASE_URL + key in .env)');

// unmatched /api routes -> JSON 404 (registered after every route)
app.use('/api', (req, res) => res.status(404).json({ error: 'రూట్ దొరకలేదు · route not found' }));
// last-resort error handler: JSON only, no stack traces, non-sensitive logging
app.use(errorHandler());

// listen only when run directly (tests require the app without binding a port)
if (require.main === module) {
  // ---- process-level safety net: log ONLY the error class + a request-less
  // id — never messages (they can carry PII) — and keep serving where safe.
  process.on('unhandledRejection', (e) => {
    console.error('[proc] unhandledRejection id=- err=' + ((e && (e.code || e.name)) || 'ERROR'));
  });
  process.on('uncaughtException', (e) => {
    console.error('[proc] uncaughtException id=- err=' + ((e && (e.code || e.name)) || 'ERROR'));
    // in-flight requests already answer via the generic error handler; do not
    // exit so a single bad async path cannot take the shop's khata offline
  });
  app.listen(PORT, () => console.log('Khata Vani on http://localhost:' + PORT));
}
module.exports = { app };



