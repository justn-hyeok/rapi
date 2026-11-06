BEGIN;

-- Commit logs that record AI plan and price changes, such as jiegec/kb.
ALTER TABLE discount_candidates DROP CONSTRAINT discount_candidates_route_check;
ALTER TABLE discount_candidates
  ADD CONSTRAINT discount_candidates_route_check
    CHECK (route IN ('code_search', 'pull_request', 'changelog', 'report',
                     'catalog', 'hacker_news', 'credit_feed', 'community',
                     'relay_list', 'promoclock', 'relay_site', 'free_list',
                     'commit_log'));

INSERT INTO schema_migrations (name) VALUES ('0017_commit_logs.sql');

COMMIT;
