ALTER TABLE discount_candidates
  DROP COLUMN IF EXISTS decided_at,
  DROP COLUMN IF EXISTS public_message_id;
