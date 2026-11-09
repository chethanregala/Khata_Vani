-- Migration 004: business type separation (kirana vs rythu)
-- Additive only: one new nullable column on shops + a backfill.
-- Run in the Supabase SQL editor, then restart nothing (server picks it up).

ALTER TABLE shops
  ADD COLUMN IF NOT EXISTS business_type text;

-- Validation only fires when the column is non-null (business_type may stay
-- NULL until the shop chooses, so the check is written to ignore NULL).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'shops_business_type_chk'
  ) THEN
    ALTER TABLE shops ADD CONSTRAINT shops_business_type_chk
      CHECK (business_type IS NULL OR business_type IN ('kirana', 'rythu'));
  END IF;
END $$;

-- Backfill rule (mirrors lib/business-type.js decide()):
--   only rythu-shaped data  -> 'rythu'
--   only kirana-shaped data -> 'kirana'
--   both, or neither        -> NULL (shop must choose during onboarding)
-- rythu data  = transactions with workflow='rythu' OR customers kind='farmer'
-- kirana data = transactions with workflow<>'rythu' OR customers kind<>'farmer'
-- Reversed transactions still count: they are historical evidence either way.
UPDATE shops s
SET business_type = (
  WITH w AS (
    SELECT
      MAX(CASE WHEN t.workflow = 'rythu' THEN 1 END) AS has_ry,
      MAX(CASE WHEN t.workflow <> 'rythu' THEN 1 END) AS has_ki
    FROM transactions t WHERE t.shop_id = s.id
  ), c AS (
    SELECT
      MAX(CASE WHEN u.kind = 'farmer' THEN 1 END) AS has_ry,
      MAX(CASE WHEN u.kind <> 'farmer' THEN 1 END) AS has_ki
    FROM customers u WHERE u.shop_id = s.id
  )
  SELECT CASE
    WHEN (w.has_ry OR c.has_ry) IS NOT NULL AND NOT (COALESCE(w.has_ki,0) + COALESCE(c.has_ki,0)) > 0 THEN 'rythu'
    WHEN (w.has_ki OR c.has_ki) IS NOT NULL AND NOT (COALESCE(w.has_ry,0) + COALESCE(c.has_ry,0)) > 0 THEN 'kirana'
    ELSE NULL
  END
  FROM w, c
);

CREATE INDEX IF NOT EXISTS shops_business_type_idx ON shops (business_type);
