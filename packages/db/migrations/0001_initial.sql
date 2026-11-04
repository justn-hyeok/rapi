BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- Collection: where items come from and what each source returned.
CREATE TABLE sources (
  id uuid PRIMARY KEY,
  kind text NOT NULL,
  locator text NOT NULL,
  auth_ref text,
  collection_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  state text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, locator)
);

CREATE TABLE raw_events (
  id uuid PRIMARY KEY,
  source_id uuid NOT NULL REFERENCES sources(id),
  external_event_id text,
  canonical_payload_hash text NOT NULL,
  payload jsonb NOT NULL,
  collected_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX raw_events_external_id_unique ON raw_events (source_id, external_event_id) WHERE external_event_id IS NOT NULL;
CREATE UNIQUE INDEX raw_events_payload_hash_unique ON raw_events (source_id, canonical_payload_hash) WHERE external_event_id IS NULL;

CREATE TABLE source_cursors (
  source_id uuid PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
  cursor_value text,
  etag text,
  modified_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  failure_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE source_items (
  id uuid PRIMARY KEY,
  raw_event_id uuid NOT NULL REFERENCES raw_events(id),
  normalizer_version text NOT NULL,
  canonical_url text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  author text,
  published_at timestamptz,
  collected_at timestamptz NOT NULL,
  visibility text NOT NULL CHECK (visibility IN ('private', 'unlisted', 'public')),
  content_fingerprint text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (raw_event_id, normalizer_version)
);
CREATE INDEX source_items_url_idx ON source_items (canonical_url);
CREATE INDEX source_items_fingerprint_idx ON source_items (content_fingerprint);

CREATE TABLE item_relations (
  source_item_id uuid NOT NULL REFERENCES source_items(id),
  related_item_id uuid NOT NULL REFERENCES source_items(id),
  relation text NOT NULL CHECK (relation IN ('duplicate_candidate', 'related')),
  policy_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_item_id, related_item_id, relation)
);

CREATE TABLE classifications (
  id uuid PRIMARY KEY,
  source_item_id uuid NOT NULL REFERENCES source_items(id),
  taxonomy_version text NOT NULL,
  label text NOT NULL,
  score double precision NOT NULL CHECK (score >= 0 AND score <= 1),
  evidence text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_item_id, taxonomy_version, label)
);

CREATE TABLE summaries (
  id uuid PRIMARY KEY,
  purpose text NOT NULL,
  cache_key text NOT NULL UNIQUE,
  model_policy_version text NOT NULL,
  prompt_version text NOT NULL,
  content text NOT NULL,
  evidence_item_ids uuid[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Curation channel posts and drafts. Drafts wait for the owner to send them;
-- markers record periodic checks. A key is used at most once in any state.
CREATE TABLE community_posts (
  key text PRIMARY KEY,
  feed text NOT NULL CHECK (feed IN ('projects','setup','stars','ai-blogs','free-tokens')),
  state text NOT NULL DEFAULT 'posted' CHECK (state IN ('draft','posted','discarded','marker')),
  title text,
  embeds jsonb,
  channel_id text,
  message_id text,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  posted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX community_posts_feed_idx ON community_posts (feed, posted_at DESC);
CREATE INDEX community_posts_drafts_idx ON community_posts (posted_at DESC) WHERE state = 'draft';

-- Guilds the bot has been invited to. The owner approves each one; guilds in
-- DISCORD_ALLOWED_GUILD_IDS are allowed without a row.
CREATE TABLE discord_guilds (
  guild_id text PRIMARY KEY,
  name text,
  status text NOT NULL CHECK (status IN ('pending','allowed','rejected','left')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  decided_by text,
  left_at timestamptz
);

-- Curation posts already sent to a guild other than the community guild.
CREATE TABLE community_guild_posts (
  guild_id text NOT NULL,
  key text NOT NULL,
  channel_id text NOT NULL,
  message_id text,
  posted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, key)
);

CREATE TABLE discord_managed_resources (
  guild_id text NOT NULL,
  resource_type text NOT NULL
    CHECK (resource_type IN ('role','category','channel','message','webhook')),
  resource_key text NOT NULL,
  discord_id text NOT NULL,
  last_applied_digest text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, resource_type, resource_key),
  UNIQUE (guild_id, resource_type, discord_id)
);

CREATE TABLE discord_layout_plans (
  id uuid PRIMARY KEY,
  guild_id text NOT NULL,
  created_by text NOT NULL,
  layout_digest text NOT NULL,
  snapshot_digest text NOT NULL,
  actions jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  apply_started_at timestamptz,
  applied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);
CREATE INDEX discord_layout_plans_pending_idx
  ON discord_layout_plans (guild_id, expires_at DESC)
  WHERE applied_at IS NULL;

-- Direct model calls: one row per call, plus a once-per-month marker for the
-- 80% / 100% budget alerts.
CREATE TABLE model_usage (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  feature text NOT NULL,
  model text NOT NULL,
  input_tokens integer NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens integer NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cost_micro_usd bigint NOT NULL DEFAULT 0 CHECK (cost_micro_usd >= 0),
  ok boolean NOT NULL,
  error text,
  latency_ms integer NOT NULL DEFAULT 0,
  note text
);
CREATE INDEX model_usage_at_idx ON model_usage (at);
CREATE INDEX model_usage_feature_at_idx ON model_usage (feature, at);

CREATE TABLE model_budget_alerts (
  month text NOT NULL,
  level text NOT NULL CHECK (level IN ('warn','exceeded')),
  sent_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (month, level)
);

-- Anthropic news has no feed; it is read as an HTML list page.
INSERT INTO sources (id, kind, locator, collection_policy)
VALUES (gen_random_uuid(), 'html', 'https://www.anthropic.com/news',
  '{"visibility":"public","html":{"linkPattern":"^/news/[a-z0-9-]+$","exclude":["^/news/(announcements|features|events|partnerships|policy|product|safeguards|security)$"]}}'::jsonb)
ON CONFLICT (kind, locator) DO NOTHING;

-- Supabase's public roles get nothing from this database.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON SCHEMA public FROM anon;
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;
    REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM anon;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON SCHEMA public FROM authenticated;
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM authenticated;
    REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM authenticated;
  END IF;
END $$;

INSERT INTO schema_migrations (name) VALUES ('0001_initial.sql');

COMMIT;
