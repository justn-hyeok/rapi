BEGIN;

-- /서버신청 keeps one row per guild. 'blocked' refuses for good until the owner lifts
-- it; 'rejected' is a guild no longer blocked, which may ask again after a wait.
ALTER TABLE discord_guilds DROP CONSTRAINT discord_guilds_status_check;
UPDATE discord_guilds SET status = 'blocked' WHERE status = 'rejected';
ALTER TABLE discord_guilds
  ADD CONSTRAINT discord_guilds_status_check
    CHECK (status IN ('pending','allowed','rejected','blocked','left')),
  ADD COLUMN requester_id text,
  ADD COLUMN reason text,
  ADD COLUMN carded_at timestamptz,
  ADD COLUMN card_message_id text;

INSERT INTO schema_migrations (name) VALUES ('0009_guild_requests.sql');

COMMIT;
