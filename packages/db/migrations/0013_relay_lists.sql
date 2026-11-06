BEGIN;

-- Lists of free relay sites that other people keep on GitHub.
ALTER TABLE discount_candidates DROP CONSTRAINT discount_candidates_route_check;
ALTER TABLE discount_candidates
  ADD CONSTRAINT discount_candidates_route_check
    CHECK (route IN ('code_search', 'pull_request', 'changelog', 'report',
                     'catalog', 'hacker_news', 'credit_feed', 'community',
                     'relay_list'));

INSERT INTO schema_migrations (name) VALUES ('0013_relay_lists.sql');

COMMIT;
