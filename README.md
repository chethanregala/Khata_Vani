# Khata Vani (ఖాతా వాణి)

Voice-first ledger for small shops. Telugu first, English second.

## Run
1. `npm install`  2. `cp .env.example .env` and put your Gnani key + Supabase URL/key + `JWT_SECRET`
3. `npm start`  4. open http://localhost:3000 (Chrome; mic needs localhost/HTTPS)

Check voice names / language codes in Gnani docs if TTS errors: set `TTS_VOICE`, `TTS_LANG` in `.env`.

## Tests
```
npm test                 # parser.js + resolver.js unit tests
node test-parser.js      # rule-based speech parser
node test-resolver.js    # customer name resolution (exact / label / alias / fuzzy)
```

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
