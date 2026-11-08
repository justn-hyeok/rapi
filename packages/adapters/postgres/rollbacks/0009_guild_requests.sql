UPDATE discord_guilds SET status = 'rejected' WHERE status = 'blocked';
ALTER TABLE discord_guilds
  DROP COLUMN IF EXISTS requester_id,
  DROP COLUMN IF EXISTS reason,
  DROP COLUMN IF EXISTS carded_at,
  DROP COLUMN IF EXISTS card_message_id,
  DROP CONSTRAINT IF EXISTS discord_guilds_status_check;
ALTER TABLE discord_guilds
  ADD CONSTRAINT discord_guilds_status_check
    CHECK (status IN ('pending','allowed','rejected','left'));
