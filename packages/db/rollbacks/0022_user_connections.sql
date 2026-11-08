-- Puts GitHub tokens back on the star subscribers that had one.
ALTER TABLE star_subscribers ADD COLUMN github_token text;
UPDATE star_subscribers s SET github_token = c.token_sealed
FROM user_connections c WHERE c.user_id = s.user_id AND c.provider = 'github';
DROP TABLE IF EXISTS user_connections;
