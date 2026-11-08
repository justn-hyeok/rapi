BEGIN;

-- PromoClock's list of AI deals, each with its official source.
ALTER TABLE discount_candidates DROP CONSTRAINT discount_candidates_route_check;
ALTER TABLE discount_candidates
  ADD CONSTRAINT discount_candidates_route_check
    CHECK (route IN ('code_search', 'pull_request', 'changelog', 'report',
                     'catalog', 'hacker_news', 'credit_feed', 'community',
                     'relay_list', 'promoclock'));

INSERT INTO schema_migrations (name) VALUES ('0014_promoclock.sql');

COMMIT;
