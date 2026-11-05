BEGIN;

-- OpenRouter's lists, Hacker News titles, aifree.dev's credit feed and linux.do's offers board.
ALTER TABLE discount_candidates DROP CONSTRAINT discount_candidates_route_check;
ALTER TABLE discount_candidates
  ADD CONSTRAINT discount_candidates_route_check
    CHECK (route IN ('code_search', 'pull_request', 'changelog', 'report',
                     'catalog', 'hacker_news', 'credit_feed', 'community'));

INSERT INTO schema_migrations (name) VALUES ('0010_more_candidate_routes.sql');

COMMIT;
