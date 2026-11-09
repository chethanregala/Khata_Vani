-- Migration 005: accounting essentials (kirana + aadhati ledgers)
-- Additive: widens the event whitelist, adds payment_mode, customer credit
-- fields and the aadhati commission setting; then re-publishes the ledger
-- insert function so new rows carry payment_mode. Existing rows stay untouched
-- apart from the payment_mode backfill (schema default, no financial values).

-- 1. widen the event check: + opening_balance, + discount
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transactions_event_chk') THEN
    ALTER TABLE transactions DROP CONSTRAINT transactions_event_chk;
  END IF;
END $$;
ALTER TABLE transactions ADD CONSTRAINT transactions_event_chk
  CHECK (event IS NULL OR event IN (
    'goods_credit', 'repayment', 'produce_delivery', 'advance',
    'deduction', 'payment', 'milk_collection', 'reversal', 'adjustment',
    'opening_balance', 'discount'));

-- 2. payment_mode on transactions (every money-in/out channel; default cash)
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS payment_mode text DEFAULT 'cash';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transactions_payment_mode_chk') THEN
    ALTER TABLE transactions ADD CONSTRAINT transactions_payment_mode_chk
      CHECK (payment_mode IN ('cash', 'upi', 'bank', 'other'));
  END IF;
END $$;
-- schema default backfill: pre-005 rows were cash (chips did not exist yet)
UPDATE transactions SET payment_mode = 'cash' WHERE payment_mode IS NULL;

-- 3. kirana credit discipline: per-customer credit limit + promise date
ALTER TABLE customers ADD COLUMN IF NOT EXISTS credit_limit  numeric(12,2);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS promise_date  date;

-- 4. aadhati (rythu) commission suggestion percentage on the shop profile
ALTER TABLE shops ADD COLUMN IF NOT EXISTS commission_percent numeric(5,2);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shops_commission_pct_chk') THEN
    ALTER TABLE shops ADD CONSTRAINT shops_commission_pct_chk
      CHECK (commission_percent IS NULL OR commission_percent >= 0 AND commission_percent <= 100);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 5. re-publish post_transactions with payment_mode carried through.
-- The structure is the FIXED top-level data-modifying-CTE shape from migration
-- 003_fix_post_transactions_cte.sql (the nested-sub-query shape from 002
-- fails at runtime with 0A000). The only change vs 003 is the payment_mode
-- column: recordset field, the INSERT column list, and COALESCE(x.payment_mode, 'cash').
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

  -- the data-modifying CTE is the TOP LEVEL statement (migration 003 rule)
  WITH ins AS (
    INSERT INTO transactions (
      shop_id, customer_id, type, amount, event, direction, workflow,
      settlement_id, reverses_id, status, reason, deduction_category,
      idempotency_key, produce, quantity, unit, rate, rate_unit,
      note, raw_transcript, source, ack_status, payment_mode
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
      COALESCE(x.ack_status, 'not_required'),
      COALESCE(x.payment_mode, 'cash')
    FROM jsonb_to_recordset(p_rows) AS x(
      customer_id uuid, type text, amount numeric, event text, direction text,
      workflow text, settlement_id uuid, reverses_id uuid, status text,
      reason text, deduction_category text, idempotency_key text,
      produce text, quantity numeric, unit text, rate numeric, rate_unit text,
      note text, raw_transcript text, source text, ack_status text,
      payment_mode text
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
  SELECT COALESCE(jsonb_agg(to_jsonb(r)), '[]'::jsonb) INTO v_inserted FROM ins AS r;

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
