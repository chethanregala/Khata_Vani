-- ============================================================================
-- Khata Vani — migration 002_ledger_foundation.sql
-- ADDITIVE ONLY. Every old row keeps working unchanged: kirana credit stays
-- 'credit' + amount, direction/workflow/status/source get safe defaults,
-- and `event` is backfilled from `type` for existing rows.
--
-- Safe to re-run (IF NOT EXISTS everywhere; UPDATEs are guarded by IS NULL).
-- Run in the Supabase Dashboard -> SQL Editor, paste whole file, Run.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. customers: workflow classification columns
-- ---------------------------------------------------------------------------
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS kind  text DEFAULT 'customer',
  ADD COLUMN IF NOT EXISTS village text,
  ADD COLUMN IF NOT EXISTS active  boolean DEFAULT true;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customers_kind_chk') THEN
    ALTER TABLE customers ADD CONSTRAINT customers_kind_chk
      CHECK (kind IN ('customer', 'farmer', 'dairy_farmer', 'trader'));
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. transactions: amount becomes money-precise; workflow + reversal columns
-- ---------------------------------------------------------------------------
-- amount: integer rupees -> numeric(12,2). Existing integer rows cast losslessly.
ALTER TABLE transactions
  ALTER COLUMN amount SET DATA TYPE numeric(12,2) USING amount::numeric(12,2);

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS workflow            text DEFAULT 'kirana',
  ADD COLUMN IF NOT EXISTS direction           text DEFAULT 'receivable',
  ADD COLUMN IF NOT EXISTS event               text,               -- backfilled below from type
  ADD COLUMN IF NOT EXISTS settlement_id       uuid REFERENCES transactions(id), -- children point to the delivery row that anchors the settlement
  ADD COLUMN IF NOT EXISTS reverses_id         uuid REFERENCES transactions(id), -- this row offsets that row
  ADD COLUMN IF NOT EXISTS status              text DEFAULT 'posted',
  ADD COLUMN IF NOT EXISTS reason              text,
  ADD COLUMN IF NOT EXISTS deduction_category  text,
  ADD COLUMN IF NOT EXISTS idempotency_key     text,
  ADD COLUMN IF NOT EXISTS produce             text,
  ADD COLUMN IF NOT EXISTS quantity            numeric(12,3),
  ADD COLUMN IF NOT EXISTS unit                text,
  ADD COLUMN IF NOT EXISTS rate                numeric(12,2),
  ADD COLUMN IF NOT EXISTS rate_unit           text,
  ADD COLUMN IF NOT EXISTS note                text,
  ADD COLUMN IF NOT EXISTS source              text DEFAULT 'voice',
  ADD COLUMN IF NOT EXISTS ack_status          text DEFAULT 'not_required';

-- unique per shop: a retried save with the same key can never create a second row
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transactions_idempotency_uq') THEN
    ALTER TABLE transactions ADD CONSTRAINT transactions_idempotency_uq
      UNIQUE (shop_id, idempotency_key);
  END IF;
END $$;

-- enum-ish CHECK constraints (additive; defaults + backfilled values all pass)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transactions_workflow_chk') THEN
    ALTER TABLE transactions ADD CONSTRAINT transactions_workflow_chk
      CHECK (workflow IN ('kirana', 'rythu', 'dairy'));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transactions_direction_chk') THEN
    ALTER TABLE transactions ADD CONSTRAINT transactions_direction_chk
      CHECK (direction IN ('receivable', 'payable'));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transactions_status_chk') THEN
    ALTER TABLE transactions ADD CONSTRAINT transactions_status_chk
      CHECK (status IN ('posted', 'reversed'));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transactions_ack_chk') THEN
    ALTER TABLE transactions ADD CONSTRAINT transactions_ack_chk
      CHECK (ack_status IN ('not_required', 'awaiting', 'acknowledged', 'disputed', 'resolved'));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transactions_event_chk') THEN
    ALTER TABLE transactions ADD CONSTRAINT transactions_event_chk
      CHECK (event IS NULL OR event IN (
        'goods_credit', 'repayment', 'produce_delivery', 'advance',
        'deduction', 'payment', 'milk_collection', 'reversal', 'adjustment'));
  END IF;
END $$;

-- backfill `event` from `type` for every pre-existing row (re-run safe: IS NULL)
UPDATE transactions
   SET event = CASE type WHEN 'credit' THEN 'goods_credit'
                         WHEN 'pay'    THEN 'repayment' END
 WHERE event IS NULL;

-- FK targets need indexes; Postgres does not create them automatically
CREATE INDEX IF NOT EXISTS transactions_settlement_id_idx ON transactions (settlement_id);
CREATE INDEX IF NOT EXISTS transactions_reverses_id_idx   ON transactions (reverses_id);
CREATE INDEX IF NOT EXISTS transactions_shop_created_idx  ON transactions (shop_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 3. audit_events: insert-only audit trail, RLS on with NO policies
--    (service-role requests bypass RLS, so the server can write it; no client
--    or anon role has any path to it because there are no policies at all)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id        uuid NOT NULL REFERENCES shops(id),
  action         text NOT NULL,
  transaction_id uuid REFERENCES transactions(id),
  details        jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'audit_events_shop_created_idx') THEN
    CREATE INDEX audit_events_shop_created_idx ON audit_events (shop_id, created_at DESC);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4. post_transactions(p_shop_id uuid, p_rows jsonb) -> jsonb
--
-- Atomic multi-row ledger save:
--   * inserts every row of p_rows in ONE transaction (a failure aborts all),
--   * rejects rows whose customer / reverses_id / settlement_id are not the
--     shop's own (cross-shop ids can never enter the ledger),
--   * if a row's idempotency_key already exists for the shop, the EXISTING row
--     is returned untouched instead of inserting a duplicate.
--
-- Row shape (all keys optional at the SQL level; the server validates stricter):
--   { customer_id, type, amount, event?, direction?, workflow?,
--     settlement_id?, reverses_id?, reason?, deduction_category?,
--     idempotency_key?, produce?, quantity?, unit?, rate?, rate_unit?,
--     note?, raw_transcript?, source?, ack_status? }
--
-- Returns: jsonb array of the stored/existing transaction rows, in p_rows order
-- ONLY for the rows it served (existing-first is not guaranteed across retry
-- boundaries; callers should match rows by idempotency_key or id).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION post_transactions(p_shop_id uuid, p_rows jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_inserted jsonb;
  v_existing jsonb;
BEGIN
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0 THEN
    RAISE EXCEPTION 'BAD_ROWS: p_rows must be a non-empty jsonb array';
  END IF;

  -- ownership first: one bad id fails the WHOLE batch (nothing is inserted)
  IF EXISTS (
    SELECT 1
      FROM jsonb_to_recordset(p_rows) AS x(customer_id uuid)
     WHERE x.customer_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM customers c
                        WHERE c.id = x.customer_id AND c.shop_id = p_shop_id)
  ) THEN
    RAISE EXCEPTION 'CUSTOMER_NOT_OWNED';
  END IF;

  -- self-references must also belong to this shop
  IF EXISTS (
    SELECT 1
      FROM jsonb_to_recordset(p_rows) AS x(settlement_id uuid, reverses_id uuid)
     WHERE (x.settlement_id IS NOT NULL AND NOT EXISTS (
              SELECT 1 FROM transactions t
               WHERE t.id = x.settlement_id AND t.shop_id = p_shop_id))
        OR (x.reverses_id IS NOT NULL AND NOT EXISTS (
              SELECT 1 FROM transactions t
               WHERE t.id = x.reverses_id AND t.shop_id = p_shop_id))
  ) THEN
    RAISE EXCEPTION 'REFS_NOT_OWNED';
  END IF;

  -- structurally incomplete rows fail the whole batch loudly (server pre-validates)
  IF EXISTS (
    SELECT 1
      FROM jsonb_to_recordset(p_rows) AS x(customer_id uuid, type text, amount numeric)
     WHERE x.customer_id IS NULL OR x.type IS NULL OR x.amount IS NULL
  ) THEN
    RAISE EXCEPTION 'ROW_INCOMPLETE';
  END IF;

  -- skip rows whose idempotency key was already posted by this shop
  SELECT COALESCE(jsonb_agg(rowjs), '[]'::jsonb) INTO v_inserted
  FROM (
    WITH ins AS (
      INSERT INTO transactions (
        shop_id, customer_id, type, amount, event, direction, workflow,
        settlement_id, reverses_id, status, reason, deduction_category,
        idempotency_key, produce, quantity, unit, rate, rate_unit,
        note, raw_transcript, source, ack_status
      )
      SELECT
        p_shop_id, x.customer_id, x.type, x.amount,
        -- default the event from type when the caller did not say
        COALESCE(x.event, CASE x.type WHEN 'credit' THEN 'goods_credit'
                                      WHEN 'pay'    THEN 'repayment' END),
        COALESCE(x.direction, 'receivable'),
        COALESCE(x.workflow, 'kirana'),
        x.settlement_id, x.reverses_id,
        COALESCE(x.status, 'posted'),
        x.reason, x.deduction_category, x.idempotency_key,
        x.produce, x.quantity, x.unit, x.rate, x.rate_unit,
        x.note, x.raw_transcript,
        COALESCE(x.source, 'voice'),
        COALESCE(x.ack_status, 'not_required')
      FROM jsonb_to_recordset(p_rows) AS x(
        customer_id uuid, type text, amount numeric, event text, direction text,
        workflow text, settlement_id uuid, reverses_id uuid, status text,
        reason text, deduction_category text, idempotency_key text,
        produce text, quantity numeric, unit text, rate numeric, rate_unit text,
        note text, raw_transcript text, source text, ack_status text
      )
      WHERE x.customer_id IS NOT NULL
        AND x.type IS NOT NULL
        AND x.amount IS NOT NULL
        AND (x.idempotency_key IS NULL OR NOT EXISTS (
               SELECT 1 FROM transactions t
                WHERE t.shop_id = p_shop_id
                  AND t.idempotency_key = x.idempotency_key))
      ON CONFLICT (shop_id, idempotency_key) DO NOTHING
      RETURNING transactions.*
    )
    SELECT to_jsonb(i.*) AS rowjs FROM ins i
  ) s;

  -- every key this shop ALREADY posted returns the untouched existing row
  SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.created_at), '[]'::jsonb)
    INTO v_existing
  FROM transactions t
  WHERE t.shop_id = p_shop_id
    AND t.idempotency_key = ANY (
      SELECT q.idempotency_key
        FROM jsonb_to_recordset(p_rows) AS q(idempotency_key text)
       WHERE q.idempotency_key IS NOT NULL);

  RETURN COALESCE(v_inserted, '[]'::jsonb) || COALESCE(v_existing, '[]'::jsonb);
END;
$$;
