DROP TABLE IF EXISTS problem_reports;
DELETE FROM discount_candidates WHERE route = 'report';
ALTER TABLE discount_candidates
  DROP COLUMN IF EXISTS reporter_id,
  DROP COLUMN IF EXISTS memo,
  DROP CONSTRAINT IF EXISTS discount_candidates_route_check;
ALTER TABLE discount_candidates
  ADD CONSTRAINT discount_candidates_route_check
    CHECK (route IN ('code_search', 'pull_request', 'changelog'));
