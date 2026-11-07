# Khata Vani — Repository Inspection Report

**Inspection date:** 2026-11-04
**Inspector role:** read-only architecture / security / database / auth review
**Scope:** full local repository, hermetic tests only. **No source file, database row, environment value, dependency, or Git object was modified.**
**Companion documents:** `SECURITY-HARDENING.md` (written by the hardening pass, partially re-verified below), `PROJECT-DOCUMENTATION.md` (untracked, older; discrepancies flagged in §18).

---

## 1. Executive Summary

Khata Vani is a voice-first, Telugu-first kirana (credit-ledger) web app: Express 4 backend, vanilla-JS hash-routed SPA frontend, Supabase (Postgres via REST, service key server-side only) for persistence, and the Gnani AI vachana.ai gateway for STT (Prisma) and TTS (Timbre). Speech understanding is **not** an LLM — it is a deterministic rule-based parser (`public/parser.js`) plus a name resolver (`public/resolver.js`), both unit-tested in Node.

The repository is at the security-hardening commit (`a86e886`), which is verified present, is HEAD of `main`, and matches `origin/main`. The hardening pass added `security.js`, `test-security.js` (81 hermetic checks), strict CSP, per-shop STT/TTS limits, same-origin CSRF checks, log scrubbing, and production JWT-secret validation. **All 178 checks across four suites pass** (5 parser + 13 resolver + 81 security + 24 flow + 55 DOM).

Key findings:

- **The authentication system is complete for what it claims, and honest about what it does not claim**: phone → spoken-word challenge → 4-digit PIN → 30-day signed httpOnly JWT cookie. Challenges are single-use, 2-min TTL, server-memory-only, phone-bound `voiceOkToken` (5 min). The code explicitly and correctly documents that the voice challenge is **not** phone-ownership verification and **not** biometric human verification (L1 in `SECURITY-HARDENING.md`; comments in `server.js:94-104, 185-209`).
- **Shop-level multi-tenancy is enforced in code**: every ledger query filters `.eq('shop_id', req.shop.id)` and every client-supplied id is re-verified against the session shop (verified in all routes; regression-tested by the 38-check curl suite, which I did **not** re-run because it touches the live project).
- **Remaining structural weaknesses**: no server-side session revocation (R2), no phone-ownership OTP (R1), in-memory challenges/rate-limits (L3), non-atomic merge (R4), no daily voice-API spend quota (R5), PIN is 4 digits at bcrypt cost 10 (fine against online guessing with lockout+rate-limits; weak against an offline leak of `pin_hash`).
- **The proposed conversational-auth journey (Telugu voice onboarding → human verification → face scan → PIN → device-locked returning user) is feasible on the existing speech infrastructure** — the Gnani proxies, TTS cache, session issuance, PIN hashing/lockout, and the SPA shell are all reusable. Missing components are significant but additive: a conversation-state engine, an OTP provider (or equivalent phone proof), a liveness/bot-detection layer, and a face-scan stack (third-party biometric provider strongly recommended; the current CSP and `Permissions-Policy` **deliberately block camera** and would need a conscious change). See §11.
- **Rythu Khata is a good fit for the current data model**: it can be layered on as a new transaction *kind* dimension plus a couple of new tables, reusing shops/customers/transactions, the STT/TTS pipeline, parser/resolver, and the shop-isolation pattern. See §16.

Nothing was implemented. This report only documents.

---

## 2. Verified Repository State

All facts below verified at inspection time via `git`, filesystem reads, and test runs.

| Item | Verified value |
|---|---|
| Working directory | `C:\Users\Regala Chethan\OneDrive\Desktop\khata-vani\khata-vani` |
| Repo type | Git repo, single branch checked out |
| Current branch | `main` (only local branch) |
| Local HEAD | `a86e8860e46f11c705ee691cac40bd4268b155c2` |
| Security-hardening commit present? | **Yes** — HEAD *is* the hardening commit `a86e886` |
| Remote | `origin/main` = `a86e886…` — local is **up to date** with origin (neither ahead nor behind) |
| Modified / staged files | **None** |
| Untracked files | `PROJECT-DOCUMENTATION.md` only (pre-existing; never committed by design) |
| Full commit history (oldest→newest) | `a68bf17` initial commit → `4e2537b` working v0.1 → `5a0a733` phase A → `1095f59` before phase B → `4c9989e` phase B → `a86e886` security hardening (HEAD) |
| Hardening commit contents | `README.md` (+17/−), `SECURITY-HARDENING.md` (new, 270 lines), `package.json` (test script only), `security.js` (new), `server.js` (+213/−), `test-security.js` (new) — verified via `git show --stat HEAD` |
| Changes after the hardening commit | **None** — HEAD is the last commit; working tree has zero tracked-file diffs |
| `.env` | Present on disk (617 bytes, not read), gitignored, untouched. `.env.example` committed with placeholder values only |
| gitignored `data/` | Exists on disk; contains `tts-cache/*.wav` (≈20 real cached word WAVs), `kv-schema.js`, `kv-ids.json`, `kv-flow-test.js`, `kv-fixture.js`, `kv-dom-test.js`, `kv-curl.ps1`. No `.jar` cookie files present (i.e., the curl fixture is currently in a *cleaned* state). Contents inspected, nothing modified |
| Supabase / Gnani access | **None performed.** No network call to either service was made during this inspection |

### Documentation vs. reality check
- `SECURITY-HARDENING.md` is **accurate** against the code on every claim I re-verified (§12); it correctly self-declares its L1–L8 limitations and R1–R8 unrealised risks.
- `PROJECT-DOCUMENTATION.md` (older, untracked, pre-hardening) is mostly accurate but contains stale/duplicated claims: it says "server logs only whether a key is configured **and its length**" (§9.1 / §10) — the key-length log was **removed** in the hardening pass (`server.js:677` logs only `"configured" | "MISSING"`); §4 lists `app.js` at 1307 lines (actual 1343) and `server.js` at 522 lines (actual 692). It also still shows `4c9989e` as HEAD and omits `security.js`/`test-security.js`/`SECURITY-HARDENING.md` from the structure tree. Its schema section is honestly labelled "inferred from the queries in server.js" — same caveat applies here (§13).

---

## 3. Current Project Structure (actual, discovered)

```
khata-vani/
├── server.js                   692 lines  Express app: security chain, auth, STT/TTS proxy, ledger API
├── security.js                 158 lines  Reusable security middleware (requestId, headers, CSRF, errors, JWT checks)
├── test-security.js            369 lines  81-check hermetic security suite (mocked Gnani, no DB)
├── test-parser.js               21 lines  5 parser unit cases
├── test-resolver.js             53 lines  13 resolver unit cases + edge case
├── package.json                            v0.2.0, type=commonjs, scripts: start / test
├── package-lock.json                       untouched by hardening (verified claim)
├── README.md                                quick start, tests, security summary, Phase B list
├── SECURITY-HARDENING.md                    hardening report (270 lines)
├── PROJECT-DOCUMENTATION.md                 untracked; older; pre-hardening claims (see §2)
├── .env.example                             template (placeholders only)
├── .gitignore                               .env, node_modules/, data/, data/tts-cache/, *.log
├── .env                                     (gitignored, present, NOT read)
├── public/
│   ├── index.html                20 lines  shell: font links, styles, 4 same-origin script tags
│   ├── styles.css               396 lines  design system (mobile-first, ≥48px targets)
│   ├── api.js                    41 lines  api() JSON + apiAudio() blob fetch wrappers
│   ├── app.js                  1343 lines  router, 9 views, voice pipeline, flows, queries
│   ├── parser.js                 89 lines  rule-based transcript → {name, amount, type}
│   └── resolver.js              108 lines  customer-name resolution (exact/label/alias/fuzzy)
├── data/                        (gitignored)
│   ├── tts-cache/*.wav                     ~20 sha1-named cached challenge-word WAVs
│   ├── kv-schema.js            16 lines    one-off column printer (connects to Supabase when run — NOT run)
│   ├── kv-fixture.js          123 lines    creates/deletes ZZTest Shop A/B rows (NOT run)
│   ├── kv-curl.ps1            127 lines    38-check live-API suite (NOT run)
│   ├── kv-flow-test.js         83 lines    24-check flow harness (pure logic — run ✅)
│   ├── kv-dom-test.js         246 lines    55-check jsdom harness with mocked api (run ✅)
│   └── kv-ids.json                         fixture ids from the last cleanup
└── node_modules/                           installed (never touched)
```

There are **no SQL files, no migrations, no ORM schemas, no RPC definitions** anywhere in the repo. There is **no authentication-specific directory**; auth lives inside `server.js` + `public/app.js` as detailed in §10. There is **no server-side sessions table, no RevocationStore, no OTP code** anywhere.

---

## 4. File-by-File Architecture

### 4.1 `server.js` — the entire backend
- **Purpose:** single-file Express app exposing the complete API; proxies Gnani STT/TTS; owns all Supabase access, session issuance, challenge state, rate limits.
- **Exports:** `{ app }` (line 689). Server binds a port only when `require.main === module` (686–688) — this is what makes the security suite hermetic (it requires `app` and listens on an ephemeral port).
- **Internal structure (line numbers verified):**
  - 1–42: env/config, JWT secret validation, optional `TRUST_PROXY`, Supabase client creation (`SUPABASE_SERVICE_KEY` or the newer `SUPABASE_SECRET_KEY`), `db()` guard that throws `NO_SUPA` → HTTP 503.
  - 46–51: `fail(res, e, ctx)` — shared error responder: Telugu message to client; log line contains only route + request id + `e.code || e.name`.
  - 53–57: `CACHE_DIR` = `data/tts-cache` (override env `TTS_CACHE_DIR` used by tests).
  - 59–77: middleware chain **in order**: `app.disable('x-powered-by')` → `requestId` → `securityHeaders({production})` → `sameOrigin({allowedOrigins: APP_ORIGIN})` → `express.static('public')` → custom pre-parser guard rejecting non-`audio/*` POSTs to `/api/stt` with 415 → `express.json({limit:'64kb'})` → `cookieParser(JWT_SECRET)` (signed cookies).
  - 79–81: validators `validPhone` (`^[6-9]\d{9}$`), `validPin` (`^\d{4}$`).
  - 83–104: `setSession()` signs JWT `{shopId, phone}` exp 30d into cookie `session` (httpOnly, signed, sameSite=lax, secure in prod, maxAge 30d); `clearSession()`; `voiceOkPhone(token, phone)` verifies purpose `voiceOk` + matching phone.
  - 106–125: rate limiters — 30/15min per IP for start/challenge/signup; 30/15min keyed `ip|phone` for answer/login; 60/min per IP for challenge audio; **60/min keyed `ip|shopId` separately for STT (`shopApiLimiter`) and TTS (`ttsApiLimiter`)**. All limiters use `ipKeyGenerator(req.ip)` so IPv6 keys work.
  - 127–175: `gnaniTts(text)` — POST `https://api.vachana.ai/api/v1/tts/inference` with `X-API-Key-ID`, body `{text, voice: TTS_VOICE||'Nalini', model: TTS_MODEL||'timbre-v2.5', language: TTS_LANG||'te-IN', speed:1.0, audio_config:{24000Hz, mono, 16-bit, linear_pcm, wav}}`, `AbortSignal.timeout(15000)`. Returns `{ok:false, kind:'timeout'|'network'|'upstream', status}` — **provider body never retained**. `wordAudio(word)` caches at `sha1(word).wav` with atomic temp-file rename and an in-flight `Map` to dedupe concurrent synthesises.
  - 178–203: 30-word Telugu grocery `WORDS` bank; `challenges` `Map` (id → `{phone, word, expiresAt, used}`), TTL 2 min, 60-s sweeper with `.unref()`; `pickOptions(word)` — Fisher-Yates shuffle, correct word + 2 random decoys, order shuffled.
  - 210–320: **auth routes** (`/api/auth/start`, `GET /api/auth/challenge`, `GET /api/auth/challenge/audio/:id`, `POST /api/auth/challenge/answer`, `POST /api/auth/signup`, `POST /api/auth/login`, `POST /api/auth/logout`) — detail in §10.
  - 322–333: `requireAuth` — verifies signed cookie JWT, sets `req.shop = {id: p.shopId, phone: p.phone}`; **shop id always comes from the token, never from a request body**; mounted `app.use('/api', requireAuth)` so every data route below is protected while `/api/auth/*` above is not (order-dependent, correct).
  - 335–359: `GET/PUT /api/me` — profile read (never returns `pin_hash`) and onboarding update with 80/120/500-char caps; `profileComplete` = all of `owner_name`, `shop_name`, `address` non-empty; `voice_id` is carried/selected but never written by any route.
  - 361–405: `POST /api/stt` — per-shop limiter → `express.raw({type:()=>true, limit:'5mb'})` → 415 if content-type not `audio/*` → 400 if body < 1000 bytes → multipart POST to `https://api.vachana.ai/stt/v3` with fields `model='prisma-v3.0'`, `format='transcribe'`, `language_code=STT_LANG||'indic-auto'`, file `audio_file` as `audio/wav` blob; timeout 30 s; upstream failures → 504 (timeout) / 502 (other), never echoing provider text; success forwards **only** `{transcript, detected_language_code}`; logs only `transcript_chars`.
  - 407–440: `POST /api/tts` — separate per-shop limiter → `contentLength(8kb)` → strict validation chain (415 non-JSON; 400 non-object, non-string, empty-after-trim, > 1000 chars) → `gnaniTts()` → audio/wav response.
  - 442–674: **ledger routes** — detail in §6/API inventory. Shop scoping on every query; `ownCustomer()` helper re-verifies ownership; merge logic (move transactions → fold aliases → delete) is three sequential statements; `istToday()`/`istDayRange()` implement Asia/Kolkata day boundaries with fixed +5:30 offset (no DST in India, so fixed offset is correct).
  - 676–689: startup logs **configuration state only**; unmatched `/api/*` → JSON 404; `errorHandler()`; export/listen.
- **Limitations:** in-memory challenges/counters (L3); single-process assumption; `console.log`/`error` are the only logging (no structured logs); merge not atomic; no daily quota upstream of per-minute limits; the fixed IST offset is embedded in two places (`istOffsetMs` here and duplicated arithmetic in `public/app.js:423`; both would need to change together).

### 4.2 `security.js` — reusable middleware
Exports: `requestId` (12-char id, `X-Request-Id` header), `securityHeaders({production})`, `sameOrigin({allowedOrigins})`, `contentLength(maxBytes)`, `errorHandler()`, `validateJwtSecret(secret, {production})`, and `CSP` (exported so tests assert header == source).
- CSP (lines 19–31): `default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`.
- `securityHeaders` also sets: `nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, `Permissions-Policy: microphone=(self), camera=(), geolocation=(), payment=(), usb=(), accelerometer=(), gyroscope=()`, `COOP: same-origin`, HSTS **only** when `production`.
- `sameOrigin`: mutations (POST/PUT/PATCH/DELETE) require `Origin` host == `Host` (scheme-agnostic) or entry in `APP_ORIGIN`; `Origin: null` rejected; missing `Origin` allowed unless `Sec-Fetch-Site: cross-site` (documented trade-off L2).
- `validateJwtSecret`: fatal (exit 1) in production for missing/short <32/<12 distinct chars/placeholder patterns/repeated-char; warn-only in development; never prints the secret.

### 4.3 `public/app.js` — all frontend logic (1343 lines)
- State: single module-level `state` object (`phone`, `exists`, `voiceOkToken`, `shop`, `customers`, `today`, `recent`, `custSort`, `custQuery`). **No localStorage/sessionStorage anywhere** (verified by scan). `goLogin()` clears state and redirects.
- Router: hash-based, `route()` at lines 59–70 dispatching 9 routes + default splash; `boot()` forces `#/splash` on open.
- Voice pipeline helpers: `wav()`/`toWav()` (451–463) resample any recorded blob to 16 kHz mono PCM16 WAV in-browser via `AudioContext` + `OfflineAudioContext`; `startRecording()` (485–514) uses `MediaRecorder`, 20-s hard timer, posts **raw binary** to `/api/stt` itself (bypasses the `api()` wrapper because it is audio, not JSON); `speak(text)` (467–481) calls `/api/tts` and plays a blob URL, one audio at a time.
- Transcript pipeline: `splitTranscript` → `buildEntries` (context inheritance, amount never copied) → `classifyQuery` → flows `startEntryFlow` / `startBatchFlow` / `runQuery`; resolver statuses drive `askConfirm` / `openChooser` / `askFuzzy` / `askNewCustomer`; `onYes`/`onNo` handlers; `saveEntries` creates missing customers then posts transactions sequentially; `addAlias` remembers spoken spellings via `PATCH /api/customers/:id`.
- All rendering is `innerHTML` with `esc()` HTML-escaping used consistently (spot-verified against every template string); no inline handlers/CSS (consistent with the strict CSP).
- Recording UX: animated rings, recording state class on `body`, loading skeletons, empty states, `aria-label`s, `aria-live` PIN dots, keyboard support on cards.

### 4.4 `public/api.js`
`api(path, opts)` — JSON fetch with `credentials:'include'`, throws `Error` with `.status` and server Telugu `.message`. `apiAudio(path, opts)` — same but returns a `Blob` (TTS). No retry logic; no token headers (cookie does everything).

### 4.5 `public/parser.js`
Pure CommonJS (`module.exports = parse` — Dom+Node testable). NFC normalize → strip ZWNJ/ZWJ → normalize Telugu digits `౦-౯` and Devanagari `०-९` to ASCII → classify `type` by regex precedence (**query** unless strong-pay; **strong pay** `jama/జమ/paid/కట్టా…`; **credit** `udhaar/ఉద్దెర/appu/బాకీ…`; **weak pay** `ichindi/diya…`) → amount from digits first (`1,000` → 1000), else number-word multiplication (`ఐదు వందలు`=500, incl. Telugu/Devanagari transliterations of English) → name = remainder after stripping digits, number words, keywords and honorific suffixes. No LLM, no network.

### 4.6 `public/resolver.js`
Pure CommonJS. `resolve(spoken, customers)` → `{status: 'none'|'one'|'many'|'fuzzy', candidates}`. Normalisation strips `గారికి/గారు/కి/కు` and punctuation from both sides. Pipeline: exact (whole utterance vs name/alias) → label-token narrowing with base-name fallback → Levenshtein ≤ 1 fuzzy for names ≥ 4 chars (script mismatch deliberately *not* a near-miss → `none`, preventing wrong guesses).

### 4.7 Tests
`test-parser.js` (5 cases), `test-resolver.js` (13), `test-security.js` (81; spawns real server processes for production-secret checks, redirects `TTS_CACHE_DIR` to a temp dir, mocks all `fetch` to `api.vachana.ai`, mints session JWTs locally — **zero Supabase traffic, zero Gnani credits**). Gitignored `data/` adds `kv-flow-test.js` (24) and `kv-dom-test.js` (55, requires `jsdom` which is *not* a package.json dependency — the DOM harness was installed ad hoc with `npm i --no-save` per its header; it fails on a fresh clone without that install), plus the live-DB fixture/curl tooling.

### 4.8 `data/` (gitignored) — inspected, contents not exposed
- `kv-schema.js` — one-off script that connects to Supabase with the service key to print table columns. **Not executed during this inspection** (would touch the live project).
- `kv-fixture.js` / `kv-curl.ps1` / `kv-ids.json` — live-DB test rig (inserts ZZTest rows, runs 38 curl checks, cleans). Absence of `kv-a.jar`/`kv-b.jar` suggests a completed cleanup. **Not executed.**
- `kv-dom-test.js` requires `jsdom`; `package.json` does not include it (documented ad-hoc dependency).

---

## 5. Backend Architecture

### 5.1 Request lifecycle
```
client → [app.disable x-powered-by]
       → requestId (X-Request-Id + res.locals.reqId)
       → securityHeaders (CSP, nosniff, COOP, frame deny, Permissions-Policy, HSTS prod-only)
       → sameOrigin (CSRF on mutations; APP_ORIGIN allowlist)
       → express.static('public')                    ← all frontend assets, no auth needed
       → /api/stt content-type guard (415 pre-parse)
       → express.json 64kb (扔 413 via errorHandler on oversize/parse failure)
       → cookieParser(JWT_SECRET) (signed cookies)
       ── /api/auth/* routes (rate-limited per route) ──
       → requireAuth  mounted on '/api' (all routes below this line)
           → per-route limiter (STT 60/min/shop, TTS 60/min/shop)
           → handler → Supabase via sb client (service key, server side)
       → JSON 404 catchall → errorHandler (JSON only, no stacks)
```
Errors: handler-level `fail()` (503 NO_SUPA / 500 generic) and the final `errorHandler()` mapping body-parser failures (400 bad JSON, 413 too large, aborted 400). No HTML error pages anywhere.

### 5.2 External communication
Only two upstreams: Gnani (`api.vachana.ai`, STT multipart + TTS JSON, both `AbortSignal.timeout`, safe-kind failure mapping) and Supabase (supabase-js REST, service key, `persistSession:false`). Google Fonts is a browser-side dependency (CSP-allowed). No webhooks, no queues, no cron except the in-process challenge sweeper.

---

## 6. API Inventory (complete, from code)

Auth model legend: 🌐 public (pre-`requireAuth`), 🔐 requires session cookie. Rate limits: 15-min window = 30 req unless noted.

### 6.1 Authentication (public)
| # | Method & path | Auth | Input | Validation | DB | Response | Errors | Rate limit |
|---|---|---|---|---|---|---|---|---|
| 1 | `POST /api/auth/start` (server.js:210) | 🌐 | `{phone}` | `^[6-9]\d{9}$` → 400 | `shops id WHERE phone` | `{exists: boolean}` (no user enumeration beyond this flag) | 400, 500, 503 | 30/IP/15min |
| 2 | `GET /api/auth/challenge?phone=` (220) | 🌐 | query `phone` | validPhone → 400 | none (words+TTS cache) | `{challengeId, audioUrl, options[3]}`; challenge stored in **RAM**, TTL 2 min | 400, 502 (TTS fail), 504 (timeout), 500 | 30/IP/15min |
| 3 | `GET /api/auth/challenge/audio/:challengeId` (237) | 🌐 | path id | looked up in RAM only | none | `audio/wav` (word WAV from cache), `Cache-Control: 7d` | 404 expired/missing | 60/min/IP |
| 4 | `POST /api/auth/challenge/answer` (246) | 🌐 | `{challengeId, phone, choice}` | challenge exists, unused, unexpired, phone matches; wrong choice **burns** it | none | `{voiceOkToken}` (JWT purpose=voiceOk, phone-bound, 5 min) | 400 (anything wrong — same generic Telugu message) | 30 / `ip|phone` /15min |
| 5 | `POST /api/auth/signup` (262) | 🌐 | `{phone, pin, voiceOkToken}` | validPhone, validPin, voiceOk token valid+phone-bound | `shops` SELECT phone; INSERT shop; 23505 → 409; SELECT `…SHOP_COLS` | `{ok, shop, profileComplete}` + session cookie | 400/409/500/503 | 30/IP/15min |
| 6 | `POST /api/auth/login` (287) | 🌐 | `{phone, pin, voiceOkToken}` | validPhone, validPin, voiceOk | `shops SELECT (incl. pin_hash, failed_pin, locked_until)`; UPDATE counters | `{ok, shop, profileComplete}` + cookie | **401 generic always** (no existence leak); 429 locked; 400 voiceOk | 30 / `ip|phone` /15min |
| 7 | `POST /api/auth/logout` (320) | 🌐* | — | — | none | `{ok}`, clears cookie | — | none |

\* Logout is registered above `requireAuth`, so it technically works unauthenticated; it only clears the caller's cookie. Harmless.

### 6.2 User/profile management (🔐)
| Method & path | Input | DB | Response | Errors | Notes |
|---|---|---|---|---|---|
| `GET /api/me` (335) | — | `shops` by id | `{shop (no pin_hash), profileComplete}` | 404, 500 | Shop id from token |
| `PUT /api/me` (343) | `{owner_name, shop_name, address}` | shops UPDATE | `{shop, profileComplete:true}` | 400 missing/oversize (80/120/500) | Onboarding completion |

### 6.3 Speech-to-text / text-to-speech (🔐)
| Method & path | Input | DB | Upstream | Response | Errors | Rate limit |
|---|---|---|---|---|---|---|
| `POST /api/stt` (365) | raw `audio/*` body 1 KB–5 MB | none | Gnani `POST /stt/v3` (`prisma-v3.0`, `indic-auto`, 30 s) | `{transcript, detected_language_code}` only | 401, 415 (pre-parse + in-route), 400 <1 KB, 502, 504, 500 | 60/min/`ip|shopId` |
| `POST /api/tts` (412) | `{text}` string ≤ 1000 chars | none (cache hit possible) | Gnani `POST /api/v1/tts/inference` (timbre-v2.5/Nalini/te-IN, 15 s) | `audio/wav` binary | 401, 415, 400, 413 (8 KB / 64 KB), 502, 504 | 60/min/`ip|shopId` (separate bucket) |

### 6.4 Customers (🔐, all shop-scoped)
| Method & path | Input | DB ops | Response | Errors |
|---|---|---|---|---|
| `GET /api/customers` (443) | — | SELECT customers (name asc) + SELECT ALL their transactions; **balances computed in Node** (Σcredit−Σpay), `last_activity`, `last_payment_at` | array of customers + computed fields | 500, 503 |
| `POST /api/customers` (469) | `{name, label?, phone?}` | INSERT customer (shop_id from token, aliases `[]`) | 201 customer | 400 (name required/≤100, label ≤60, phone `[+0-9]{7,15}`), 500 |
| `PATCH /api/customers/:id` (521) | any of `{name, label, phone, aliases[]}` | SELECT+UPDATE (ownCustomer re-check) | updated customer | 400/404/500; aliases deduped ≤20; empty patch → 400 |
| `POST /api/customers/merge` (565) | `{keep_id, remove_id}` | UPDATE transactions (re-parent) → UPDATE aliases → DELETE customer — **3 statements, no transaction** | `{ok, customer}` | 400 same-id/missing, 404 cross-shop, 500 |

### 6.5 Transactions (🔐, all shop-scoped)
| Method & path | Input | DB ops | Response | Errors |
|---|---|---|---|---|
| `POST /api/transactions` (487) | `{customer_id, type:'credit'\|'pay', amount>0 int, raw_transcript?}` | SELECT customer ownership; INSERT tx | 201 tx | 400/404/500; transcript truncated to 2000 |
| `GET /api/transactions` (639) | `?recent=N` (1–50) **or** `?date=YYYY-MM-DD` (IST, default today) | SELECT tx (+ customer names joined in Node) | `{transactions[]}` / `{date, transactions[]}` | 400 bad recent/date, 500 |
| `GET /api/customers/:id/transactions` (595) | path id | ownCustomer + SELECT tx desc | `{customer, transactions[]}` | 404/500 |
| `DELETE /api/transactions/:id` (609) | path id | SELECT (id+created_at) → **403 if not today IST** → DELETE | `{ok, id}` | 403/404/500 |

### 6.6 Undocumented / incidental routes
None beyond the above exist in code. The routes that are **not** in PROJECT-DOCUMENTATION's testing notes but are documented in code comments: nothing hidden; `GET /` serves the SPA. Unknown `/api/*` paths return JSON 404 by design (681).

---

## 7. Frontend Architecture

- **Entry:** `public/index.html` — `lang="te"`, Google Fonts (Noto Sans Telugu), `styles.css`, four same-origin scripts in order `parser.js → resolver.js → api.js → app.js`. `app.js` immediately calls `boot()` → `#/splash`.
- **Routing:** hash fragments; every navigation re-renders `#app`. No history API beyond the initial splash replace.
- **State:** `state` singleton + module-level `pending`/`chooser`/`challenge` flow objects. Nothing persisted client-side besides the session cookie.
- **API:** `api()`/`apiAudio()` with `credentials:'include'`.

### Route inventory (9 routes)
| Route | What the user sees | Reached by | API calls | Actions / after-effects |
|---|---|---|---|---|
| `#/splash` | Logo, 1.8 s | app open (forced) | `GET /api/me` (fire-and-forget) | → `#/login` (401) / `#/profile` (incomplete) / `#/home` |
| `#/login` (`viewLogin`, 92) | +91 phone input, digit filter, Next | from splash or logout | `POST /api/auth/start` | → `#/verify` with `state.exists` |
| `#/verify` (`viewVerify`, 140) | Voice-word challenge (🔊, replay link, 3 options) then PIN pad (enter/create) | from login always | `GET /api/auth/challenge`, `POST …/answer`, `POST /api/auth/signup` or `/login` | BYOT challenge audio (`new Audio(audioUrl)`); wrong answer → fresh challenge; voiceOk error at PIN stage → back to voice; success → `#/profile` (new) or `#/home` (existing) |
| `#/profile` (326) | Owner name / shop name / address form (from `/api/me`) | after signup or when `profileComplete=false` | `GET /api/me`, `PUT /api/me` | → `#/home` |
| `#/home` (1028) | Today strip (credit/collected), big mic, `#say` status line, `#panel` confirmations, last-5 entries, tab bar; **logout button** in topbar | tab/nav | `POST /api/stt`, `POST /api/tts`, customers/transactions reads/writes | Full voice loop (§8.3) |
| `#/customers` (1057) | Search box, sort chips, customer cards with overdue badges + 🔊 reminder buttons | tab | `GET /api/customers` | → `#/customer/:id`; reminder speaks + downloads WAV |
| `#/customer/:id` (1142) | Header (avatar, balance, overdue), receive-payment / edit / merge / reminder, timeline with 🗑 on today only | card tap | `GET …/transactions`, `POST /api/transactions` (pay), `PATCH /api/customers/:id`, `POST /api/customers/merge`, `DELETE /api/transactions/:id` | refresh lists, TTS confirmations |
| `#/dashboard` (1342) | Placeholder "coming soon" | tab | none | none |
| `#/reports` (1343) | Placeholder | tab | none | none |

- **Micro-interactions:** mic `MediaRecorder` with 20-s cap and tap-again-to-stop; recording state turns the mic red with 3 animated rings; TTS speaks every confirmation; the duplicate-name **chooser sheet** is bottom-sheet style, readable aloud in Telugu numerals and pickable **by speaking the number** (`pickByVoice` → `/api/stt` → `numberFrom()`); reminders generate a downloadable WAV (WhatsApp-friendly).
- **Error handling:** every `api()` rejection path either shows a Telugu inline error (`showErr`), speaks it, or routes to login on 401. 401 handling is consistent across views.
- **Mobile/accessibility:** ≥48px targets, `aria-label`s, `aria-live` PIN dots, `role="button"` + Enter on cards, safe-area insets, max-width 480/520 single-column layouts. No formal a11y audit exists.
- **Frontend/backend mismatches:** none functional found. Client phone validation (`^[6-9]\d{9}$`) mirrors server. Two cosmetic duplications worth noting: the customer-edit screen validates phone with the stricter `^[6-9]\d{9}$` while the server allows `[+0-9]{7,15}` (server is looser — fine); `refreshHome()` always fires three parallel GETs (fine at current scale). The `voice_id` column is read/selected but nothing in UI or server writes it.

---

## 8. Gnani AI Integration Analysis

Base URL `https://api.vachana.ai`, key `GNANI_API_KEY`, sent as `X-API-Key-ID` header. Both calls are server-side proxies — **the key never reaches the browser**.

### 8.1 Prisma (STT) — `POST /api/stt` → `POST https://api.vachana.ai/stt/v3`
- Model: multipart field `model=prisma-v3.0` (hardcoded, server.js:374); `format=transcribe`; language `language_code=STT_LANG || 'indic-auto'` (auto-detect te/hi/en).
- Audio format: 16 kHz mono PCM16 WAV assembled **client-side** (`toWav` in app.js:458–463); server wraps it as `audio/wav` Blob named `a.wav` in multipart; server-side caps 1 KB min / 5 MB max.
- Timeout: `AbortSignal.timeout(30000)`.
- Response: parsed JSON; must contain string `transcript` else 502; client receives `{transcript, detected_language_code}` only (verified in code and asserted by the security suite "forwards no raw provider payload").
- Transcript processing: **none on the server**; all interpretation is client-side (`splitTranscript`/`parse`/`resolve`).
- Rate limits: 60/min per `ip|shopId`; no daily quota.

### 8.2 Timbre (TTS) — `POST /api/tts` → `POST https://api.vachana.ai/api/v1/tts/inference`
- Model: `timbre-v2.5` (env `TTS_MODEL`), voice `Nalini` (env `TTS_VOICE`), language `te-IN` (env `TTS_LANG`), speed 1.0; `audio_config {24000 Hz, 1 channel, 16-bit linear PCM, WAV}`.
- Timeout: 15 s. Response body → raw WAV bytes → sent as `audio/wav`.
- Caching: **word-level** TTS cache — challenge words are synthesised once per unique word to `data/tts-cache/<sha1(word)>.wav` with in-flight dedupe; general `speak()` calls are **not** cached (each playback is a live upstream call).
- Rate limit: separate 60/min per `ip|shopId` bucket.

### 8.3 Full voice pipeline (current, verified)
```
[Home] tap 🎤 → getUserMedia → MediaRecorder (≤20 s)
  → blob → decodeAudioData → OfflineAudioContext resample 16 kHz mono PCM16 WAV  (browser, app.js:450–463)
  → POST /api/stt  (audio/wav, session cookie, 60/min/shop)
  → server validates → multipart → Gnani Prisma → {transcript}
  → client: classifyQuery(raw)?            ─ query ─→ runQuery() → /api/customers | /api/transactions?… → speak() result + card
  └ entries: splitTranscript → buildEntries(parse per part)
       → resolve(spoken, state.customers)
            ├ one   → askConfirm card, speak read-back → ✅ → POST /api/transactions (customer created first if needed) → speak "నమోదు చేశాను."
            ├ many  → chooser sheet → tap or speak number (/api/stt → numberFrom) → alias saved via PATCH → confirm
            ├ fuzzy → "did you mean?" → ✅ saves alias (PATCH aliases) → confirm
            └ none  → "New customer?" editable form (name/label/phone) → POST /api/customers + transaction
       → multi-part → batch card (🗑 per row, single ✅) → saved sequentially
  → refreshHome() re-reads customers + today + recent-5
```
**Everything that happens to the transcript after STT is deterministic JavaScript** — no LLM, no server-side NLP. Gnani is used exclusively for (a) speech→text and (b) text→speech. All dialogue logic (parser, resolver, queries, confirmation grammar) is local and testable — which is exactly what makes the conversational-onboarding proposal in §11 tractable.

---

## 9–10. Current Authentication System — Deep Inspection

### 10.1 The flow, stage by stage (all references verified)
```
 ┌────────────┐  POST /api/auth/start {phone}      shops SELECT id WHERE phone
 │ #/login    │ ─────────────────────────────────▶ {exists}
 └─────┬──────┘
       ▼
 ┌────────────┐  GET /api/auth/challenge?phone     word=rand(30), wordAudio(word)
 │ #/verify   │ ◀── {challengeId, audioUrl, options[3]}   (RAM challenge, TTL 2 min)
 │ voice step │  <Audio autoplay audioUrl>          options = word + 2 decoys, shuffled
 │            │  POST /api/auth/challenge/answer    match? → burn + JWT voiceOk(5 min,
 │            │ ◀── {voiceOkToken}                  phone-bound). Else generic 400.
 └─────┬──────┘
       ▼
 ┌────────────┐  pinMode = exists ? 'enter' : 'create'   (create = enter twice)
 │ #/verify   │  POST /api/auth/signup | /login {phone, pin, voiceOkToken}
 │ PIN step   │   signup: INSERT shop (bcrypt 10) → 30d session cookie
 │            │   login:  SELECT + locked_until check → bcrypt.compare
 │            │           fail → failed_pin++ (≥5 → locked_until +15 min), 401 generic
 └─────┬──────┘        success → reset counters, 30d session cookie
       ▼
 #/profile (new) or #/home (existing)     30-day signed httpOnly SameSite=Lax cookie `session`
                                          JWT {shopId, phone}
```

Stage details:

1. **Phone entry** — frontend `viewLogin` (app.js:92–131) filters digits, validates `^[6-9]\d{9}$` before calling. Backend route 1 returns `{exists}` — this *is* a mild enumeration vector for "does a phone have an account" (the flag is required for the signup-vs-login UX; login itself stays generic).
2. **New/existing detection** — drives PIN mode; nothing else.
3. **Voice challenge** — server picks a random Telugu grocery word, synthesises+ caches audio, stores `{phone, word, expiresAt, used}` in RAM (server.js:190–195), and returns 3 shuffled options including the correct word. **The correct mapping never leaves the server** — only the audio reveals which option is right. The option *texts* reach the browser (documented honestly in SECURITY-HARDENING §H).
4. **Challenge audio** — served from file cache, keyed to that challenge's word only, 7-day browser cache header (safe because words are generic grocery nouns).
5. **Challenge-answer validation** — route 4: single-use (any failure or wrong answer burns the challenge), 2-min TTL, phone-bound, limiter keyed `ip|phone`. Wrong attempts trigger the client to fetch a fresh challenge.
6. **PIN creation** — 4 digits only (`validPin` = `^\d{4}$`, server.js:81). New accounts enter twice client-side; server never sees a "confirm" concept, just the final value. bcrypt cost 10 (`bcrypt.hash(pin, 10)`, server.js:273).
7. **PIN login** — `bcrypt.compare` against stored `pin_hash`; **5 failed PINs → `locked_until` = now+15 min** (server.js:306–311); success resets `failed_pin`/`locked_until` (313); lockout returns 429 with Telugu message; everything else 401 with one generic message (no enumeration).
8. **JWT creation** — `setSession()` (84–90): `{shopId, phone}`, HS256 via `jsonwebtoken`, 30 d expiry, stored in a **signed** (HMAC via cookie-parser) httpOnly `SameSite=Lax` cookie, `secure` in production, `maxAge` 30 d.
9. **JWT validation** — `requireAuth` (323–332): verifies signature + exp; `req.shop = {id, phone}` from the token; invalid → 401. `voiceOkPhone` similarly validates the 5-min purpose-token.
10. **Session expiration** — purely JWT-exp based; no sliding renewal, no server-side session store.
11. **Logout** — clears the cookie (route 7); the JWT itself remains valid until natural expiry (L4).
12. **Recovery** — **none.** No "forgot PIN", no OTP fallback, no email. Losing the PIN + cookie = the phone number is simply stuck with an account; there is no mechanism in code to reset `pin_hash`, `failed_pin`, or `locked_until` (locked_until does however auto-expire after 15 min).
13. **Device association** — none. The cookie is device-local, but there is no device registry, no device ID, no push channel.
14. **Phone ownership verification** — **none. The code comments state this explicitly** (server.js:94–104, 186–209): the voice challenge proves *an audio interaction completed in this browser session*, not that the user owns the phone number, and not that the user is human in a rigorous sense (a bot could brute the answer space but is throttled by single-use burn + limiters; a human with stolen phone + stolen PIN is unaffected). OTP = documented future requirement R1.

DB fields touched by auth (repository-derived): `shops(id, phone, pin_hash, owner_name, shop_name, address, voice_id, failed_pin, locked_until, created_at)`.

---

## 11. Proposed Authentication Journey — Feasibility & Gap Analysis (design only)

Target journey: Telugu conversational onboarding → human verification → face scan → PIN → returning users pinned straight in, no logout button, device-locked.

### 11.1 What exists and is reusable
The four pillars survive intact: (1) the Gnani STT/TTS proxies are conversation-agnostic; (2) the TTS word cache extends trivially to cached onboarding phrases; (3) `voiceOkPhone`-style purpose-scoped JWTs are a template for new proof tokens (e.g. `onboardingOk`, `livenessOk`); (4) `bcrypt` PIN + lockout + rate limiter + generic-error patterns are directly reusable. The SPA shell routes are additive.

### 11.2 Gap table
| Proposed feature | Existing implementation | Reusable components | Missing components | Technical difficulty | Security/privacy concerns |
|---|---|---|---|---|---|
| App speaks Telugu greeting ("నమస్కారండి, మీ పేరు?") and drives a dialogue | `speak()` + Gnani Timbre proxy + word cache (app.js:467, server.js:132–175); **no dialogue engine** | `speak()`, TTS cache pattern, hash route shell | Conversation state machine (per-step FSM), phrase cache strategy, mic auto-arm after TTS, interrupt/cancel handling | **Medium** | Audio-only prompts need screen-reader parity; autoplay policies require a tap-to-start |
| Interpret free answers via Prisma and ask follow-ups | `/api/stt` returns raw transcript; `parser.js` handles *ledger* utterances only | STT proxy unchanged; the parser/resolver pattern (deterministic, testable) | A new **onboarding parser** (name capture, digits-as-phone, yes/no, spelling back letter-by-letter or digit-by-digit for confirmation), transcript-driven routing; a conversation-state model persisted server-side or in browser state | Medium–High | Name/phone captured by voice must be **spoken back and confirmed** (STT error rates); consider digit-round-trip for phone numbers |
| Decide mandatory onboarding fields | Current schema: `shops(phone PK-ish, pin_hash, owner_name, shop_name, address, voice_id, …)` | Existing `PUT /api/me` validation | Schema gaps for new fields (e.g. no language preference, no KYC-ish fields, `voice_id` unused) — **to be decided against the real schema export (§19)**; today only the 3 profile fields + phone are supported | Low (fields exist) to High (if new fields needed ⇒ DB change, out of scope here) | Every extra field ⇒ privacy/data-minimisation review |
| **Human verification** of the interactant | Voice challenge proves *audio interaction*, explicitly **not** humanness per SECURITY-HARDENING L1 | The challenge pattern is a weak but demonstrable "person is present and responding" signal | Real anti-automation/liveness: nothing exists; **Prisma STT is not a liveness or anti-spoofing engine** — do not assume otherwise. Options to evaluate: replay-insensitive challenge randomisation (already done, helps against replay of fixed answers, not against a scripted bot), audio-quality/heartbeat signals, or a third-party liveness provider | High | Bot defenses fail closed/left open trade-off; accessibility for speech-impaired users must have an alternative path |
| **Face scan** via camera | Nothing. `Permissions-Policy` currently **denies camera** (`camera=()`, security.js:40) and CSP has no media-capture policy — a deliberate change is required | The middleware/permissions model itself | getUserMedia consent flow + UI; face **detection** vs **matching**: matching & liveness require a provider (e.g. cloud biometric APIs); secure transport & storage of derived embeddings; consent + retention + deletion workflow; device-compat guidance (mobile Chrome/Safari) | **Very high** | ⚠️ Do **not** store raw face images or biometric templates without a full DPIA: consent (India DPDP Act 2023 requires explicit consent for biometrics — for legal review, not solved in code), purpose limitation, encryption at rest, template-reversibility risk, breach blast radius, deletion SLA. A normal browser camera API proves *a camera saw a face* — **it does not verify identity** |
| PIN setup (4- or 6-digit) | 4-digit, bcrypt-10, DB `pin_hash`, lockout 5→15 min, limiter, generic errors | All of it: hashing, verification, lockout, rate-limits, `validPin` (would widen to 6 via regex change) | Recovery ("forgot PIN" ⇒ needs the phone-verification story first); possibly per-account cost bump if offline-crack resistance matters (see below) | **Low** | 4-digit PIN with 10^4 space + at-login lockout is acceptable for online guessing; a leaked bcrypt(4-digit) hash is trivially crackable offline (cost 10 × tiny keyspace) — acceptable risk if the DB/tooling is protected, but 6-digit materially raises offline cost; block weak PINs (0000, 1234, birthdates) — currently **no** forbidden-list exists |
| Returning user: device-remembered, PIN-only, no logout button | 30-day JWT cookie; splash → `/api/me` → home when cookie valid. Logout currently **renders on every main screen** (app.js:395) | Splash routing, cookie persistence, `ensureShop()` | Device binding (nothing binds a session to a device); "remember this device" longer-life refresh token + server-side session table with revocation; policy choice to hide logout while keeping a hidden/long-tap escape; silent re-auth UX | Medium | ⚠️ Removing the visible logout materially worsens shared-device and theft scenarios unless compensated: device-bound revocable sessions, remote "sign out all devices", emergency lock, PIN re-entry on high-value actions, an inactivity re-PIN. Browser data clearing (or cookie expiry) silently logs the user out — recovery path becomes mandatory, and that path itself needs the OTP story |
| Account recovery, remote revocation, emergency lock | **None today** (see §10.1 stages 12–14) | — | Sessions/Devices tables, revocation endpoint(s), account lock flag, a recovery protocol tied to real phone verification | High | Recovery is the *new* weakest link — its strength must match the locking story |

### 11.3 Recommended architecture (proposal, clearly separate from current reality)
1. Add a server-side `sessions`/`devices` table at schema time (which is pending anyway): id, shop_id, device fingerprint/jwt-id (jti), issued_at, last_seen, revoked_at. `requireAuth` then checks jti against it — enabling **revocation, "logout everywhere", and shorter-lived access tokens** with a rotating long-lived refresh token in a second httpOnly cookie. This single change fixes R2 and enables the device-locked UX safely.
2. Onboarding conversation = a **server-defined state machine** (steps, prompts, expected answer types) returned to the client as a transcript of TTS strings; the client stays a dumb audio shell. This keeps prompts auditable/testable and lets the phrase bank hit the TTS cache.
3. Keep the existing voice challenge as a *presence* check, and add a genuine **phone-ownership** proof once an OTP provider is chosen (R1 is the linear prerequisite for PIN recovery and device theft recovery).
4. Face scan: treat it as **optional, revocable, and.preference-based**. Prefer *face-collapse to an embedding with a third-party biometric-verification provider*, storing only a provider token/verification result, never raw images. If the product insists on self-hosted matching, engage a security review that includes template-protection and breach modelling — out of scope for this codebase today.
5. Convenience UX on return: device-bound session + PIN-only entry, visible only after N inactivity/reboot policy rules; a *hidden* logout/settings affordance (long-press on profile) so shared devices are not trapped; inactivity re-PIN; transaction-level re-PIN threshold for high-value credits.
6. Restore a **PIN recovery** path only *after* real phone verification exists; until then document as unsupported.

---

## 12. Security Hardening Review (re-verified against source)

Verified **in code**, item by item:

- **Security headers** — security.js:33–46; applied globally at server.js:63 (before static) so even asset and 401 responses carry them — confirmed by test "API 401 still carries security headers".
- **CSP** — strict, no `unsafe-inline`, allows Google Fonts CSS, `blob:` media (TTS playback), mic self; export asserted equal to the applied header by the suite. Consistency with `public/` verified (no inline scripts/styles/handlers anywhere).
- **Same-origin/CSRF** — security.js:55–79, applied at server.js:64; mutations only; `APP_ORIGIN` allowlist documented; missing-Origin fallback with `Sec-Fetch-Site` cross-site rejection (L2 trade-off, real).
- **Cookie configuration** — httpOnly + signed + SameSite=Lax + secure-in-prod + 30 d (server.js:86–89). Tamper → 401. **No server-side revocation** (L4/R2 preserved).
- **JWT validation** — via `jwt.verify` everywhere (`requireAuth`, `voiceOkPhone`); no shared-secret fallbacks; production refuses weak secrets at startup (verified by the spawn tests in the suite).
- **Auth rate limits** — 30/15min on start/challenge/signup (IP) and answer/login (`ip|phone`), plus 60/min audio. Standard headers on, legacy off, IPv6-safe keys via `ipKeyGenerator`. Values match SECURITY-HARDENING §3 exactly.
- **STT/TTS rate limits + validation** — as coded, per-shop and separate buckets, full validation chains; security suite covers boundary cases (1000/1001 chars, 61st request, bucket independence, block at limit never hits upstream).
- **Body limits** — 64 KB global JSON, 8 KB TTS route, 5 MB STT, 1 KB minimum STT size. Pre-parser STT content-type guard returns 415 (not a parse error).
- **Input validation** — phone/PIN regexes, integer-amount check, length caps everywhere, date regex, `recent` 1–50, aliases ≤ 20, transcripts sliced to 2000.
- **Provider timeouts** — 15 s TTS / 30 s STT; failures mapped to 504/502; provider bodies never stored or echoed (suite asserts a sentinel secret can never leak through).
- **Error handling** — JSON-only, no stacks, mapped statuses (400/413/abort), `fail()` logging route+category only.
- **Logging** — 14 statements audited; only route, request id, error category, upstream status, byte/char counts, config "configured/MISSING" state. **No transcripts, names, phones, PINs, tokens, secrets** — verified by reading every `console.*` line.
- **Shop-level data isolation** — every ledger query and ownership check verified in code; suites (not rerun here) previously validated cross-shop 404s live.
- **PIN lockout** — 5 fails → 15 min; counters reset on success; auto-expiry; generic errors.
- **Challenge expiration/replay prevention** — 2-min TTL, sweeper, single-use burn, phone match, randomised options per challenge; in-memory (L3).
- **Secret management** — `.env` gitignored (confirmed); placeholders in `.env.example`; startup prints state only; `validateJwtSecret` never echoes; placeholder key detection (`'your_key_here'`) warns at startup.

**Remaining weaknesses** (all visible in source; none hidden):
1. No OTP / phone-ownership proof (L1/R1) — the most significant structural gap relative to §11 goals.
2. No server-side session revocation; 30-day fixed JWT (L4/R2).
3. In-memory challenges + rate-limit buckets (L3) → single-instance-only production; restart clears counters (attackers get fresh budgets after every deploy).
4. Merge multi-step non-atomic (R4).
5. No per-day spend quota for a rogue *authenticated* shop (R5).
6. Missing-Origin policy allows header-less clients (L2) — deliberate.
7. 4-digit PIN offline-crackability if `shops.pin_hash` ever leaks (uniform-risk, low likelihood, worth noting against a 6-digit upgrade).
8. `voice_id` is read/selected but never populated — dead column today.
9. No `npm audit` automation (L8); baseline audit reported 0 vulnerabilities at hardening time — **cannot re-verify without installing/network**, unverified as of today.
10. Supabase RLS **not verifiable from this repository** — the service-key client bypasses RLS entirely; security of the data therefore rests entirely on the app's `.eq('shop_id')` discipline plus whatever policies exist server-side. Not assessed; see §19.

---

## 13. Database Interaction Analysis — repository-derived (INFERRED FROM APPLICATION CODE — NOT VERIFIED AGAINST LIVE SUPABASE)

No connection was made, no SQL run, no live introspection. Everything below is what the code *assumes*.

| Table | Columns used by application (as written in code) | Operations | Relationships assumed | Evidence / source file |
|---|---|---|---|---|
| `shops` | `id, phone, pin_hash, owner_name, shop_name, address, voice_id, failed_pin, locked_until, created_at` | SELECT (by phone; by id), INSERT (signup), UPDATE (profile, counters) | `shops.id` → `customers.shop_id`, `transactions.shop_id` | server.js:216, 270–284, 296–317, 259, 337–358; kv-fixture.js |
| `customers` | `id, shop_id, name, label, phone, aliases, created_at` | SELECT (list, by id), INSERT, UPDATE (patch, merge aliases), DELETE (merge) | `aliases` behaves as a **JSON(B) array** (spread/`.some` used); `shop_id` FK | server.js:446, 471–484, 511–591 |
| `transactions` | `id, shop_id, customer_id, type, amount, raw_transcript, created_at` | SELECT (list/today/recent), INSERT, UPDATE (merge re-parent), DELETE | `customer_id` FK, `type∈{credit,pay}`, `amount` integer, `created_at` ISO UTC; day math done in code, not SQL | server.js:448, 501–507, 573–577, 599–604, 611–624, 645–672 |
| (others) | none referenced | none | — | no SQL files, migrations, or RPC calls exist in the repo |

- **In-code computed values** (not DB-generated): `balance` (Σcredit−Σpay), `last_activity`, `last_payment_at` (server.js:454–464), `profileComplete`, IST day windows (628–637).
- **JSONB usage:** only `customers.aliases` — inserted as `[]`, mutated client-or-server side, deduped ≤20.
- **RPC calls:** none. **Multi-statement "transactions":** merge is 3 sequential calls with explicit error bail-out (571–591) — **not** atomic; no Postgres transaction used anywhere.
- **Code-assumed constraints** (each would surface as a 409/23505 or query error): `shops.phone` unique; uuid primary keys; Postgres error code `23505` mapped to 409.
- **Questions the real schema export must answer** (see §19): PK types/defaults, FKs + ON DELETE behaviours, unique constraints, RLS policies and their relationship to service-role access, indexes on `shop_id`/`phone`/`customer_id`, and column defaults/NOT NULLs (e.g. is `voice_id` column type; is `aliases` truly jsonb).

---

## 14. Testing & Test Results (executed during this inspection)

**Safe to run (all hermetic, no live data):**
- `node --check` on all 7 JS files — **pass** (no syntax errors).
- `npm test` = `test-parser.js` + `test-resolver.js` + `test-security.js`:
  - Parser: **5 passed, 0 failed.**
  - Resolver: **13 passed, 0 failed.**
  - Security: **81 passed, 0 failed.** The suite bound the app to an ephemeral port, mocked every Gnani call, minted local session JWTs, redirected the TTS cache to a temp dir; console evidence confirms no external requests and no DB traffic.
- `node data/kv-flow-test.js` — **24 passed, 0 failed.**
- `node data/kv-dom-test.js` — **55 passed, 0 failed.** (Requires `jsdom`, present in the installed node_modules from an earlier ad-hoc install; not a package.json dependency.)

**Total executed: 178/178 pass.** These are fresh runs against today's tree, not copied from docs.

**Not run (would touch live systems), per operating rules:** `data/kv-fixture.js` (writes/deletes Supabase rows), `data/kv-curl.ps1` (needs a running server + fixtures), any live Supabase introspection (`data/kv-schema.js`), any real Gnani call. Test coverage gaps: no auth-flow E2E test that exercises signup/login against a real DB (the security suite covers validation/limits/CSRF around auth but not persistence), no parser tests for TTS-resampled audio quality, no tests for `PUT /api/me`/customers/merge persistence at all in the committed suite (only the live curl suite covers those — currently absent from `npm test`).

---

## 15. Current Limitations & Technical Debt (prioritised)

**Critical**
1. *(None critical for a locally deployed demo)*; nearest thing: **no account/PIN recovery path** — a forgotten PIN permanently bricks that phone-number account (no remediation code exists), and locked accounts are only self-recovering for 15-minute lockouts, not lost secrets.

**High**
2. No phone-ownership verification (R1/L1). Blocks the §11 roadmap.
3. No session revocation / server-side sessions (R2/L4); stolen cookie valid to 30 days.
4. Single-instance-only due to in-memory challenges + buckets (L3); restart mid-login abandons users and resets rate-limit budgets.

**Medium**
5. Merge not atomic (R4); crash mid-merge splits a customer's data.
6. No daily voice-API spend quota (R5).
7. Dashboard/Reports empty placeholders (Phase C work).
8. Balances recomputed from full transaction scans on every `/api/customers` call — fine at shop scale, unbounded for a large shop (documented in PROJECT-DOC §13).
9. Frontend tests (`kv-dom-test.js`) and live-API suite depend on gitignored tooling/ad-hoc deps; a fresh clone runs only 99 of 178 checks via `npm test`.

**Low**
10. `voice_id` dead column; duplicated IST offset logic in two places; logout registered pre-auth (harmless); SVG/emoji-only icons; no PWA/offline story; English mixing in some labels.

**Unknown / requires verification**
- Real schema, constraints, **RLS policies**, and indexes on Supabase (§19); RLS is the actual backstop for a leaked service key or a client-side-only integration.
- Live resilience of the Gnani models to accents/noise (nothing in repo measures error rates).
- Production environment posture (DNS/TLS/proxy/TRUST_PROXY) — nothing verifiable locally.

---

## 16. Rythu Khata Extension Readiness (analysis only; no implementation)

The proposed farmer↔commission-agent produce-ledger workflow maps well onto the existing conceptual model, *if* the transaction record is generalised from a two-party credit/pay line into a richer object. Reusability:

| Proposed capability | Current support | Reuse vs extend |
|---|---|---|
| Farmer profiles | `customers` with label + aliases | **Reuse** — farmer = customer with a profile label; resolver/parser already handle Telugu names/suffixes |
| Buyers / commission agents | Nothing distinct | **Extend** — likely a `roles`/`parties` construct or second customer class; new concept, not a column tweak |
| Produce deliveries (crop, quantity, units, rate, gross) | `transactions` has only `type∈{credit,pay}, amount` | **Extend** — either a typed `details` jsonb payload or a new `rythu_transactions` table; parser would need crop/quantity/rate phrase grammar |
| Advances | `credit` today | **Extend** — semantic tag on credit, not new plumbing |
| Projected itemised deductions | Nothing | **New** — line-item sub-records; math lives server-side like `balance` |
| Partial payments / settlements | `pay` + balance arithmetic + today-only delete | **Reuse** balance engine; settlement UX new |
| Transaction history / audit | `raw_transcript` + timeline + today-only undo; merge keeps aliases | **Reuse** for audit; *corrections* may want an unpaid-edit/correction log rather than delete-only-today |
| Voice capture of entries | Whole §8 pipeline | **Reuse** — plus a Rythu parser module alongside `parser.js`, and possibly a domain **word bank** for crop names hitting the TTS cache |
| Multi-tenancy & auth | shops + requireAuth + shop scoping | **Reuse** unchanged |

**Not to design here:** DDL, migrations, schema changes. A later decision (against the real schema export) must choose between `details`-jsonb-on-`transactions` (cheap, flexible, but weakly queryable) versus a first-class produce-record table (cleaner reports, more migration).

---

## 17. Recommended Next Development Phases (informational; no implementation)

1. **Phase C1 — supersede with the real schema export first.** Confirm the live tables, RLS, indexes (§19), then re-baseline security assumptions.
2. **Phase C2 — recoverability + sessions.** Sessions/devices table with jti revocation, short access + refresh cookies, "log out everywhere", and a documented PIN-recovery protocol gated by a real OTP provider. This unblocks every item in §11.
3. **Phase C3 — conversational onboarding.** Server-defined dialogue FSM honouring the TTS cache; onboarding parser for Telugu answers; profile completion by voice with spoken-back confirmations.
4. **Phase C4 — harden to production.** Shared state for challenges/buckets (Redis or the new DB), daily voice quotas, atomic merge (RPC), structured logging, monitoring, `npm audit` automation.
5. **Phase C5 — face/liveness (optional, DPIA first).** Only after C2/C3; third-party provider evaluation; consent + retention + deletion workflow; CSP/Permissions-Policy change consciously.
6. **Phase C6 — Dashboard/Reports (original Phase C)**, then **Rythu Khata** as a new parser + data layer alongside, reusing these foundations.

---

## 18. Unverified Assumptions & Unanswered Questions

Cannot be determined from this repository; listed so the next phase can resolve them:

1. The **actual Supabase schema, constraints, indexes, and RLS policies** for `shops`, `customers`, `transactions` (and anything else that exists beyond what server.js touches).
2. Whether `shops.phone` is unique via constraint or merely by practice (code maps 23505 to 409 — implies a real constraint, unconfirmed).
3. Live Gnani quotas, model versions in actual use, and lat/error distributions of Prisma/Timbre (nothing in repo measures it).
4. `.env` production values (NODE_ENV, TRUST_PROXY, APP_ORIGIN) — deliberately not read.
5. `npm audit` currency (cannot run without unlocking network; last known clean = 2026-11-04 per SECURITY-HARDENING L8).
6. Whether any ToS/regulatory constraints apply to storing biometric data (India DPDP Act considerations named in §11; unresolved).
7. Stale numbers in PROJECT-DOCUMENTATION (§2) — which other claims in that doc should be treated as pre-hardening history rather than current truth.

---

## 19. Exact Supabase Schema Information Required Next

When the schema export arrives, it should answer, at minimum:

For **each of `shops`, `customers`, `transactions`** (and confirm whether any other tables exist):
- **Columns:** name, data type, nullability, default, generated/identity flags; exact type of `aliases` (jsonb vs text[]), `voice_id`, `amount` (int/bigint/numeric), timestamps (timestamptz vs text).
- **PKs:** column(s), type, whether uuid-defaulted (gen_random_uuid or default via trigger).
- **FKs:** from/to columns, ON DELETE/UPDATE actions (does deleting a shop cascade customers/transactions? does merge's DELETE on `customers` fail or cascade to `transactions`?).
- **Unique constraints / indexes:** on `shops.phone`, on `customers(shop_id, lower(name))` or similar, on `transactions(shop_id, created_at)`, on `transactions(customer_id)` — this last one materially affects merge performance at scale.
- **RLS policies:** are they enabled on these tables at all; do they trust `shop_id = auth.uid()`; is the service role exempted; anything relying on RLS that the app's service key silently bypasses today.
- **Extensions/triggers/views:** any SQL that the app doesn't know about.
- **Row counts / data volume for the developer's own shop** (aggregate only, no user PII in this report).

That set of answers converts every item here marked "INFERRED — NOT VERIFIED" into fact, and is the prerequisite for the §11/§16 designs and any future migration.

---

### Final validation (per §15/§16 of the task)
- Application source modified: **No** (zero tracked-file diffs vs HEAD).
- `.env`/secrets changed: **No** (`.env` untouched; never read).
- Supabase accessed/modified: **No** (no network calls to Supabase by any command I ran).
- Dependencies installed/upgraded: **No** (no npm install was executed; `npm test` does not touch the lockfile).
- Git commit/push: **No** (no state-changing git command run).
- Files created: **Only this report** (`REPOSITORY-INSPECTION-REPORT.md`).
- Final Git status: branch `main`, up to date with `origin/main` at `a86e886`; working tree clean except one pre-existing untracked file, `PROJECT-DOCUMENTATION.md` — identical to the state at inspection start, plus this report.

*Report ends.*
