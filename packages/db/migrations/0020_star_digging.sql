BEGIN;

-- Which way a dig found each shown repository and from which seed, so the
-- owner's thumbs can steer later digs.
ALTER TABLE star_suggestions
  ADD COLUMN trail_kind text,
  ADD COLUMN trail_seed text;

-- Strangers who share many of the owner's stars, kept so later digs can
-- follow their older stars.
CREATE TABLE star_neighbors (
  login text PRIMARY KEY,
  shared integer NOT NULL,
  found_from text NOT NULL,
  found_at timestamptz NOT NULL DEFAULT now(),
  followed_at timestamptz
);

INSERT INTO schema_migrations (name) VALUES ('0020_star_digging.sql');

COMMIT;
