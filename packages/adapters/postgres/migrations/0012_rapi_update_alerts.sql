BEGIN;

ALTER TABLE discord_guild_channels DROP CONSTRAINT discord_guild_channels_kind_check;
ALTER TABLE discord_guild_channels ADD CONSTRAINT discord_guild_channels_kind_check
  CHECK (kind IN (
    'discount', 'new_service', 'rapi_update',
    'review_discount', 'review_new_service', 'review_report', 'review_guild_request'
  ));

-- Releases already announced, or already out when this started: taken before sending,
-- so a restart cannot announce one twice.
CREATE TABLE rapi_update_notices (
  tag text PRIMARY KEY,
  noticed_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO schema_migrations (name) VALUES ('0012_rapi_update_alerts.sql');

COMMIT;
