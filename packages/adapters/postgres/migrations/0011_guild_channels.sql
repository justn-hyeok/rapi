BEGIN;

-- Where each kind of notification goes, as set with /알림채널. The review kinds are
-- only read from the home guild, and a guild with no row receives nothing.
CREATE TABLE discord_guild_channels (
  guild_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN (
    'discount', 'new_service',
    'review_discount', 'review_new_service', 'review_report', 'review_guild_request'
  )),
  channel_id text NOT NULL,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, kind)
);

INSERT INTO schema_migrations (name) VALUES ('0011_guild_channels.sql');

COMMIT;
