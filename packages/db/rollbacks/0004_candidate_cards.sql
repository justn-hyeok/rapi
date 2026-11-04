ALTER TABLE discount_candidates
  DROP COLUMN IF EXISTS carded_at,
  DROP COLUMN IF EXISTS card_message_id;
