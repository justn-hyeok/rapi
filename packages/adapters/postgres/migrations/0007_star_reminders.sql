BEGIN;

-- The owner's GitHub stars, refreshed at most once a day. Only the owner ever sees
-- them. A row outlives an unstar, so starring again keeps its reminder history.
CREATE TABLE github_stars (
  full_name text PRIMARY KEY,
  url text NOT NULL,
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 300),
  language text,
  stars_count integer NOT NULL DEFAULT 0,
  archived boolean NOT NULL DEFAULT false,
  starred_at timestamptz NOT NULL,
  unstarred_at timestamptz,
  last_reminded_at timestamptz,
  reminded_count integer NOT NULL DEFAULT 0
);

-- One row per Asia/Seoul day. It works like carded_at: claimed before sending, so
-- a restart never sends twice. A row without a message id may not have arrived.
CREATE TABLE star_reminder_days (
  day date PRIMARY KEY,
  repos text[] NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  message_id text
);

INSERT INTO schema_migrations (name) VALUES ('0007_star_reminders.sql');

COMMIT;
