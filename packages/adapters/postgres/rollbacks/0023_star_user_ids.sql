ALTER TABLE star_votes RENAME COLUMN user_id TO owner_id;
ALTER TABLE star_interests RENAME COLUMN user_id TO owner_id;
ALTER TABLE star_neighbors RENAME COLUMN user_id TO owner_id;
ALTER TABLE star_suggestions RENAME COLUMN user_id TO owner_id;
ALTER TABLE star_reminder_days RENAME COLUMN user_id TO owner_id;
ALTER TABLE github_stars RENAME COLUMN user_id TO owner_id;
