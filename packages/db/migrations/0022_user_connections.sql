BEGIN;

-- Accounts people connect on other services (GitHub first), kept apart from
-- the features that use them. One per person and service. The token is sealed
-- with WEBHOOK_ENCRYPTION_KEY; account_id is the service's stable id.
CREATE TABLE user_connections (
  user_id text NOT NULL,
  provider text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_-]{1,31}$'),
  account_id text NOT NULL,
  account_name text NOT NULL,
  token_sealed text NOT NULL,
  scopes text NOT NULL DEFAULT '',
  connected_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, provider)
);

-- Star reminders now read through the GitHub connection.
INSERT INTO user_connections (user_id, provider, account_id, account_name, token_sealed, connected_at)
SELECT user_id, 'github', github_login, github_login, github_token, subscribed_at
FROM star_subscribers WHERE github_token IS NOT NULL;
ALTER TABLE star_subscribers DROP COLUMN github_token;

INSERT INTO schema_migrations (name) VALUES ('0022_user_connections.sql');

COMMIT;
