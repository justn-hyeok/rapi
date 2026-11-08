DROP TABLE IF EXISTS star_suggestions;
DROP TABLE IF EXISTS star_votes;
DROP TABLE IF EXISTS star_interests;
ALTER TABLE github_stars
  DROP COLUMN IF EXISTS topics,
  DROP COLUMN IF EXISTS pushed_at,
  DROP COLUMN IF EXISTS repo_created_at,
  DROP COLUMN IF EXISTS owner_type,
  DROP COLUMN IF EXISTS license;
