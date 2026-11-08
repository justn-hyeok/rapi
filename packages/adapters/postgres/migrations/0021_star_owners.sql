BEGIN;

-- Anyone may get star reminders now, so stars and everything learned from
-- them belong to one Discord user each. Rows from before belong to nobody ('')
-- until the bot hands them to the configured owner at start.
ALTER TABLE github_stars ADD COLUMN owner_id text NOT NULL DEFAULT '';
ALTER TABLE github_stars DROP CONSTRAINT github_stars_pkey;
ALTER TABLE github_stars ADD PRIMARY KEY (owner_id, full_name);

ALTER TABLE star_reminder_days ADD COLUMN owner_id text NOT NULL DEFAULT '';
ALTER TABLE star_reminder_days DROP CONSTRAINT star_reminder_days_pkey;
ALTER TABLE star_reminder_days ADD PRIMARY KEY (owner_id, day);

ALTER TABLE star_suggestions ADD COLUMN owner_id text NOT NULL DEFAULT '';
ALTER TABLE star_suggestions DROP CONSTRAINT star_suggestions_pkey;
ALTER TABLE star_suggestions ADD PRIMARY KEY (owner_id, full_name);

ALTER TABLE star_neighbors ADD COLUMN owner_id text NOT NULL DEFAULT '';
ALTER TABLE star_neighbors DROP CONSTRAINT star_neighbors_pkey;
ALTER TABLE star_neighbors ADD PRIMARY KEY (owner_id, login);

-- Who gets the daily DM, and whose GitHub stars it reads with the token they
-- granted through GitHub OAuth, encrypted with WEBHOOK_ENCRYPTION_KEY. The
-- configured owner has none and is read with the deployment's token. Paused
-- when Discord will not deliver or GitHub takes the grant back, so neither is
-- retried every ten minutes.
CREATE TABLE star_subscribers (
  user_id text PRIMARY KEY,
  github_login text NOT NULL,
  github_token text,
  subscribed_at timestamptz NOT NULL DEFAULT now(),
  paused_at timestamptz,
  paused_reason text
);

INSERT INTO schema_migrations (name) VALUES ('0021_star_owners.sql');

COMMIT;
