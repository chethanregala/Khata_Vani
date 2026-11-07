-- ============================================================================
-- Khata Vani — migration 003_acknowledgements.sql (Sprint 3)
-- Customer acknowledgement links: the shop mints a one-link-per-entry token
-- (32 random bytes, base64url). ONLY the SHA-256 hash of the token is stored
-- here (token_hash is unique => constant-time-friendly indexed lookup); the
-- raw token exists only inside the shareable URL that is returned once.
--
-- ADDITIVE ONLY, safe to re-run. Run in the Supabase Dashboard -> SQL Editor,
-- paste whole file, Run.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. acknowledgements table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS acknowledgements (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id        uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  transaction_id uuid NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  token_hash     text NOT NULL UNIQUE,   -- sha256 hex of the raw token; raw token never stored
  status         text NOT NULL DEFAULT 'awaiting'
                 CHECK (status IN ('awaiting', 'acknowledged', 'disputed', 'resolved', 'revoked')),
  dispute_note   text,                   -- the customer's optional dispute note (max 200 chars)
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,   -- created_at + 14 days (set by the server)
  responded_at   timestamptz,            -- first (and only) public response
  resolved_at    timestamptz             -- when the shop resolved a dispute
);

CREATE INDEX IF NOT EXISTS acknowledgements_shop_txn_idx
  ON acknowledgements (shop_id, transaction_id);

-- RLS on, NO policies: the server always talks with the service role (RLS is
-- bypassed), so no client or anon role has any path to these rows.
ALTER TABLE acknowledgements ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public'
                 AND tablename = 'acknowledgements' AND rowsecurity) THEN
    ALTER TABLE acknowledgements ENABLE ROW LEVEL SECURITY;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. transactions.ack_status: add 'cancelled'
-- ----------------------------------------------------------------------------
-- A reversed entry may have had an active link / pending acknowledgement. The
-- reversal path sets such rows to 'cancelled' so they no longer count as
-- 'awaiting' (and the UI can show the 'రద్దు · Cancelled' chip). Additive:
-- every old value keeps working.
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transactions_ack_chk') THEN
    ALTER TABLE transactions DROP CONSTRAINT transactions_ack_chk;
  END IF;
END $$;
DO $$ BEGIN
  ALTER TABLE transactions ADD CONSTRAINT transactions_ack_chk
    CHECK (ack_status IN ('not_required', 'awaiting', 'acknowledged', 'disputed', 'resolved', 'cancelled'));
END $$;

-- move any rows that currently sit in 'awaiting' on a reversed entry to
-- 'cancelled' (defensive backfill; there is no such state yet — this is a no-op)

UPDATE transactions
   SET ack_status = 'cancelled'
 WHERE status = 'reversed'
   AND ack_status IN ('awaiting', 'acknowledged', 'disputed', 'resolved');

-- ---------------------------------------------------------------------------
-- 3. GUARD: ack_status may only change along the recognised transitions.
--    There is no generic update path for this column: the whitelist below
--    enforces it at the DATABASE level, so a stray UPDATE (today or in a future
--    sprint) that writes ack_status outside these transitions is rejected.
--      not_required -> awaiting          (shop sends the ack link)
--      awaiting     -> acknowledged      (customer acknowledged via the link)
--      awaiting     -> disputed          (customer disputes via the link)
--      awaiting     -> cancelled         (entry reversed -> link revoked)
--      acknowledged -> awaiting          (shop re-mints a link for the entry)
--      acknowledged -> cancelled         (entry reversed after the verdict)
--      disputed     -> resolved          (shop resolves the dispute)
--      disputed     -> cancelled         (entry reversed while disputed)
--      resolved     -> awaiting          (shop re-mints after resolving)
--      resolved     -> cancelled         (entry reversed after resolution)
--      cancelled    stays cancelled
--    Only a cancel is terminal-with-direction (a reversed entry can never be
--    acknowledged again); every live state may start a NEW link, because a
--    fresh link is always a new act of verification with a fresh token.
--    (same-state writes are always allowed — re-running / idempotent paths)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ack_status_guard() RETURNS trigger AS $$
  DECLARE
    transitions text :=
      'not_required:awaiting' ||
      '|awaiting:acknowledged,disputed,cancelled' ||
      '|acknowledged:awaiting,cancelled' ||
      '|disputed:resolved,cancelled' ||
      '|resolved:awaiting,cancelled' ||
      '|cancelled:';
    pair text:=''; t text; targets text; allowed text;
  BEGIN
    IF NEW.ack_status IS NOT DISTINCT FROM OLD.ack_status THEN
      RETURN NEW;                      -- unchanged, any path may do this
    END IF;
    FOREACH t IN ARRAY string_to_array(transitions, '|') LOOP
      IF OLD.ack_status = split_part(t, ':', 1) THEN
        allowed := split_part(t, ':', 2);  -- '' => terminal state, nothing moves out
        pair := t;
        EXIT;
      END IF;
    END LOOP;
    IF pair IS NULL OR
       position(NEW.ack_status || ',' IN allowed || ',') = 0 THEN
      RAISE EXCEPTION 'ACK_STATUS_FORBIDDEN: % -> %', OLD.ack_status, NEW.ack_status
        USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS transactions_ack_status_guard ON transactions;
CREATE TRIGGER transactions_ack_status_guard
  BEFORE UPDATE OF ack_status ON transactions
  FOR EACH ROW EXECUTE FUNCTION ack_status_guard();
