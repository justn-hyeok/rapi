DROP TABLE IF EXISTS rapi_update_notices;
DELETE FROM discord_guild_channels WHERE kind = 'rapi_update';
ALTER TABLE discord_guild_channels DROP CONSTRAINT discord_guild_channels_kind_check;
ALTER TABLE discord_guild_channels ADD CONSTRAINT discord_guild_channels_kind_check
  CHECK (kind IN (
    'discount', 'new_service',
    'review_discount', 'review_new_service', 'review_report', 'review_guild_request'
  ));
