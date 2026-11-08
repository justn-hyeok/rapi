BEGIN;

-- Star rows say whose they are as user_id, like every other per-person table.
-- "owner" is kept for the bot's owner.
ALTER TABLE github_stars RENAME COLUMN owner_id TO user_id;
ALTER TABLE star_reminder_days RENAME COLUMN owner_id TO user_id;
ALTER TABLE star_suggestions RENAME COLUMN owner_id TO user_id;
ALTER TABLE star_neighbors RENAME COLUMN owner_id TO user_id;
ALTER TABLE star_interests RENAME COLUMN owner_id TO user_id;
ALTER TABLE star_votes RENAME COLUMN owner_id TO user_id;

INSERT INTO schema_migrations (name) VALUES ('0023_star_user_ids.sql');

COMMIT;
