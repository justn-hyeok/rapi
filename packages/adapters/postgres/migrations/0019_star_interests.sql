BEGIN;

-- What the interest page sorts stars by. Filled on the next daily read.
ALTER TABLE github_stars
  ADD COLUMN topics text[] NOT NULL DEFAULT '{}',
  ADD COLUMN pushed_at timestamptz,
  ADD COLUMN repo_created_at timestamptz,
  ADD COLUMN owner_type text,
  ADD COLUMN license text;

-- The facets the owner picked on the interest page, each weighted -1..1.
CREATE TABLE star_interests (
  owner_id text PRIMARY KEY,
  facets jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- A thumb on a reminder card, with the repository's facets when it was voted on.
CREATE TABLE star_votes (
  owner_id text NOT NULL,
  full_name text NOT NULL,
  vote smallint NOT NULL CHECK (vote IN (-1, 1)),
  facets text[] NOT NULL,
  voted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, full_name)
);

-- New repositories a search found and the owner was shown, so none comes twice.
CREATE TABLE star_suggestions (
  full_name text PRIMARY KEY,
  repo jsonb NOT NULL,
  suggested_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO schema_migrations (name) VALUES ('0019_star_interests.sql');

COMMIT;
