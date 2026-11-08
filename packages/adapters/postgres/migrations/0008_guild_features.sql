BEGIN;

-- What the owner switched with /기능. A guild without a row for a feature keeps
-- that feature's default, and the home guild ignores this table: it has them all.
CREATE TABLE discord_guild_features (
  guild_id text NOT NULL,
  feature text NOT NULL CHECK (feature IN ('status', 'report', 'server_config', 'curation')),
  enabled boolean NOT NULL,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, feature)
);

INSERT INTO schema_migrations (name) VALUES ('0008_guild_features.sql');

COMMIT;
