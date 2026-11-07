# Khata Vani (ఖాతా వాణి) — Complete Project Documentation

> Voice-first ledger (udhaar khata) for small Indian shops. Telugu first, English second.
> This document covers the project A–Z: status, tech stack, architecture, every feature,
> every API, the database, security, tests, and what comes next.

---

## 1. Project Overview

| | |
|---|---|
| **Name** | Khata Vani — ఖాతా వాణి (literally "voice of the ledger") |
| **What it is** | A mobile-first web app that lets a shopkeeper run their credit ledger **entirely by voice**, in Telugu (with Hindi/English support), instead of writing a paper bahi khata |
| **Target user** | Small kirana/general stores, tailors, drivers — shopkeepers who are comfortable speaking Telugu but not typing |
| **Core promise** | Speak *"Ramesh ki 500 udhaar"* → the app records ₹500 credit to Ramesh. Ask *"Ramesh ki entha baaki"* → it speaks the balance back |
| **Version** | 0.2.0 (`package.json`) |
| **Status** | Phase A + Phase B complete and pushed; Dashboard/Reports are Phase C placeholders |
| **Repo** | `https://github.com/chethanregala/Khata_Vani.git` (branch `main`) |
| **License/visibility** | Private working repo of the developer |

### Design philosophy
- **Voice-first**: the mic is the primary input; text entry exists only for onboarding and corrections.
- **Telugu first, English second**: every label, message, error, and TTS sentence is Telugu with English as a secondary line (e.g. `ఇచ్చిన ఉద్దెర / Credit given`).
- **No LLM**: speech understanding is done with a deterministic rule-based parser + a name resolver — fast, offline-ish, testable, zero inference cost.
- **Server-side ledger**: all data lives in Supabase; no localStorage ledger, so the data survives device changes.
- **Confirmation before commitment**: nothing is saved until the shopkeeper hears the entry read back and taps ✅.

---

## 2. Current Status (as of Phase B)

### ✅ Done and pushed (commit `4c9989e "phase B"`)

**Backend (`server.js`, 522 lines)**
- Auth without OTP: phone → voice-word challenge → 4-digit PIN (signup/login/logout).
  **Identity limitation:** the challenge proves the audio interaction completed — it does **not** verify ownership of the phone number (OTP = future security requirement, see `SECURITY-HARDENING.md`).
- Ledger CRUD scoped to the logged-in shop: customers, transactions, plus the Phase B routes:
  - `PATCH /api/customers/:id` (edit name/label/phone/aliases)
  - `POST /api/customers/merge` (move transactions, keep old name as alias, delete duplicate)
  - `GET /api/customers/:id/transactions` (timeline)
  - `DELETE /api/transactions/:id` (**today's IST entries only** — undo a mistake)
  - `GET /api/customers` now includes `last_payment_at`
  - `GET /api/transactions?recent=N` (N = 1–50) for the Home "last 5 entries" list
- STT/TTS proxy to Gnani behind auth + per-shop rate limits; word-level TTS cache.

**Name resolution (`public/resolver.js`, 108 lines)**
- Plain JS, DOM-free, Node-unit-testable like `parser.js`.
- Pipeline: exact match → label narrowing → Levenshtein-1 fuzzy.
- Returns status `none | one | many | fuzzy` with candidate list.
- Normalizes Telugu honorific suffixes (`కి`, `కు`, `గారు`, `గారికి`) on **both** sides of the comparison.

**Frontend (`public/app.js`, 1307 lines + `public/styles.css`, 396 lines)**
- Hash-routed SPA with 9 routes and a **4-tab bar** (Home / Customers / Dashboard / Reports) always visible on main screens.
- Home voice flows for all four resolver statuses:
  - `none` → "New customer <name>. Add?" card with editable name/label/phone
  - `one` → normal ✅/❌ confirm card (with a "➕ Different person?" escape hatch for same-name customers)
  - `fuzzy` → "Did you mean …?" — ✅ saves the spoken spelling as an **alias** so it matches exactly next time
  - `many` → bottom **chooser sheet** read out in Telugu (`ఒకటి: Ramesh, రెండు: Ramesh`), pickable by tap **or by saying the number** (Telugu/Hindi/English numerals go through `/api/stt`)
- **Multi-entry sentences**: one utterance split into several entries (separators below), one TTS read-back, one ✅/❌, per-row 🗑 delete, saved sequentially.
- **Voice queries**: `<name> ki entha baaki` (balance), `ee roju entha udhaar` / `today's credit` (day totals), `top 3 baaki` (top balances) — answered by speech + an on-screen result card.
- Customers screen: search (name/label/phone/alias), sort chips (highest balance / recent), red **Overdue 30+ days** badge, per-row 🔊 reminder (speaks a polite Telugu reminder and downloads the .wav so it can be sent on WhatsApp).
- Customer detail: balance header, **Receive payment**, **Edit**, **Merge**, **Reminder**, transaction timeline with per-entry 🗑 undo (today only).
- Dashboard & Reports: rendered "త్వరలో వస్తోంది · Coming soon" placeholders (Phase C).
- UI polish: animated mic rings while recording, Today strip (credit given / collected), last-5 entries, empty states, loading skeletons, inline SVG logo.

**Tests**
- `npm test` → `test-parser.js` **5/5** + `test-resolver.js` **13/13** (12 named cases + empty-input edge).
- API curl suite: **38/38** including cross-shop 404s and no-session 401s.
- Flow harness (`data/kv-flow-test.js`, gitignored): **24/24**.
- DOM harness with jsdom (`data/kv-dom-test.js`, gitignored): **55/55**, zero runtime errors.

**Docs**: `README.md` updated with run instructions, tests, and a Phase B summary.

### ⏳ Not started (Phase C)
- **Dashboard** — weekly totals, trends (tab exists, placeholder shown).
- **Reports** — printable/shareable statements (tab exists, placeholder shown).

### 🟡 Known limitations
- Dashboard/Reports have no data views yet.
- Balance/top-N queries compute from the already-loaded customer list (fine for a shop's scale; no pagination).
- Merge is not transactional across the three DB writes (Supabase JS has no multi-statement tx here); a mid-way failure would need manual cleanup.
- Voice recognition quality depends on the Gnani Prisma model; unknown scripts/accents fall back to the `none`/`fuzzy` prompts.
- The `data/` directory (TTS cache + test tooling) is gitignored — a fresh clone re-synthesizes the 30 challenge words on first use.

---

## 3. Tech Stack

### Runtime & language
| Layer | Choice | Version (installed) |
|---|---|---|
| Runtime | **Node.js** (CommonJS, `"type": "commonjs"`) | v24.22.1 (dev machine) |
| Package manager | npm | 12.2.1 |
| Language | **JavaScript, vanilla ES2020+** — no TypeScript, no transpiler | — |
| Build step | **None** — `public/` files are served as-is | — |

### Backend
| Concern | Library |
|---|---|
| HTTP server | **Express 4** (`express@4.22.3`) |
| Database | **Supabase** (`@supabase/supabase-js@2.118.0`) — Postgres via REST, **service-role key kept server-side only** |
| Sessions | **JWT in a signed httpOnly cookie** (`jsonwebtoken@9.0.3` + `cookie-parser@1.4.7`) |
| Passwords | **bcryptjs@3.0.3**, 10 rounds (4-digit PINs are hashed, never stored raw) |
| Rate limiting | **express-rate-limit@8.7.2** (per-IP and per-shop keys) |
| Config | **dotenv@16.6.1** (`.env` is gitignored) |
| Voice APIs | **Gnani AI** (`https://api.vachana.ai`) — STT + TTS, called with plain `fetch` |

### Frontend
| Concern | Choice |
|---|---|
| Architecture | Single-page app, **hash router** (`#/home`, `#/customers`, …), vanilla DOM |
| Files | `index.html` (20 lines), `api.js` (fetch wrapper), `app.js` (all views + voice logic), `parser.js`, `resolver.js`, `styles.css` |
| Styling | Hand-written CSS, mobile-first, CSS custom properties, no framework |
| Font | **Noto Sans Telugu** (Google Fonts) with system-ui fallback |
| Audio in | `MediaRecorder` → `AudioContext`/`OfflineAudioContext` downsample to **16 kHz mono PCM16 WAV** → POST `/api/stt` |
| Audio out | `new Audio(blob)` from `/api/tts`; single TTS playback at a time |
| State | One in-memory `state` object; **no localStorage** for ledger data |

### Testing & tooling
- **Unit tests**: plain Node scripts (`test-parser.js`, `test-resolver.js`) wired to `npm test`.
- **API tests**: PowerShell + `curl.exe` suite (`data/kv-curl.ps1`, gitignored) with a temp fixture (`data/kv-fixture.js`) and cookie jars.
- **Flow tests**: Node harness driving parser→resolver→handler logic (`data/kv-flow-test.js`).
- **DOM tests**: `jsdom@30.1.3` installed with `npm i --no-save` (package.json/lock untouched) driving `public/app.js` (`data/kv-dom-test.js`).
- All throwaway tooling lives in gitignored `data/`.

### Third-party services
| Service | Used for | Endpoints called |
|---|---|---|
| **Gnani AI** (vachana.ai) | Speech-to-text | `POST /stt/v3` — model `prisma-v3.0`, language `indic-auto` (auto-detects te/hi/en) |
| **Gnani AI** | Text-to-speech | `POST /api/v1/tts/inference` — model `timbre-v2.5`, voice `Nalini`, language `te-IN`, 24 kHz mono WAV |
| **Supabase** | Postgres database + auth-free persistence | Tables `shops`, `customers`, `transactions` |
| **Google Fonts** | Noto Sans Telugu | stylesheet link in `index.html` |

---

## 4. Project Structure

```
khata-vani/
├── server.js                 # Express app: auth, STT/TTS proxy, ledger API (522 lines)
├── package.json              # v0.2.0, scripts: start, test
├── package-lock.json
├── .env                      # GNANI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY, JWT_SECRET, …  (GITIGNORED)
├── .env.example              # template with placeholder values + instructions
├── .gitignore                # .env, node_modules/, data/, *.log
├── README.md                 # quick start + Phase B summary
├── PROJECT-DOCUMENTATION.md  # this file (not pushed to GitHub)
├── test-parser.js            # 5 parser cases
├── test-resolver.js          # 13 resolver cases
├── public/                   # static frontend (no build)
│   ├── index.html            # shell: font, styles, 4 script tags
│   ├── styles.css            # full design system (396 lines)
│   ├── api.js                # api() + apiAudio() fetch wrappers
│   ├── app.js                # router, views, voice pipeline, chooser, queries (1307 lines)
│   ├── parser.js             # rule-based speech → {name, amount, type} (89 lines)
│   └── resolver.js           # customer name → none|one|many|fuzzy (108 lines)
└── data/                     # GITIGNORED scratch space
    ├── tts-cache/*.wav       # one cached WAV per challenge word (sha1-named)
    ├── kv-fixture.js         # creates/destroys temp test shops in Supabase
    ├── kv-curl.ps1           # 38-case API curl suite
    ├── kv-flow-test.js       # 24-case flow harness
    ├── kv-dom-test.js        # 55-case jsdom harness
    ├── kv-schema.js          # prints table columns (never secrets)
    └── kv-ids.json           # fixture ids for the curl suite
```

---

## 5. Architecture & Data Flow

### 5.1 Voice entry (the core loop)

```
User taps 🎤 (Home)
  → MediaRecorder captures mic (max 20 s, tap again to stop early)
  → blob decoded & resampled to 16 kHz mono PCM16 WAV (client-side)
  → POST /api/stt  (session cookie + per-shop rate limit)
  → Gnani Prisma STT → raw transcript (te/hi/en auto)
  → classifyQuery(raw) in app.js            ── query? ─→ runQuery() → speak answer + result card
  → splitTranscript(raw) on separators        (",", " and ", " aur ", " mariyu ", మరియు, और, తరువాత)
  → buildEntries(parts) via parse()           (amount never copied across parts)
  → 1 entry  → resolve(name, customers)
        one   → confirm card → ✅ → POST customer (if new) + POST transaction → TTS "నమోదు చేశాను."
        many  → chooser sheet (tap or speak the number → /api/stt → numberFrom())
        fuzzy → "Did you mean?" → ✅ saves alias → confirm card
        none  → "New customer?" card (editable name/label/phone) → ✅ creates + saves
  → many entries → batch card (per-row 🗑, one ✅) → saved sequentially
  → all balances/totals refresh → Home strip + last-5 re-render
```

### 5.2 Read-back & feedback
Every confirmation is **spoken** via `POST /api/tts` (Gnani Timbre, Telugu voice). The server caches each synthesized word at `data/tts-cache/<sha1(word)>.wav`, so the 30 auth challenge words cost Gnani credits only once each; in-flight synthesis is de-duplicated with a `Map`.

### 5.3 Routing (frontend hash routes)
| Route | View |
|---|---|
| `#/splash` | Logo splash (1.8 s) → routes by `/api/me`: login / profile / home |
| `#/login` | Phone entry (+91, 10 digits, must start 6–9) |
| `#/verify` | Voice-word challenge + PIN pad (enter or create) |
| `#/profile` | Onboarding: owner name, shop name, address (all required) |
| `#/home` | Mic + today strip + confirm panel + last 5 entries + tab bar |
| `#/customers` | Search, sort chips, customer cards, 🔊 reminders |
| `#/customer/:id` | Detail: balance, Receive payment / Edit / Merge / Reminder, timeline |
| `#/dashboard` | Placeholder (Phase C) |
| `#/reports` | Placeholder (Phase C) |

---

## 6. Feature Details

### 6.1 Authentication (no OTP — voice challenge + PIN)

> ⚠️ **Identity limitation:** the spoken-word challenge verifies that the login session **completed the audio interaction** (heard the word, picked it) — it is **not proof of phone-number ownership**. Anyone who knows the number and can play the audio may pass it; the PIN is the real secret. Proper phone verification (OTP) is a documented **future security requirement** (`SECURITY-HARDENING.md`) — no OTP provider is configured and none is faked. Do not describe this flow as phone verification.

1. **Phone** — `POST /api/auth/start` tells the client whether the number already has an account (signup vs login path).
2. **Voice challenge** — `GET /api/auth/challenge?phone=…` picks a random Telugu kirana word (30-word bank: కందిపప్పు, బియ్యం, పంచదార, …), synthesizes/caches its audio, and returns 3 options (correct + 2 decoys, shuffled). The server never tells the client **which** option is correct — only the audio reveals that (the option *texts*, including the right word, do reach the browser; the answer mapping stays in server memory).
   - `GET /api/auth/challenge/audio/:id` serves only that challenge's WAV (7-day browser cache OK — it's a public grocery word).
   - `POST /api/auth/challenge/answer` is **single-use**: wrong answer, replay, expiry (2 min), or wrong phone burns the challenge. Correct → `voiceOkToken` JWT (5 min, bound to phone).
3. **PIN** — 4 digits (signup asks twice). `POST /api/auth/signup` or `/api/auth/login`, both requiring a valid `voiceOkToken`.
   - PINs hashed with bcrypt (10 rounds).
   - **Lockout**: 5 failed PINs → `locked_until` = now + 15 min (HTTP 429 with Telugu message).
   - Login errors are generic (`ఫోన్ నంబర్ లేదా పిన్ సరిలేదు`) — never reveals whether a phone exists.
4. **Session** — `session` cookie: JWT `{shopId, phone}`, 30 days, **httpOnly + signed + sameSite=lax**, `secure` only in production.

### 6.2 Speech parsing — `public/parser.js` (rule-based, no LLM)
`parse(raw)` → `{ type: 'credit'|'pay'|'query', amount, name, raw }`

- **Amount**: prefers literal digits (`500`, `1,000` → 1000 after comma strip); falls back to number-words with multiplication (`ఐదు వందలు` / `पाँच सौ` / `five hundred` → 500). Number-word table covers Telugu, Hindi, English, **plus Devanagari and Telugu transliterations of English** (`फाइव`, `ఫైవ్`) because the STT may romanize.
- **Type precedence**: query words (`entha/ఎంత/kitna/balance…`) unless a strong-pay word is present → `query`; strong pay (`jama/జम/paid/కట్టా…`) → `pay`; credit words (`udhaar/ఉద్దెర/appu/అప్పు/baaki/బాకీ…`) → `credit`; weak pay (`ichindi/ఇచ్చింది/diya…`) → `pay`.
- **Name**: strips digits, consumed number-words, all keywords, stopwords (`ki ko ku rupees rs garu`, `రూపాయలు రూ …`), punctuation, then trailing Telugu suffixes (`గారికి/కి/కు`).
- Telugu/Hindi/English digit characters (`౦-౯`, `०-९`) are normalized to ASCII first.
- ZWNJ/ZWJ stripped; NFC normalized.

### 6.3 Name resolution — `public/resolver.js`
`resolve(spoken, customers)` → `{ status, candidates[] }`

| Step | Rule |
|---|---|
| normalize | lowercase, strip ZWNJ/ZWJ + punctuation, collapse spaces, strip trailing `గారికి/గారు/కి/కు` — applied to utterance **and** stored names/aliases/labels |
| **exact** | normalized utterance === name or any alias → `one` (or `many` if several match) |
| **label narrowing** | extra tokens that match a customer's label shortlist the base name (`"Ramesh tailor"` → the tailor Ramesh). If the extra token matches no label, falls back to the base-name hits so nothing becomes unreachable |
| **fuzzy** | Levenshtein ≤ 1 against names/aliases of ≥ 4 chars → `fuzzy`. A Telugu-script utterance vs a Latin-script name is deliberately **not** a near-miss → `none` (the app then asks "New customer?" instead of guessing) |
| else | `none` |

`resolve.normalize` and `resolve.levenshtein` are exported for reuse (customers search uses `normalize`).

### 6.4 Multi-entry & context carry-over
- Separators: `,` (must be followed by whitespace or end-of-string, so **`1,000` stays one amount**), `" and "`, `" aur "`, `" mariyu "`, `మరియు`, `और`, `తరువాత`.
- `buildEntries(parts)`: a later part lacking a name or type inherits the previous entry's (`"Ramesh 500 udhaar, 200 jama"`), but **the amount always comes from the part itself** — never copied.
- One TTS sentence for the whole batch, one ✅/❌, 🗑 removes a row before saving, entries save sequentially (each may create its customer first).

### 6.5 Voice queries — `classifyQuery(raw)` in `app.js`
| Pattern | Kind | Answer |
|---|---|---|
| `top N …baaki/entha…` (or `టాప్`) | `top` | speaks top-N balances (default 3, cap 10), shows result card |
| `ee roju / ఈ రోజు / today` + money or credit words | `day` | today's (IST) credit given vs collected, spoken + card |
| `<name> ki entha baaki` (parser type `query`) | `name` | balance via resolver — `many` opens the chooser, `fuzzy` asks "did you mean?" |

Classification reads the **raw transcript** so `parser.js` (whose `parse()` is shared and heavily tested) stays untouched for entries.

### 6.6 Ledger semantics
- **Balance** = Σ credit − Σ pay (computed server-side in `GET /api/customers`).
- **`last_activity`** = latest transaction of any type; **`last_payment_at`** = latest `pay`.
- **Overdue** (client): `balance > 0` and no payment in the last 30 days (never paid → measured from `created_at`) → red `30+ రోజుల ఆలస్యం` badge.
- **Undo**: `DELETE /api/transactions/:id` only for entries created **today in Asia/Kolkata** (server checks IST day range; otherwise 403). UI shows 🗑 only on today's timeline rows.
- **Merge**: transactions re-parented to the kept customer; removed name + its aliases appended to the kept customer's aliases (deduped, cap 20) so old voice commands still resolve.
- **Aliases**: saved when (a) a fuzzy match is confirmed, (b) a chooser pick is made (spoken spelling remembered), (c) a merge happens.

### 6.7 UI/UX design system (`styles.css`)
| Token | Value |
|---|---|
| Background | white `#fff` |
| Primary green | `#0a7d4b` (dark `#086239`, soft `#e8f5ee`) |
| Danger red | `#d32f2f` / soft `#fdecea` |
| Amber (credit/owed) | `#b26a00` / soft `#fff4e0` |
| Radius | **16px** cards/buttons (`--r`), 999px pills |
| Base font | **16px** minimum; titles 24px; balances 21–27px |
| Touch targets | **≥48px** (buttons `min-height: 48px`, mic 128px, tabs 62px) |
| Font | `'Noto Sans Telugu', system-ui, …` |
| Layout | max-width 520px `.screen`, mobile-first, safe-area insets for notches |
| Tab bar | fixed bottom, 4 tabs, active tab green with soft gradient |
| Mic | 128px circle + **3 animated concentric rings** while recording (turns red) |
| Feedback | `.skel` shimmer skeletons, `.empty` icon+Telugu+English empty states, sheet slides up (`.22s`) |
| Accessibility | `aria-label`s in Telugu, `role="button"` + Enter key on cards, `aria-live` PIN dots, `lang="te"` |

### 6.8 Localization rules
- Telugu first, English second everywhere (`ధ్వని ధృవీకరణ`, `Receive payment`, …).
- Money formatted `₹1,25,000` via `Intl.NumberFormat('en-IN')`.
- Relative time bilingual: `2 రోజుల క్రితం · 2 days ago`.
- Spoken numbers for chooser use Telugu numerals (`ఒకటి, రెండు, …`); `numberFrom()` also accepts English and Hindi (`one, two, ek, do, teen…`) and digits.

---

## 7. Backend API Reference

Base URL: `http://localhost:3000`. All `/api/*` routes except `/api/auth/*` require the signed `session` cookie (`requireAuth`) — **401** otherwise. Every client-supplied id is re-checked against `req.shop.id` (from the session, never the body) — cross-shop access returns **404**.

### Auth (public, rate-limited)
| Method & path | Body/Query | Returns | Notes |
|---|---|---|---|
| `POST /api/auth/start` | `{phone}` | `{exists}` | 10-digit Indian mobile `6-9…` |
| `GET /api/auth/challenge` | `?phone=` | `{challengeId, audioUrl, options[3]}` | word generated + cached; 2-min TTL |
| `GET /api/auth/challenge/audio/:id` | — | WAV | only that challenge's word |
| `POST /api/auth/challenge/answer` | `{challengeId, phone, choice}` | `{voiceOkToken}` | single-use; wrong answer burns it |
| `POST /api/auth/signup` | `{phone, pin, voiceOkToken}` | `{ok, shop, profileComplete}` | bcrypt PIN; 409 if phone exists |
| `POST /api/auth/login` | `{phone, pin, voiceOkToken}` | `{ok, shop, profileComplete}` | generic 401; lockout after 5 fails |
| `POST /api/auth/logout` | — | `{ok}` | clears cookie |

### Session (auth required)
| Method & path | Body/Query | Returns | Validation |
|---|---|---|---|
| `GET /api/me` | — | `{shop, profileComplete}` | never returns `pin_hash` |
| `PUT /api/me` | `{owner_name, shop_name, address}` | `{shop, profileComplete}` | all required; lengths 80/120/500 |
| `POST /api/stt` | raw WAV body (≤5 MB, ≥1000 B) | Gnani JSON `{transcript, …}` | 60 req/min per shop; `indic-auto` |
| `POST /api/tts` | `{text}` | WAV | Telugu voice `Nalini` |

### Ledger (auth + shop-scoped)
| Method & path | Body/Query | Returns | Notes |
|---|---|---|---|
| `GET /api/customers` | — | `[{id, name, label, phone, aliases, created_at, balance, last_activity, last_payment_at}]` | balances computed from all transactions |
| `POST /api/customers` | `{name, label?, phone?}` | `201` customer | name ≤100, label ≤60, phone 7–15 `+0-9` |
| `PATCH /api/customers/:id` | any of `{name, label, phone, aliases[]}` | updated customer | 404 if not this shop's; aliases deduped, ≤20 |
| `POST /api/customers/merge` | `{keep_id, remove_id}` | `{ok, customer}` | both must be own; moves txs, folds aliases, deletes remove |
| `GET /api/customers/:id/transactions` | — | `{customer, transactions[]}` newest first | 404 cross-shop |
| `POST /api/transactions` | `{customer_id, type:'credit'\|'pay', amount, raw_transcript?}` | `201` tx | integer amount >0; customer must be own |
| `GET /api/transactions` | `?date=YYYY-MM-DD` (default today IST) or `?recent=N` (1–50) | `{date, transactions[]}` or `{transactions[]}` (+`customer_name`) | IST day boundaries; invalid date → 400 |
| `DELETE /api/transactions/:id` | — | `{ok, id}` | **today (IST) only** — else 403; 404 cross-shop |

**Error shape**: `{ "error": "<Telugu message>" }` with 400/401/403/404/409/429/500/503; details go only to the server log (`fail()` helper). `503` = Supabase not configured.

**Rate limits** (all with Telugu "too many attempts" message): 30 req / 15 min per auth endpoint (keyed by IP, or IP+phone where relevant); audio endpoint 60/min; STT/TTS 60/min per shop (strangers can never burn Gnani credits).

---

## 8. Database Schema (Supabase / Postgres)

Inferred from the queries in `server.js` (all tables are shop-scoped by `shop_id`):

**`shops`**
| Column | Type / notes |
|---|---|
| `id` | uuid PK |
| `phone` | 10-digit, unique (duplicate insert → PG `23505` → 409) |
| `pin_hash` | bcrypt hash — **never sent to the client** |
| `owner_name`, `shop_name`, `address` | profile; empty until onboarding (`profileComplete`) |
| `voice_id` | reserved/nullable |
| `failed_pin`, `locked_until` | lockout counters (5 fails → 15 min) |
| `created_at` | ISO timestamp |

**`customers`**
| Column | Type / notes |
|---|---|
| `id` | uuid PK |
| `shop_id` | FK → shops, indexed in every query |
| `name` | ≤100 chars |
| `label` | nullable, ≤60 (e.g. `tailor`, `driver`) — used for voice disambiguation |
| `phone` | nullable |
| `aliases` | **jsonb array** of spoken spellings (≤20) — merged/fuzzy names land here |
| `created_at` | ISO timestamp |

**`transactions`**
| Column | Type / notes |
|---|---|
| `id` | uuid PK |
| `shop_id` | FK → shops |
| `customer_id` | FK → customers (re-parented on merge) |
| `type` | `'credit'` (udhaar given) or `'pay'` (jama received) |
| `amount` | integer ₹, > 0 |
| `raw_transcript` | ≤2000 chars — what the shopkeeper actually said (audit trail) |
| `created_at` | ISO timestamp; IST day math done in the server |

No foreign-key `ON DELETE` behavior is relied on in code; merges/updates are explicit.

---

## 9. Security Model

1. **Secrets**: `.env` (gitignored) holds `GNANI_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`/`SUPABASE_SECRET_KEY`, `JWT_SECRET`. Server logs only *whether* a key is configured and its length — never the value. Nothing secret is committed; the browser never sees the Supabase key or Gnani key (all voice calls are proxied through the server).
2. **Session**: signed httpOnly JWT cookie (30 d). `requireAuth` mounted on `/api` before any data route; `shopId` comes from the token, so a body can't impersonate another shop.
3. **Multi-tenancy**: every query filters `.eq('shop_id', req.shop.id)`; ids from the client are re-verified (`ownCustomer()`) → cross-shop reads/writes are 404.
4. **Auth hardening**: voice challenge is server-memory-only, single-use, 2-min TTL, phone-bound; `voiceOkToken` 5-min TTL prevents PIN brute force without the audio; generic login errors; bcrypt; 15-min lockout; rate limits on every auth/audio route.
5. **Input validation**: phones `^[6-9]\d{9}$`, PINs 4 digits, integer amounts > 0, string length caps everywhere, `recent` bounded 1–50, dates regex-validated, transcripts truncated to 2000 chars.
6. **XSS**: all interpolation goes through `esc()` (HTML-escape) in `app.js`; no `innerHTML` with raw user data; no third-party JS except Google Fonts CSS.
7. **CSRF-ish**: `sameSite=lax` cookie + JSON POSTs (a cross-site form can't send our JSON content type silently).
8. **Deletion safety**: transactions can only be deleted for the current IST day; merge requires a `confirm()` dialog in the UI.

---

## 10. Configuration

`.env` (copy from `.env.example`):

| Variable | Purpose | Default if unset |
|---|---|---|
| `GNANI_API_KEY` | Gnani STT/TTS key | none — TTS/STT fail |
| `STT_LANG` | STT language code | `indic-auto` |
| `TTS_VOICE` | TTS voice name | `Nalini` |
| `TTS_LANG` | TTS language | `te-IN` |
| `TTS_MODEL` | TTS model | `timbre-v2.5` |
| `PORT` | HTTP port | `3000` |
| `SUPABASE_URL` | project URL | — (503 on data routes) |
| `SUPABASE_SERVICE_KEY` (or `SUPABASE_SECRET_KEY`) | service-role key (server only) | — |
| `JWT_SECRET` | cookie/token signing secret | **fatal exit if missing** |
| `NODE_ENV=production` | makes session cookie `secure` | off |

**Run**: `npm install` → `cp .env.example .env` + fill values → `npm start` → open `http://localhost:3000` in **Chrome** (mic requires localhost or HTTPS).

---

## 11. Testing Summary

| Suite | Command / file | Coverage | Result |
|---|---|---|---|
| Parser unit | `npm test` → `test-parser.js` | 5 cases: Telugu/Hindi/English amounts, pay, query | **5/5** |
| Resolver unit | `npm test` → `test-resolver.js` | 13 cases: many/label/alias/fuzzy/none/suffix/empty | **13/13** |
| API curl | `data/kv-curl.ps1` | auth, CRUD, merge, delete, `recent`, date, **cross-shop 404s**, 401s, 400s | **38/38** |
| Flow harness | `data/kv-flow-test.js` | transcript → classify/split/build/resolve → expected actions | **24/24** |
| DOM harness | `data/kv-dom-test.js` (jsdom) | views render, buttons wire, flows update the DOM, zero console errors | **55/55** |

Temp fixture shops/rows are deleted after the run (`kv-fixture.js --clean`); cookie jars removed. Test tooling under `data/` is gitignored.

**Manual Chrome checklist (Phase B sign-off)**: duplicate-Ramesh chooser by tap and by voice, "Different person?" path, new-customer and fuzzy-alias prompts, multi-entry `"Ramesh 500 udhaar, Lakshmi 200 jama"` with per-row delete, the three query sentences, merge, today-only undo, tab bar/mic rings/today strip/search/sort/overdue/reminder, and Phase A regressions (single entry, voice login).

---

## 12. Git History & Repository

```
4c9989e 2026-11-03  phase B                      ← current HEAD, pushed
1095f59 2026-11-03  before phase B               (marker)
5a0a733 2026-11-02  phase A                      ← pushed
4e2537b 2026-11-02  working v0.1
a68bf17 2026-11-02  Initial commit: Khata Vani voice-based bookkeeping app
```
- Branch: `main` ↔ `origin/main` (`https://github.com/chethanregala/Khata_Vani.git`), working tree **clean**.
- Phase A delivered: auth (voice+PIN), profile onboarding, single-entry voice ledger, STT/TTS proxy, parser.
- Phase B delivered: resolver, multi-entry, queries, chooser, new backend routes, 4-tab UI redesign, tests.
- This documentation file (`PROJECT-DOCUMENTATION.md`) is intentionally **left untracked — not committed, not pushed**.

---

## 13. Roadmap (Phase C and beyond)

**Phase C — Dashboard & Reports**
- Dashboard: weekly/monthly credit vs collection, trend charts, best/worst customers.
- Reports: per-customer statement (khatavani) printable / PDF / WhatsApp share; date-range export.

**Later ideas**
- Offline queue for flaky networks (record → save locally → sync).
- WhatsApp reminder integration (the 🔊 reminder already downloads a .wav for sending).
- Pagination/limits if a shop grows to thousands of transactions.
- Make merge atomic (single RPC/transaction in Postgres).
- PWA install prompt + service worker (currently a plain web app).
- **Phone-ownership verification (SMS/WhatsApp OTP)** — currently the voice challenge proves audio interaction only; a real OTP provider is a **future security requirement** (see `SECURITY-HARDENING.md`), not merely a convenience alternative where voice is impractical.

---

## 14. Quick Reference — Everyday Commands

```bash
npm start                 # run server on :3000 (node server.js)
npm test                  # parser 5/5 + resolver 13/13
node test-parser.js       # parser only
node test-resolver.js     # resolver only
git status                # should be clean except this doc file
git log --oneline -5      # phase B is HEAD
```

**Never**: commit `.env`, print `GNANI_API_KEY`/Supabase keys/`JWT_SECRET`, modify the developer's own Supabase rows (1 shop "X-mart", 2 customers) during testing, or use inline `curl -d` on PowerShell (write the JSON body to `data/kv-body.tmp` and use `-d @data/kv-body.tmp` instead).
