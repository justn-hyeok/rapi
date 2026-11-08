BEGIN;

-- The owner's decision on a card: status goes from 'new' to 'published' or 'discarded'.
-- Published with no public_message_id: the send failed uncertainly or the bot died mid-send.
ALTER TABLE discount_candidates
  ADD COLUMN decided_at timestamptz,
  ADD COLUMN public_message_id text;

INSERT INTO schema_migrations (name) VALUES ('0005_candidate_decisions.sql');

COMMIT;
