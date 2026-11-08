BEGIN;

-- Offers found on the front page of a service another route discovered.
ALTER TABLE discount_candidates DROP CONSTRAINT discount_candidates_route_check;
ALTER TABLE discount_candidates
  ADD CONSTRAINT discount_candidates_route_check
    CHECK (route IN ('code_search', 'pull_request', 'changelog', 'report',
                     'catalog', 'hacker_news', 'credit_feed', 'community',
                     'relay_list', 'promoclock', 'relay_site', 'free_list',
                     'commit_log', 'site_offer'));

INSERT INTO schema_migrations (name) VALUES ('0018_site_offers.sql');

COMMIT;
