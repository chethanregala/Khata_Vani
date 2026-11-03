# Khata Vani (ఖాతా వాణి)

Voice-first ledger for small shops. Telugu first, English second.

## Run
1. `npm install`  2. `cp .env.example .env` and put your Gnani key + Supabase URL/key + `JWT_SECRET`
3. `npm start`  4. open http://localhost:3000 (Chrome; mic needs localhost/HTTPS)

Check voice names / language codes in Gnani docs if TTS errors: set `TTS_VOICE`, `TTS_LANG` in `.env`.

## Tests
```
npm test                 # parser + resolver + security suites (5 + 13 + 81 checks)
node test-parser.js      # rule-based speech parser
node test-resolver.js    # customer name resolution (exact / label / alias / fuzzy)
node test-security.js    # security suite — mocked Gnani, no DB traffic
node data/kv-flow-test.js && node data/kv-dom-test.js   # Phase B harnesses (24 + 55)
```

## Security
Hardening pass over the Phase B app — details in [`SECURITY-HARDENING.md`](SECURITY-HARDENING.md).

- **TTS/STT**: both behind auth + 60/min **per-shop** limits (separate buckets) so strangers can never burn Gnani credits; strict body validation (TTS: JSON only, non-empty string ≤1000 chars, 8 KB cap; STT: `audio/*`, 5 MB cap).
- **Gnani proxy**: explicit timeouts (TTS 15 s, STT 30 s), failures mapped to safe 502/504 Telugu messages — raw provider responses are never logged or forwarded.
- **Logs**: only route + request-id + error category. Never transcripts, names, phones, PINs, tokens, audio, or keys.
- **Headers**: strict CSP (no `unsafe-inline`; Google Fonts, mic, and audio still allowed), `nosniff`, `Referrer-Policy`, frame deny, `Permissions-Policy`, COOP, HSTS in production only.
- **CSRF**: Origin check on every POST/PUT/PATCH/DELETE (host match or `APP_ORIGIN` allowlist); missing-Origin requests rejected only when `Sec-Fetch-Site: cross-site`.
- **JWT secret**: production startup rejects weak/placeholder secrets (never prints the value); development only warns. No automatic rotation.
- **Auth honesty**: the spoken-word challenge proves the *audio interaction*, not phone ownership — OTP is a documented future requirement.

Optional `.env`: `APP_ORIGIN` (extra allowed origins), `TRUST_PROXY=1` (only behind a trusted reverse proxy).

## Phase B (what's in here)
- **Backend** (all `requireAuth`, every id re-checked against the session shop):
  `PATCH /api/customers/:id`, `POST /api/customers/merge`, `GET /api/customers/:id/transactions`,
  `DELETE /api/transactions/:id` (today's entries only), `GET /api/customers` (+ `last_payment_at`),
  `GET /api/transactions?recent=N`.
- **Name resolution** — `public/resolver.js`, plain JS, unit-testable in Node like `parser.js`:
  exact → label narrowing → Levenshtein-1 fuzzy, returns `none | one | many | fuzzy`.
- **Home voice flow** — new customer prompt (label + phone), fuzzy "did you mean?" (yes saves an
  alias), duplicate-name chooser sheet read out in Telugu and pickable by tap or by saying the number.
- **Multi-entry** — one sentence, several entries, one confirmation, per-entry delete, saved in order.
- **Queries** — `<name> ki entha baaki`, `ee roju entha udhaar` / `today's credit`, `top 3 baaki`.
- **UI** — 4-tab bar (Home / Customers / Dashboard / Reports), animated mic, today strip,
  customers search + sort chips + overdue chip, customer detail with timeline, Receive payment,
  edit and merge, empty states and loading skeletons.

Dashboard and Reports are placeholders ("coming soon") for Phase C.
