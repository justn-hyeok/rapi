BEGIN;

-- Links people send with /제보. A report becomes an ordinary candidate, plus who sent it.
ALTER TABLE discount_candidates DROP CONSTRAINT discount_candidates_route_check;
ALTER TABLE discount_candidates
  ADD CONSTRAINT discount_candidates_route_check
    CHECK (route IN ('code_search', 'pull_request', 'changelog', 'report')),
  ADD COLUMN reporter_id text,
  ADD COLUMN memo text CHECK (char_length(memo) <= 200);

-- Kept apart so a claim about a service can never reach a card or the public channel.
-- Nothing changes until the owner decides; 'red' turns the whole domain red.
-- carded_at works as on discount_candidates: claimed before sending.
CREATE TABLE problem_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  url text NOT NULL,
  domain text NOT NULL,
  reporter_id text NOT NULL,
  memo text CHECK (char_length(memo) <= 200),
  reported_at timestamptz NOT NULL DEFAULT now(),
  carded_at timestamptz,
  card_message_id text,
  decision text CHECK (decision IN ('red', 'no_problem')),
  decided_by text,
  decided_at timestamptz
);

-- One open question per link, however many people report it.
CREATE UNIQUE INDEX problem_reports_open_url ON problem_reports (url) WHERE decision IS NULL;

INSERT INTO schema_migrations (name) VALUES ('0006_reports.sql');

COMMIT;
