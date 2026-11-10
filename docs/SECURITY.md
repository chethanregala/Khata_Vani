# Khata Vani — Security Hardening Report

**Date:** 2026-11-04 · **Baseline:** tag `security-baseline` @ `4c9989e` ("phase B") · **Scope:** hardening of the existing app only — no rebuild, no schema changes, no ledger-semantics changes, no UI redesign, no new auth provider, no new runtime dependencies.

> This document records what was changed, what was tested, and — just as importantly — what was **not** fixed and why. Passing tests do not make an application production-secure; see [Outstanding security risks](#7-outstanding-security-risks-not-implemented) and [Known limitations](#6-known-limitations).

---

## 1. Security improvements implemented

### A. TTS endpoint protection (`POST /api/tts`)

The TTS proxy was previously open to any caller with no body validation — strangers could consume Gnani credits.

- Now behind `requireAuth` (session cookie), like every other `/api` route.
- **Dedicated per-shop rate limit**: 60 req/min keyed `ip|shopId` — a **separate bucket** from STT (`ttsApiLimiter` vs `shopApiLimiter`), so a TTS burst can never starve speech recognition for the same shop, and one shop never affects another.
- Strict body validation, all returning 400/413/415 with Telugu JSON messages:
  - `Content-Type` must be `application/json` → else **415**.
  - Body must be a JSON object (not array/string/null) → else **400**.
  - `text` must be a **string** → else **400** (rejects numbers, null, arrays, missing).
  - `text` must be non-empty after trim → else **400**.
  - `text` ≤ **1000 characters** → else **400** (exactly 1000 is accepted).
  - Per-route size guard **8 KB** → else **413**; global JSON parser cap **64 KB** → else **413** (JSON, never HTML).

### B. Safe Gnani API integration (STT + TTS)

- Explicit upstream timeouts via `AbortSignal.timeout`: **TTS 15 s**, **STT 30 s**.
- Failure handling returns only a *kind* (`timeout` / `network` / `upstream`) + status — the provider response body is never retained, logged, or forwarded.
- Status mapping (Telugu messages only, no raw provider text):
  - upstream timeout → **504**
  - network failure / upstream 4xx-5xx / invalid provider response → **502**
- STT forwards exactly `{ transcript, detected_language_code }` — never the raw provider payload (verified against the real provider, §5).
- Model/voice configuration unchanged (`prisma-v3.0`, `timbre-v2.5`, `Nalini`, `te-IN`).

### C. Log scrubbing

All backend logging audited; the 14 remaining `console.*` statements emit only: route/context name, 12-char request id, error **category** (`e.code || e.name`), upstream status, byte/character counts, and config **state** (`configured`/`MISSING`).

Removed: raw transcripts, `STT … head:` bytes, full provider responses (`x.slice(0,300)`), error message bodies (`e.message`, `String(e)`), API-key length at startup (`K.length + ' chars'`), customer data.

Never logged (and enforced by tests): transcripts, customer names, phone numbers, PINs, tokens, audio payloads, Gnani keys, Supabase keys, full provider responses.

### D. HTTP security headers

New `securityHeaders()` middleware (no Helmet — zero new dependencies):

| Header | Value |
|---|---|
| `Content-Security-Policy` | `default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `no-referrer` |
| `X-Frame-Options` | `DENY` |
| `Permissions-Policy` | `microphone=(self), camera=(), geolocation=(), payment=(), usb=(), accelerometer=(), gyroscope=()` |
| `Cross-Origin-Opener-Policy` | `same-origin` |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` — **production only** (never on plain-HTTP dev) |
| `X-Request-Id` | per-request correlation id (also in server logs) |
| `X-Powered-By` | removed (`app.disable`) |

**No `unsafe-inline` anywhere.** Verified against the actual frontend before choosing the policy: `index.html` loads 4 same-origin `<script>` tags + `styles.css` + Google Fonts only; `public/` contains **zero** `style=` attributes, `onclick=`/other handlers, `javascript:` URLs, or CSS `url()`. Microphone (`microphone=(self)`), audio playback (`media-src 'self' blob:` for TTS blobs), fonts, and same-origin API calls all remain allowed. Headers are applied to API responses too (verified on 401s), not just pages.

### E. Same-origin / CSRF protection

New `sameOrigin()` middleware covering **POST/PUT/PATCH/DELETE** (GET/HEAD/OPTIONS exempt):

1. If `Origin` is present: its **host must match the request `Host`** (scheme-agnostic, so TLS-terminating proxies work) **or** be listed in the optional `APP_ORIGIN` allowlist → otherwise **403** (Telugu JSON). `Origin: null` is rejected.
2. If `Origin` is **missing** (curl / server-to-server / legacy clients): rejected **only** when `Sec-Fetch-Site: cross-site` says the request came from another site; otherwise allowed. This is an *explicit, documented* policy — not silent trust (see limitation L2).

This layers on top of the existing controls: signed httpOnly `SameSite=Lax` cookie + signed-cookie tamper detection.

### F. Request-body validation

- Global `express.json({ limit: '64kb' })` (was unlimited) → oversize = **413 JSON**.
- New JSON error handling: malformed JSON → **400 JSON** (was an HTML stack-trace page), aborted body → **400**, oversize → **413** — all via a JSON-only final error handler.
- STT: `audio/*` `Content-Type` enforced **before body parsing** → **415** (previously a wrong content type surfaced as a JSON parse error); raw body cap **5 MB**; minimum size 1000 bytes.
- TTS: see §A (8 KB guard + 1000-char text cap + type checks).
- Existing route validation left intact and unweakened (phone `^[6-9]\d{9}$`, PIN 4 digits, integer amounts > 0, string length caps, `recent` 1–50, date regex, aliases ≤20, cross-shop id re-checks).

### G. Production JWT-secret validation

New `validateJwtSecret()` runs at startup and **never prints the secret**:

- **Missing/empty** → fatal everywhere (as before, but with a clearer message).
- **Production** (`NODE_ENV=production`) rejects: length < 32, placeholder patterns (`change_me`, `your-…`, `example`, `insecure`, `jwt_secret`, …), < 12 distinct characters, single repeated character → `FATAL … exit 1`.
- **Development**: same weaknesses only `WARN` — local work is never blocked.
- **No automatic rotation.** Rotation invalidates every existing session and is a deliberate deployment decision (§8).

### H. Audio-challenge wording and identity limits

- `server.js` comments now state explicitly that the spoken-word challenge proves **completion of the audio interaction**, **not ownership of the phone number**, and that OTP-based phone verification is a future requirement.
- The inaccuracy that "the correct word never reaches the browser" was corrected: the 3 options (including the right word) *are* sent — the server simply never tells the client **which** option is correct; only the audio reveals that.
- `PROJECT-DOCUMENTATION.md` §6.1 updated with the same distinction; the "optional OTP" idea was reworded to a **future security requirement**.
- No OTP provider was introduced and none is faked.

---

## 2. Files modified and created

| File | Status | What changed |
|---|---|---|
| `security.js` | **new** | Reusable middleware: `requestId`, `securityHeaders`, `sameOrigin`, `contentLength`, `errorHandler`, `validateJwtSecret`, exported `CSP`. Plain CommonJS, zero new dependencies. |
| `server.js` | modified (+171 / −42) | Wired the middleware chain; per-shop TTS limiter; hardened STT/TTS routes; Gnani timeouts + safe error mapping; log scrubbing; JWT validation; auth-comment corrections (H); JSON 404 + final error handler; `module.exports = { app }` + listen-only-when-direct (testable); optional `TRUST_PROXY`; optional `TTS_CACHE_DIR` (tests). |
| `test-security.js` | **new** | 81-check hermetic security suite (mocked Gnani, locally minted sessions, zero Supabase traffic). |
| `package.json` | modified | `test` script now runs `test-parser && test-resolver && test-security`. **No dependency changes**; `package-lock.json` untouched. |
| `README.md` | modified | New "Security" section + updated test instructions. |
| `SECURITY-HARDENING.md` | **new** | This file. |
| `PROJECT-DOCUMENTATION.md` | untracked (never pushed) | Task-H terminology corrections only. |

Unchanged on purpose: `public/*` (no UI changes), database schema, ledger semantics, Gnani model/voice settings, rate-limit policies for existing routes.

**Middleware chain (order matters):**
`requestId → securityHeaders → sameOrigin → static → STT content-type guard → express.json(64kb) → cookieParser(signed) → … → requireAuth(/api) → route rate-limiters → handlers → JSON 404 → JSON error handler`.

---

## 3. New configuration

### Environment variables

| Variable | Required? | Meaning |
|---|---|---|
| *(none new required)* | — | Existing `.env` keeps working unchanged. |
| `APP_ORIGIN` | optional | Comma-separated extra origins allowed by the CSRF check (e.g. `https://app.example.com`) when the app is served from a different origin than the `Host` header. |
| `TRUST_PROXY` | optional | Set `1` (or hop count) **only** behind a trusted reverse proxy so rate limits see real client IPs (default: off). |
| `TTS_CACHE_DIR` | test-only | Overrides the word-audio cache directory. `test-security.js` points it at a temp dir so tests never write into `data/tts-cache/`. Not needed in production. |

### Rate limits (unchanged policy, TTS added)

| Route group | Limit | Key |
|---|---|---|
| `auth/start`, `auth/challenge`, `auth/signup` | 30 / 15 min | IP |
| `auth/challenge/answer`, `auth/login` | 30 / 15 min | IP + phone |
| challenge audio | 60 / min | IP |
| **STT** | **60 / min** | **IP + shop** (pre-existing) |
| **TTS** | **60 / min** | **IP + shop** (**new, separate bucket**) |

### Timeouts

Gnani TTS 15 s · Gnani STT 30 s · `contentLength` guards evaluate before handlers.

---

## 4. Security audit — findings by area

Audited without breaking changes. "✅" = verified sound as-is (now also covered by tests where noted); "📄" = documented, deliberately not implemented (needs a migration or a business decision).

| Area | Finding | Status |
|---|---|---|
| **Auth lockout** | 5 failed PINs → `locked_until` = +15 min (429, Telugu); counters reset on success; login errors generic (`ఫోన్ నంబర్ లేదా పిన్ సరిలేదు`) — no user enumeration; per IP+phone login limiter. | ✅ unchanged |
| **JWT / cookie** | `session` = signed JWT `{shopId, phone}`, 30 days, **httpOnly + SameSite=Lax**, `secure` in production; tamper → 401. No server-side revocation (stolen cookie valid until expiry). | ✅ / 📄 R2 |
| **Shop isolation** | Every query filters `.eq('shop_id', req.shop.id)`; client ids re-verified; cross-shop read/write/merge/delete/post → **404**. Verified live: 5 isolation checks in the curl suite (§5). | ✅ tested |
| **Customer merge** | Cross-shop merge → 404; same-id → 400; B's data survived A's merge attempt. Merge itself is **not atomic** (multi-step, no transaction). | ✅ / 📄 R4 |
| **Transaction delete** | Today's (IST) entries only → 403 otherwise; cross-shop → 404; scope re-checked after fetch. | ✅ tested |
| **STT endpoint** | auth + 60/min/shop + `audio/*` 415 + min-size 400 + 5 MB cap + 30 s timeout + forwards only 2 safe fields + no transcript/payload logging. | ✅ hardened + tested |
| **TTS endpoint** | Was **unauthenticated and unvalidated** (anyone could burn credits). Now auth + separate 60/min/shop bucket + strict body rules + 8 KB/64 KB caps + 15 s timeout + safe 502/504 mapping. | ✅ hardened + tested |
| **Challenge replay** | Single-use (wrong answer burns it), 2-minute TTL, phone-bound `voiceOkToken` (5 min), correct-option mapping never sent, server-memory only, TTL sweeper. Lives in RAM → cleared on restart / per process. | ✅ / 📄 R3 |
| **PIN hashing** | bcrypt, 10 rounds, 4-digit PIN (well under bcrypt's 72-byte limit); hash never logged or returned. | ✅ unchanged |
| **XSS (frontend)** | All render sites escape user data through `esc()` (`& < > " '`, 62 uses); heuristic scan of every `innerHTML` template found **0** unescaped user-data interpolations; strict CSP (`script-src 'self'`, no `unsafe-inline`) blocks inline handlers/scripts even if a future site forgets `esc()`. | ✅ + defense-in-depth |
| **Secret handling** | `.env` gitignored and never tracked; Gnani/Supabase keys server-side only, never in `public/`; startup logs state (`configured`/`MISSING`), never values or lengths; JWT validation never echoes the secret (tested). | ✅ tested |
| **Error handling** | JSON-only final handler (no HTML stack traces), maps body-parser failures to 400/413, logs only category + request id; unknown `/api` routes → JSON 404. | ✅ tested |
| **Logging** | 14 statements total, all non-sensitive (§C). Frontend logs nothing (`console.*` absent from `public/`). | ✅ audited |
| **CSRF (residual)** | Origin check + SameSite=Lax + signed cookie. Non-browser clients without `Origin` are allowed unless `Sec-Fetch-Site: cross-site` (explicit policy, §6 L2). | ✅ / 📄 L2 |

---

## 5. Tests executed and exact results

All suites run on Windows/PowerShell against this working tree. Baselines preserved.

### Regression suites (existing baselines)

| Suite | Command | Result |
|---|---|---|
| Parser | `node test-parser.js` | **5 passed, 0 failed** ✅ |
| Resolver | `node test-resolver.js` | **13 passed, 0 failed** ✅ |
| Flow harness | `node data/kv-flow-test.js` | **24 passed, 0 failed** ✅ |
| DOM harness | `node data/kv-dom-test.js` | **55 passed, 0 failed** ✅ |
| API curl suite (real Supabase) | `node data/kv-fixture.js --create` → `data/kv-curl.ps1` → `--clean` | **38 passed, 0 failed** ✅ |
| `npm test` (all of the above + security) | `npm test` | exit 0 ✅ |

The curl suite ran against the **real Supabase project with your permission**: it created only `ZZTest Shop A/B`, ran all 38 checks (including 5 cross-shop isolation checks), then deleted every row, cookie jar, and body temp file it created. Your own shop data was never read or modified. Fixture output: `cleaned ZZTest Shop A/B … removed kv-a.jar, kv-b.jar`.

### New security suite — `node test-security.js`: **81 passed, 0 failed** ✅

Hermetic: Gnani provider **mocked** (zero credits spent), sessions minted locally as signed JWTs, word-audio cache redirected to a temp dir (removed on exit), **no Supabase reads/writes**. Covers the 16 mandated cases:

| # | Required case | Check(s) in `test-security.js` |
|---|---|---|
| 1 | Unauthenticated TTS → 401 | `TTS unauthenticated -> 401` + Telugu JSON body |
| 2 | Authenticated TTS succeeds (mocked) | `TTS authenticated -> 200 audio/wav`, bytes match mock, provider hit counted |
| 3 | TTS rejects empty text | empty → 400, whitespace-only → 400 |
| 4 | TTS rejects non-string text | number / null / array / missing → 400 each |
| 5 | TTS rejects > 1000 chars | 1001 → 400; exactly 1000 → 200 |
| 6 | TTS rate limit per shop | #61 → 429 (first 429 at exactly 61), other shop still 200, limited requests **never reach Gnani** |
| 7 | STT rate limit functional | #61 → 429; TTS bucket independent (`TTS bucket independent from STT bucket`) |
| 8 | Invalid audio rejected | < 1000 bytes → 400; non-audio Content-Type → **415** (checked before body parsing) |
| 9 | Gnani timeouts handled | TTS timeout → **504**, STT timeout → **504**, Telugu bodies, no `TimeoutError` text |
| 10 | Provider errors not exposed | upstream 500 → **502** for TTS and STT; sentinel `UPSTREAM-SECRET-…` never appears in any response; network failure leaks no `ECONNREFUSED` |
| 11 | Security headers present | 16 header checks incl. CSP without `unsafe-inline`, Google Fonts allowed, HSTS **absent** in dev, present in prod spawn, `X-Powered-By` gone, headers on API 401s |
| 12 | Cross-origin mutations rejected | evil `Origin` → 403 (TTS + PUT `/api/me`), `Origin: null` → 403, no-Origin + `Sec-Fetch-Site: cross-site` → 403, cross-origin challenge answer → 403 |
| 13 | Same-origin mutations still work | same-origin TTS → 200, challenge answer → `voiceOkToken` (retried because options are shuffled), logout → 200 + HttpOnly cookie cleared |
| 14 | Weak prod JWT secret fails startup | spawn tests: placeholder/short/repeated-char → exit 1 + `FATAL`, secret **never printed**; unit checks for all rejection rules |
| 15 | Valid prod config starts | strong secret → starts; sends HSTS + CSP; startup log contains no secret values |
| 16 | Cross-shop isolation intact | **covered by the curl suite** (§above): PATCH/transactions/delete/merge/post cross-shop → 404, scoping checks — the security suite itself makes zero DB calls |

Extra checks beyond the 16: bad-JSON → 400 JSON (not HTML), 8 KB → 413, 64 KB → 413 JSON, wrong content-type → 415, CSP export matches the applied header, validation messages never contain the secret, JSON 404 for unknown `/api` routes, challenge audio served.

### Live provider smoke test (real Gnani, 2 calls + cached challenge)

Run against the hardened server with a real fixture session, then cleaned up:

- `GET /api/auth/challenge` → **200**, 3 options; challenge audio → **200 audio/wav, 30,764 bytes** (cache hit).
- `POST /api/tts` (authenticated, real Gnani Timbre) → **200 audio/wav, 76,844 bytes**.
- `POST /api/stt` (authenticated, real 30 KB Telugu WAV, real Gnani Prisma) → **200**, body keys exactly `transcript, detected_language_code` — verified programmatically that **no raw payload keys** (`success`, `request_id`, …) are present.
- Server log during these calls: `[tts] id=… upstream=200 bytes=76844`, `[stt] id=… upstream=200 transcript_chars=8` — no transcript text, no payloads.

Syntax checks: `node --check server.js`, `node --check security.js`, `node --check test-security.js` — all pass.

**No test failed.** (An initial 2 failures during development were fixed before delivery: STT wrong-content-type now returns 415 instead of a JSON parse error; the challenge-answer test now retries because the correct option is shuffled — and the suite now redirects the word cache to a temp dir after it was found writing mock WAVs into `data/tts-cache/`; the 2 affected mock files were identified and deleted, leaving the 20 real cached words untouched.)

---

## 6. Known limitations

- **L1 — The audio challenge is NOT phone verification.** It proves a human completed the audio interaction (heard the word and picked it). Anyone who knows a shop's phone number and can play the audio can pass it; the 4-digit PIN is the real secret. **Proper phone-ownership verification (OTP via SMS/WhatsApp) is a future security requirement** — no provider is configured and none is faked. Do not market or document this flow as phone verification.
- **L2 — Missing-`Origin` policy.** Requests without an `Origin` header are allowed unless `Sec-Fetch-Site: cross-site` marks them cross-site — required so curl, server-to-server clients, and the test suites keep working (modern browsers always send `Origin` on mutations, so browser CSRF is covered). Residual risk: a very old browser that sends neither header on a cross-site POST; mitigated by `SameSite=Lax` + the signed cookie. Documented as the explicit trade-off.
- **L3 — In-memory state.** Challenges, rate-limit counters, and in-flight synthesis dedup live in process memory: a restart clears them (a user mid-login just retries), and multi-instance deployments would each have their own buckets/challenges. Single-process deployment is assumed.
- **L4 — No server-side session revocation.** A stolen 30-day cookie stays valid until expiry or secret rotation (see R2).
- **L5 — CSP is validated against the current frontend only.** Adding inline scripts/styles/event handlers later will break under this policy by design — update `security.js` consciously, don't add `unsafe-inline`.
- **L6 — HSTS only with `NODE_ENV=production`.** Plain-HTTP development must never receive it.
- **L7 — Behind a reverse proxy, set `TRUST_PROXY=1`** or all clients share the proxy's IP bucket (a few users can exhaust it and cause false 429s).
- **L8 — This was a targeted hardening pass, not a professional security audit.** A baseline `npm audit --omit=dev` was run for this pass and found **0 known dependency vulnerabilities** (2026-11-04), but ongoing monitoring is not automated. Not covered: infrastructure/Supabase-side configuration (RLS, network exposure), physical/device security, and formal penetration testing.

---

## 7. Outstanding security risks (not implemented)

Documented rather than speculatively built — each needs a schema migration and/or a product decision:

- **R1 — Phone-ownership verification (OTP).** See L1. Requires choosing an SMS/WhatsApp provider, cost/rate decisions, and schema/flow changes. **Future requirement.**
- **R2 — Session revocation / shorter session lifetime.** Needs a server-side sessions table (migration) or a token denylist; today only cookie clearing + 30-day expiry + optional `JWT_SECRET` rotation exist. Business decision on acceptable session length.
- **R3 — Shared state for scale-out.** Moving challenges + rate counters to Redis/DB is required before running more than one instance (also fixes restart-loss of in-flight logins).
- **R4 — Atomic merge.** `POST /api/customers/merge` is multi-step without a transaction; a crash mid-merge can split data. Fix = single Postgres RPC/transaction (migration) — already noted as a Phase-C idea.
- **R5 — Daily spend quota.** 60/min per shop still allows a *malicious authenticated shop* to sustain heavy Gnani usage against the app owner's account. A daily per-shop (and global) credit quota is a business decision.
- **R6 — `JWT_SECRET` rotation runbook.** If the secret ever leaks: rotate deliberately (invalidates all sessions — users must re-login), redeploy, then verify. Never rotate casually; never auto-rotate (explicitly not implemented).
- **R7 — Escaping discipline.** `esc()` must be used at every future `innerHTML` interpolation of user data; the CSP is the backstop, not the primary defense.
- **R8 — Supabase service key = full database access.** It must never leave the server; if it ever leaks, rotate it in the Supabase dashboard immediately (app restart only — no session impact).

---

## 8. Deployment considerations

1. **No `.env` changes are required** for existing setups — the app starts with the current `.env` as-is. Optional: `APP_ORIGIN`, `TRUST_PROXY` (§3).
2. **`JWT_SECRET` strength:** development only warns; **production refuses to start** with a weak/placeholder secret. If yours is weak, generate a strong one:
   ```
   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
   ```
   ⚠️ **Changing `JWT_SECRET` logs out every existing session** (signed cookies/JWTs become invalid → users see "session expired, log in again"). Do this as a conscious decision, ideally together with R6's runbook — never automatically.
3. **Production mode:** run with `NODE_ENV=production` to enable HSTS + the strict secret check. Behind TLS termination also set `TRUST_PROXY=1` (L7), and `APP_ORIGIN=https://your-domain` if the proxy rewrites the `Host` header.
4. **Pre-deploy:** `npm test` (runs parser 5, resolver 13, security 81) and optionally the fixture+curl suite (38) against staging — never against production data.
5. **Post-deploy verification (browser):** login flow (challenge audio plays, PIN works), TTS playback, STT recording, Google Fonts rendering, and an empty DevTools console (a CSP violation there means something new needs a policy entry — fix the entry, don't add `unsafe-inline`).
6. **No dependency changes:** `package.json` differs only in the `test` script; `package-lock.json` is untouched; `npm install` adds nothing new.
7. **Rollback:** `git revert` the hardening commit, or reset to the baseline tag:
   ```
   git checkout security-baseline   # or: git revert <hardening-commit>
   ```
8. **Do not run** `data/kv-fixture.js` against production databases without understanding it inserts and deletes `ZZTest Shop A/B` rows (it never touches other shops).

---

*Delivered as a hardening pass over the working Phase-B application. Every pre-existing test still passes at its baseline (5 / 13 / 24 / 55 / 38), the new 81-check security suite passes, and the two riskiest integrations (Gnani TTS/STT) were re-verified against the real provider. This is a meaningful security improvement — it is not a claim that the application is production-secure; L1–L8 and R1–R8 remain open.*
