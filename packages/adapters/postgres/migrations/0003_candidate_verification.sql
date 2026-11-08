BEGIN;

-- What the rules found. Rules set green or yellow only; red is the owner's, set by hand.
ALTER TABLE discount_candidates
  ADD COLUMN band text CHECK (band IN ('green', 'yellow', 'red')),
  ADD COLUMN tags text[] NOT NULL DEFAULT '{}',
  ADD COLUMN operator text,
  ADD COLUMN price_check text CHECK (price_check IN ('below_list', 'list_price', 'unknown')),
  ADD COLUMN terms_url text,
  ADD COLUMN terms_note text CHECK (terms_note IN ('확인 못 함', '링크 없음')),
  ADD COLUMN verified_at timestamptz;

INSERT INTO schema_migrations (name) VALUES ('0003_candidate_verification.sql');

COMMIT;
