import type { CommunityStore } from "@rapi/application";
import type { PostgresDatabase } from "./database.js";

/** The curation feeds' posts and drafts. */
export class PostgresCommunityStore implements CommunityStore {
  constructor(private readonly db: PostgresDatabase) {}

  async communityGuildPostSent(guildId: string, key: string): Promise<boolean> {
    const result = await this.db.pool.query(
      "SELECT 1 FROM community_guild_posts WHERE guild_id=$1 AND key=$2",
      [guildId, key],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async recordCommunityGuildPost(input: {
    guildId: string;
    key: string;
    channelId: string;
    messageId: string | null;
  }): Promise<void> {
    await this.db.pool.query(
      `INSERT INTO community_guild_posts(guild_id,key,channel_id,message_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [input.guildId, input.key, input.channelId, input.messageId],
    );
  }

  async communityPostExists(key: string): Promise<boolean> {
    const result = await this.db.pool.query(
      "SELECT 1 FROM community_posts WHERE key=$1",
      [key],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async recordCommunityPost(input: {
    key: string;
    feed: string;
    channelId: string | null;
    messageId: string | null;
    data: Record<string, unknown>;
    state?: "posted" | "marker";
  }): Promise<void> {
    await this.db.pool.query(
      `INSERT INTO community_posts(key,feed,state,channel_id,message_id,data) VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT (key) DO NOTHING`,
      [
        input.key,
        input.feed,
        input.state ?? (input.messageId ? "posted" : "marker"),
        input.channelId,
        input.messageId,
        JSON.stringify(input.data),
      ],
    );
  }

  async saveCommunityDraft(input: {
    key: string;
    feed: string;
    title: string;
    embeds: unknown[];
  }): Promise<void> {
    await this.db.pool.query(
      `INSERT INTO community_posts(key,feed,state,title,embeds) VALUES($1,$2,'draft',$3,$4::jsonb) ON CONFLICT (key) DO NOTHING`,
      [input.key, input.feed, input.title, JSON.stringify(input.embeds)],
    );
  }

  /** Oldest waiting cards of a feed. */
  async communityCardQueue(
    feed: string,
    prefix: string,
    limit: number,
  ): Promise<string[]> {
    const result = await this.db.pool.query<{ key: string }>(
      `SELECT key FROM community_posts WHERE state='draft' AND feed=$1 AND starts_with(key,$2) ORDER BY posted_at, key LIMIT $3`,
      [feed, prefix, limit],
    );
    return result.rows.map((row) => row.key);
  }

  async communityDraft(key: string): Promise<{
    key: string;
    feed: string;
    embeds: unknown[];
    created: Date;
  } | null> {
    const result = await this.db.pool.query<{
      key: string;
      feed: string;
      embeds: unknown[];
      created: Date;
    }>(
      "SELECT key,feed,embeds,posted_at AS created FROM community_posts WHERE key=$1 AND state='draft'",
      [key],
    );
    return result.rows[0] ?? null;
  }

  /** Moves a waiting card to posted exactly once. */
  async settleCommunityDraft(
    key: string,
    state: "posted",
    channelId: string | null = null,
    messageId: string | null = null,
  ): Promise<boolean> {
    const result = await this.db.pool.query(
      `UPDATE community_posts SET state=$2,channel_id=$3,message_id=$4,posted_at=now() WHERE key=$1 AND state='draft'`,
      [key, state, channelId, messageId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async lastCommunityPostAt(
    feed: string,
    prefix: string,
  ): Promise<Date | null> {
    const result = await this.db.pool.query<{ at: Date | null }>(
      "SELECT max(posted_at) AS at FROM community_posts WHERE feed=$1 AND starts_with(key,$2)",
      [feed, prefix],
    );
    return result.rows[0]?.at ?? null;
  }

  /** Removes bookkeeping markers; real posts and drafts are never touched. */
  async deleteCommunityMarkers(keys: string[]): Promise<void> {
    if (!keys.length) return;
    await this.db.pool.query(
      "DELETE FROM community_posts WHERE state='marker' AND key=ANY($1)",
      [keys],
    );
  }

  async communityPostKeys(prefix: string): Promise<string[]> {
    const result = await this.db.pool.query<{ key: string }>(
      "SELECT key FROM community_posts WHERE starts_with(key,$1)",
      [prefix],
    );
    return result.rows.map((row) => row.key);
  }

  /** Recent public posts from sources marked official (AI tool blogs). */
  async officialItems(since: Date): Promise<
    Array<{
      id: string;
      url: string;
      title: string;
      summary: string;
      source: string;
      aiOnly: boolean;
    }>
  > {
    const result = await this.db.pool.query(
      `SELECT si.id,si.canonical_url AS url,si.title,
       COALESCE((SELECT sm.content FROM summaries sm WHERE si.id=ANY(sm.evidence_item_ids) AND sm.purpose='item'
         ORDER BY (sm.model_policy_version='rules-v1'), sm.created_at DESC LIMIT 1),si.body) AS summary,
       COALESCE(src.collection_policy->>'label',src.locator) AS source,
       COALESCE(src.collection_policy->>'aiOnly','false')='true' AS "aiOnly"
       FROM source_items si JOIN raw_events re ON re.id=si.raw_event_id JOIN sources src ON src.id=re.source_id
       WHERE (src.collection_policy->>'official'='true' OR src.collection_policy->>'aiBlog'='true')
         AND si.visibility='public' AND si.collected_at>=$1
         AND COALESCE(si.published_at,si.collected_at)>now()-interval '3 days'
       ORDER BY COALESCE(si.published_at,si.collected_at) DESC LIMIT 60`,
      [since],
    );
    return result.rows as never;
  }

  /** Recent public items from non-official sources, to match citations; `includeOfficial` also searches vendor posts, for free-credit news. */
  async citationCandidates(
    since: Date,
    includeOfficial = false,
  ): Promise<
    Array<{
      id: string;
      url: string;
      title: string;
      body: string;
      source: string;
    }>
  > {
    const result = await this.db.pool.query(
      `SELECT si.id,si.canonical_url AS url,si.title,left(si.body,4000) AS body,
       COALESCE(src.collection_policy->>'label',src.locator) AS source
       FROM source_items si JOIN raw_events re ON re.id=si.raw_event_id JOIN sources src ON src.id=re.source_id
       WHERE si.visibility='public' AND ($2 OR src.collection_policy->>'official' IS DISTINCT FROM 'true') AND si.collected_at>=$1
         AND ($2=false OR COALESCE(si.published_at,si.collected_at)>now()-interval '14 days')
       ORDER BY si.collected_at DESC LIMIT 3000`,
      [since, includeOfficial],
    );
    return result.rows as never;
  }
}
