# Khata Vani (ఖాతా వాణి)

A voice-first ledger ("khata") app for Indian kirana shops and rythu (farmer/produce) traders. The shopkeeper speaks in Telugu; the app parses the sentence, shows a confirmation card, and posts double-safe ledger entries. Customers get a shareable link (with QR and Telugu audio) to acknowledge or dispute a credit — no app or login needed on their side.

## Workflows

- **Kirana**: "రమేష్ 500 ఉద్దెర" → goods credit on the customer's account; "జమ" records a repayment. Overpayments are rejected; reversals write offsetting rows (history is never deleted).
- **Rythu**: a produce delivery (quantity × rate, server-computed) becomes a settlement anchor; advances, deductions (hamali, commission, transport…) and payments auto-link to it, and the remaining balance is always cash-out exact.
- **Acknowledgements**: any kirana credit can mint a secret link `/a/<token>` — QR + summary audio for the customer to acknowledge, dispute, or resolve. One active link per entry; re-minting revokes awaiting links; answered links keep their truthful state.

## Voice models (Gnani)

- **Prisma STT** (`/api/stt` → `prisma-v3.0`): spoken entries, balance queries, and name-choice replies.
- **Timbre TTS** (`/api/tts`): confirmations, query answers, login word-check words, and acknowledgement-link audio.

Both are server-side proxies with per-shop rate limits, timeouts, and strict validation. Raw provider payloads are never forwarded or logged.

## Setup

```bash
npm install
cp .env.example .env      # fill the vars below
npm start                 # http://localhost:3000
```

Required env vars (missing/placeholder values are fatal at startup in production, warn in dev; values are never printed):

| Var | Purpose |
|---|---|
| `GNANI_API_KEY` | Gnani STT/TTS key |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Supabase service-role key (`SUPABASE_SECRET_KEY` also accepted) |
| `JWT_SECRET` | ≥32 chars, ≥12 distinct, not a placeholder |
| `APP_ORIGIN` | production only — canonical public origin for ack links |
| `TRUST_PROXY` | `1` behind a reverse proxy (Render), so rate limits see real IPs |
| `NODE_ENV` | `production` enables secure cookies, HSTS, strict config checks |

## npm scripts

- `npm start` — run the server
- `npm test` — hermetic suites: parser, resolver, security, ledger, rythu, acknowledgements
- `npm run smoke` — end-to-end flow against the real Supabase (server must be running); creates a throwaway shop and cleans up everything
- `npm run seed` / `npm run seed:clean` — demo data in / out

## Deploy (Render)

- Build: `npm install` · Start: `npm start`
- Env: `NODE_ENV=production`, `TRUST_PROXY=1`, `APP_ORIGIN=https://<your-domain>`, plus the vars above.
- Persistent disk for `data/tts-cache` (optional — it regenerates; the server starts fine if it is missing).

## Keep-alive (free-tier cron)

Render's free tier sleeps the service; first requests then stall for tens of seconds.
A 5-minute cron keeps it awake (and keeps the Supabase pool warm):

1. Generate a secret once: `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`
2. Set it on Render: env var `KEEPALIVE_TOKEN=<that secret>` (never commit it).
3. Create a cron job on <https://cron-job.org> (free): URL

   ```
   https://<your-render-domain>/keepalive?k=<KEEPALIVE_TOKEN>
   ```

   interval: **every 5 minutes**. The endpoint answers `{ok:true}` for the right
   token; anything else reads as a generic 404. The `k` value is never echoed or
   logged. `/healthz` stays public and secret-free (Render's own health check
   should keep using `/healthz`).

Cold starts surviving anyway: the browser shows a non-blocking
"సర్వర్ మేల్కొంటోంది…" banner after 4 s, retries failing GETs once,
and gives up after 30 s with a clear Telugu message.

## Architecture (10 lines)

1. Express server (`server.js`) — CSP-safe static frontend + JSON API, signed httpOnly session cookies.
2. `security.js` — request ids, strict CSP/headers, same-origin CSRF guard, opaque error handler, secret validation.
3. `lib/money.js` — integer paise math; amounts are exact up to ₹99,99,999 with Indian grouping.
4. `lib/ledger.js` — transactions in Supabase Postgres: server-computed amounts, idempotency keys, reversals, settlement allocation.
5. `lib/ack.js` — hashed (never plaintext) acknowledgement tokens, expiry, revoke-on-reversal, dispute/resolve state machine.
6. `public/app.js` — hash-routed SPA: splash → login (phone + spoken word + PIN) → profile → home/kirana/rythu tabs.
7. `public/parser.js` + `rythu-parser.js` — rule-based Telugu/English parser; `resolver.js` — exact/label/alias/fuzzy name matching shared client+server.
8. Mic flow: record → `/api/stt` → propose card → confirm (idempotent key) → save.
9. TTS flow: `/api/tts` with a sentence cache in `data/tts-cache/` — voice is a convenience, never a gate.
10. Migrations in `supabase/migrations/` (additive; no destructive changes).

## Known limitations

- **Demo-grade login**: phone + voice word-check + PIN proves device/audio interaction, not phone ownership. Production roadmap: SMS OTP or passkeys.
- **Acknowledgements are link-based, not legal proof**: anyone holding the secret link can answer; links are hashed, expiring, and revocable, but possession is the only credential.
- **Free-tier cold starts**: on Render's free tier the first request after idle can take tens of seconds; TTS/STT also add latency.
- **Rule-based parser**: no LLM fallback — unusual phrasings fall back to manual entry with a friendly explanation.

## Tests

```bash
npm test          # 190+ hermetic checks (no network, no credits spent)
npm run smoke     # 40 end-to-end checks against the real Supabase
```
