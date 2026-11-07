DROP TABLE IF EXISTS star_neighbors;
ALTER TABLE star_suggestions
  DROP COLUMN IF EXISTS trail_kind,
  DROP COLUMN IF EXISTS trail_seed;
