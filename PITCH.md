# Khata Vani (ఖాతా వాణి): speak your ledger

Built by Chethan Regala, B.Tech student, Godavari Global University. Solo entry, Great Indian AI Internship Challenge.
Live app: https://khata-vani.onrender.com | Demo video: https://drive.google.com/drive/folders/16wPHTQYKHq6VWhGlVpNPKi2bBvQd0Y6s?usp=drive_link | Demo login: 9000000001 / PIN 1234 (Kirana), 9000000002 / PIN 1234 (Rythu). Fake data only.

## The problem
Kirana shops and farmer-traders in India run on credit written in paper notebooks. Pages get lost, dues are forgotten, asking for money is awkward, and disputes have no proof. Most app-based khata tools expect typing and English menus; many shopkeepers won't use them.

## The solution
Khata Vani lets the owner simply speak in Telugu or Hinglish: "రమేష్ కి 500 ఉద్దెర". The app understands the sentence, reads it back, and saves it after one tap. Each shop picks one business type at sign-up and gets a focused app:
- **Kirana:** udhaar and payments, balance questions by voice, a spoken chooser when two customers share a name, opening balance from the old notebook, cash/UPI payment modes, write-off of small leftovers, credit limits, shareable statements.
- **Rythu (farmer-trader):** produce delivery (quantity x rate with unit conversion), advances, itemised deductions, suggested commission, payments, and a printable settlement slip. Overpayments are blocked, and money is never allocated silently.
- **Trust:** the owner sends a link or QR. The customer or farmer opens it with no app and no login, listens to the entry in Telugu, and taps Acknowledge or Dispute.

## How Gnani AI is used
- **Prisma (speech-to-text):** every ledger entry, balance query and spoken choice.
- **Timbre (text-to-speech):** read-back confirmations, balance answers, the voice word check at login, acknowledgement audio, and the daily spoken summary.

## What makes it real
Nothing is ever deleted: mistakes are fixed with reversal entries, and every save is idempotent (a double tap creates one record). Balances are computed from entries, money uses integer paise, and each shop's data is isolated. It ships with automated tests, rate limits and security headers. Stack: Node/Express, Supabase Postgres, vanilla JS installable web app, Render.

## Honest limits and next steps
The login (phone + voice word + PIN) is demo-grade; production would add SMS OTP and passkeys. Link acknowledgement is a trust aid, not legal proof. Next: dairy collection, offline mode, more Indian languages.
