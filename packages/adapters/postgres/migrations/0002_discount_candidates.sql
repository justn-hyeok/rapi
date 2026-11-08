BEGIN;

-- New AI API services and discounts found automatically. Recorded only: nothing here is posted.
CREATE TABLE discount_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('new_service', 'discount')),
  route text NOT NULL CHECK (route IN ('code_search', 'pull_request', 'changelog')),
  dedupe_key text NOT NULL UNIQUE,
  domain text,
  title text NOT NULL,
  url text NOT NULL,
  evidence text NOT NULL CHECK (char_length(evidence) <= 600),
  published_at timestamptz,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'new'
);

INSERT INTO schema_migrations (name) VALUES ('0002_discount_candidates.sql');

COMMIT;
