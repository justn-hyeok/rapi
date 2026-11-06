DELETE FROM discount_candidates WHERE route = 'relay_list';
ALTER TABLE discount_candidates DROP CONSTRAINT IF EXISTS discount_candidates_route_check;
ALTER TABLE discount_candidates
  ADD CONSTRAINT discount_candidates_route_check
    CHECK (route IN ('code_search', 'pull_request', 'changelog', 'report',
                     'catalog', 'hacker_news', 'credit_feed', 'community'));
