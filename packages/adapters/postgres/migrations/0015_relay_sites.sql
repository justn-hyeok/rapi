BEGIN;

-- Relay sites' own public status and price lists.
ALTER TABLE discount_candidates DROP CONSTRAINT discount_candidates_route_check;
ALTER TABLE discount_candidates
  ADD CONSTRAINT discount_candidates_route_check
    CHECK (route IN ('code_search', 'pull_request', 'changelog', 'report',
                     'catalog', 'hacker_news', 'credit_feed', 'community',
                     'relay_list', 'promoclock', 'relay_site'));

INSERT INTO schema_migrations (name) VALUES ('0015_relay_sites.sql');

COMMIT;
