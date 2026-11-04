BEGIN;

-- carded_at is claimed before sending, so a restart cannot send a card twice.
-- Set with no message id: the send failed uncertainly or the bot died mid-send.
ALTER TABLE discount_candidates
  ADD COLUMN carded_at timestamptz,
  ADD COLUMN card_message_id text;

INSERT INTO schema_migrations (name) VALUES ('0004_candidate_cards.sql');

COMMIT;
