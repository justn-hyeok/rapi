import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import type {
  CommunityStore,
  DiscordLayoutPlanRecord,
  DiscordLayoutStore,
  DiscountCandidateStore,
  GuildStore,
  ManagedDiscordResourceRecord,
  RapiUpdateStore,
  RawEventResult,
  ReportStore,
  SourceStore,
  StarSubscriber,
  StarSubscriberStore,
  StarOwnerStore,
  CandidateForCard,
  CandidateForDecision,
  CandidateToVerify,
  CandidateVerification,
  DiscountCandidate,
  DiscountCandidateRoute,
  NewReport,
  NormalizedItem,
  ProblemDecision,
  ProblemReportForCard,
  ReportOutcome,
  Visibility,
} from "@rapi/core";
import { PostgresStarOwnerStore } from "./star-owner-store.js";
import {
  parseHtmlSourcePolicy,
  UNVETTED_ROUTES,
  validateHtmlSourceLocator,
} from "@rapi/core";

// Tables keyed by owner besides interests and votes, which were per owner from the start.
const STAR_LOGIN_TABLES = [
  "github_stars",
  "star_reminder_days",
  "star_suggestions",
  "star_neighbors",
] as const;

// The moment the publication that is $1 places back leaves the hour, if there is one.
const PUBLICATION_RETRY_AT = `SELECT decided_at + interval '1 hour' AS "retryAt"
  FROM discount_candidates
  WHERE status = 'published' AND decided_at > now() - interval '1 hour'
  ORDER BY decided_at DESC OFFSET $1 LIMIT 1`;

export class PostgresStore
  implements
    SourceStore,
    DiscountCandidateStore,
    ReportStore,
    GuildStore,
    RapiUpdateStore,
    CommunityStore,
    DiscordLayoutStore,
    StarSubscriberStore
{
  readonly pool: Pool;

  constructor(
    connectionString: string,
    options: {
      max?: number;
      connectionTimeoutMs?: number;
      queryTimeoutMs?: number;
    } = {},
  ) {
    this.pool = new Pool({
      connectionString,
      max: options.max ?? 5,
      connectionTimeoutMillis: options.connectionTimeoutMs ?? 5000,
      query_timeout: options.queryTimeoutMs ?? 5000,
    });
  }

  close(): Promise<void> {
    return this.pool.end();
  }

  async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async resetForTests(): Promise<void> {
    const database = await this.pool.query<{ name: string }>(
      "SELECT current_database() AS name",
    );
    if (!database.rows[0]?.name.endsWith("_test"))
      throw new Error("Refusing to reset a database without an _test suffix");
    await this.pool
      .query(`TRUNCATE discord_guilds, discord_guild_features, discord_guild_channels, rapi_update_notices, github_stars, star_reminder_days, star_interests, star_votes, star_suggestions, star_neighbors, star_subscribers, user_connections, discount_candidates, problem_reports, discord_layout_plans, discord_managed_resources, summaries, classifications,
      item_relations, source_items, source_cursors, raw_events, sources RESTART IDENTITY CASCADE`);
  }

  async createSource(
    kind: string,
    locator: string,
    visibility: Visibility,
    policy: Record<string, unknown> = {},
  ): Promise<string> {
    if (kind === "html") {
      validateHtmlSourceLocator(locator);
      parseHtmlSourcePolicy(policy);
    }
    const id = randomUUID();
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO sources (id, kind, locator, collection_policy)
       VALUES ($1, $2, $3, $5::jsonb || jsonb_build_object('visibility', $4::text))
       ON CONFLICT (kind, locator) DO UPDATE SET updated_at = now()
       RETURNING id`,
      [id, kind, locator, visibility, JSON.stringify(policy)],
    );
    return result.rows[0]!.id;
  }

  async sourceVisibility(
    sourceId: string,
    client?: PoolClient,
  ): Promise<Visibility> {
    const result = await (client ?? this.pool).query<{
      visibility: Visibility;
    }>(
      `SELECT COALESCE(collection_policy->>'visibility', 'private')::text AS visibility FROM sources WHERE id = $1`,
      [sourceId],
    );
    if (!result.rows[0]) throw new Error("Source not found");
    return result.rows[0].visibility;
  }

  async insertRawEvent(
    sourceId: string,
    externalId: string | null,
    checksum: string,
    payload: unknown,
    collectedAt: Date,
    transactionClient?: PoolClient,
  ): Promise<RawEventResult> {
    const work = async (client: PoolClient): Promise<RawEventResult> => {
      const source = await client.query<{ state: string }>(
        "SELECT state FROM sources WHERE id=$1 FOR UPDATE",
        [sourceId],
      );
      if (!source.rows[0] || source.rows[0].state !== "active")
        throw new Error("Source is unavailable");
      const id = randomUUID();
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO raw_events (id, source_id, external_event_id, canonical_payload_hash, payload, collected_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)
       ON CONFLICT DO NOTHING RETURNING id`,
        [
          id,
          sourceId,
          externalId,
          checksum,
          JSON.stringify(payload),
          collectedAt,
        ],
      );
      if (inserted.rows[0]) return { id: inserted.rows[0].id, inserted: true };
      const existing = await client.query<{ id: string }>(
        `SELECT id FROM raw_events WHERE source_id = $1 AND
       (($2::text IS NOT NULL AND external_event_id = $2) OR ($2::text IS NULL AND canonical_payload_hash = $3))`,
        [sourceId, externalId, checksum],
      );
      if (!existing.rows[0])
        throw new Error("Conflicting raw event could not be resolved");
      return { id: existing.rows[0].id, inserted: false };
    };
    return transactionClient ? work(transactionClient) : this.transaction(work);
  }

  async sourceCursor(sourceId: string): Promise<string | null> {
    const { rows } = await this.pool.query<{ cursor_value: string | null }>(
      "SELECT cursor_value FROM source_cursors WHERE source_id = $1",
      [sourceId],
    );
    return rows[0]?.cursor_value ?? null;
  }

  async saveCursor(
    sourceId: string,
    cursor: string | null,
    etag: string | null,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO source_cursors (source_id, cursor_value, etag, last_success_at)
       VALUES ($1, $2, $3, now()) ON CONFLICT (source_id) DO UPDATE
       SET cursor_value = EXCLUDED.cursor_value, etag = EXCLUDED.etag, last_success_at = now(),
           last_error = NULL, failure_count = 0, updated_at = now()`,
      [sourceId, cursor, etag],
    );
  }

  async recordSourceFailure(sourceId: string, message: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO source_cursors (source_id, last_error, failure_count)
       VALUES ($1, $2, 1) ON CONFLICT (source_id) DO UPDATE
       SET last_error = EXCLUDED.last_error, failure_count = source_cursors.failure_count + 1, updated_at = now()`,
      [sourceId, message.slice(0, 500)],
    );
  }

  /** Re-seeing a candidate changes nothing; returns whether this one is new. */
  /**
   * Deals people reported since a time, each with when a route had first found
   * the same domain, or null. A report with no earlier find is one Rapi missed.
   */
  async reportedDeals(since: Date): Promise<
    Array<{
      domain: string;
      url: string;
      reportedAt: Date;
      foundAt: Date | null;
      foundBy: string | null;
    }>
  > {
    const { rows } = await this.pool.query<{
      domain: string;
      url: string;
      reported_at: Date;
      found_at: Date | null;
      found_by: string | null;
    }>(
      `SELECT r.domain, r.url, r.first_seen_at AS reported_at,
              found.first_seen_at AS found_at, found.route AS found_by
       FROM discount_candidates r
       LEFT JOIN LATERAL (
         SELECT c.first_seen_at, c.route FROM discount_candidates c
         WHERE c.route <> 'report' AND c.domain = r.domain
           AND c.first_seen_at <= r.first_seen_at
         ORDER BY c.first_seen_at LIMIT 1
       ) found ON true
       WHERE r.route = 'report' AND r.kind = 'discount' AND r.first_seen_at >= $1
       ORDER BY r.first_seen_at`,
      [since],
    );
    return rows.map((row) => ({
      domain: row.domain,
      url: row.url,
      reportedAt: row.reported_at,
      foundAt: row.found_at,
      foundBy: row.found_by,
    }));
  }

  /** Which of these keys are stored already. */
  async knownCandidateKeys(keys: readonly string[]): Promise<Set<string>> {
    const { rows } = await this.pool.query<{ dedupe_key: string }>(
      "SELECT dedupe_key FROM discount_candidates WHERE dedupe_key = ANY($1)",
      [[...keys]],
    );
    return new Set(rows.map((row) => row.dedupe_key));
  }

  async saveDiscountCandidate(candidate: DiscountCandidate): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO discount_candidates
         (kind, route, dedupe_key, domain, title, url, evidence, published_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [
        candidate.kind,
        candidate.route,
        candidate.dedupeKey,
        candidate.domain,
        candidate.title,
        candidate.url,
        candidate.evidence,
        candidate.publishedAt,
      ],
    );
    return result.rowCount === 1;
  }

  /**
   * The limit and the insert share a lock per reporter, so sending six at once
   * still saves five. A link already reported saves nothing and does not count.
   */
  async saveReport(report: NewReport, perHour: number): Promise<ReportOutcome> {
    return this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `report:${report.reporterId}`,
      ]);
      const { rows } = await client.query<{ count: number }>(
        `SELECT ((SELECT count(*) FROM discount_candidates
                  WHERE reporter_id = $1 AND first_seen_at > now() - interval '1 hour')
               + (SELECT count(*) FROM problem_reports
                  WHERE reporter_id = $1 AND reported_at > now() - interval '1 hour'))::int AS count`,
        [report.reporterId],
      );
      if (rows[0]!.count >= perHour) return "limited";
      const { url, domain, reporterId, memo } = report;
      const result =
        report.kind === "problem"
          ? await client.query(
              `INSERT INTO problem_reports (url, domain, reporter_id, memo)
               VALUES ($1, $2, $3, $4)
               ON CONFLICT (url) WHERE decision IS NULL DO NOTHING`,
              [url, domain, reporterId, memo],
            )
          : await client.query(
              `INSERT INTO discount_candidates
                 (kind, route, dedupe_key, domain, title, url, evidence, reporter_id, memo)
               VALUES ($1, 'report', $2, $3, $3, $4, '', $5, $6)
               ON CONFLICT (dedupe_key) DO NOTHING`,
              [report.kind, `report:${url}`, domain, url, reporterId, memo],
            );
      return result.rowCount === 1 ? "saved" : "duplicate";
    });
  }

  /** Oldest first. A row with a band has been decided, by the rules or the owner. */
  async unverifiedDiscountCandidates(
    limit: number,
    route?: DiscountCandidateRoute,
  ): Promise<CandidateToVerify[]> {
    const { rows } = await this.pool.query<CandidateToVerify>(
      `SELECT id, kind, route, domain, title, evidence FROM discount_candidates
       WHERE band IS NULL AND ($2::text IS NULL OR route = $2)
       ORDER BY first_seen_at, id LIMIT $1`,
      [limit, route ?? null],
    );
    return rows;
  }

  /**
   * Never overwrites a band, so a red set by hand stays red. A domain the owner
   * already decided against stays red for rows found after that decision.
   */
  async saveCandidateVerification(
    id: string,
    verification: CandidateVerification,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE discount_candidates
       SET band = CASE WHEN EXISTS (
             SELECT 1 FROM problem_reports
             WHERE problem_reports.domain = discount_candidates.domain
               AND problem_reports.decision = 'red'
           ) THEN 'red' ELSE $2::text END,
           tags = $3, operator = $4, price_check = $5,
           terms_url = $6, terms_note = $7, verified_at = now()
       WHERE id = $1 AND band IS NULL`,
      [
        id,
        verification.band,
        verification.tags,
        verification.operator,
        verification.priceCheck,
        verification.termsUrl,
        verification.termsNote,
      ],
    );
  }

  /**
   * Newest first. The published date decides when there is one: a first collection
   * finds months-old changelog entries, and they are not news just because they
   * were first seen this week.
   */
  async candidatesForCards(limit: number): Promise<CandidateForCard[]> {
    const { rows } = await this.pool.query<CandidateForCard>(
      `SELECT id, kind, route, domain, title, url, evidence, band, tags, operator,
              price_check AS "priceCheck", terms_note AS "termsNote", memo
       FROM discount_candidates
       WHERE carded_at IS NULL AND band IN ('green', 'yellow')
         AND COALESCE(published_at, first_seen_at) >= now() - interval '7 days'
       ORDER BY COALESCE(published_at, first_seen_at) DESC, id LIMIT $1`,
      [limit],
    );
    return rows;
  }

  /** Sent ones only: a row claimed without a message was never seen by anyone. */
  async newServiceCardsInLastDay(): Promise<number> {
    const { rows } = await this.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM discount_candidates
       WHERE kind = 'new_service' AND route <> 'report'
         AND card_message_id IS NOT NULL
         AND carded_at > now() - interval '24 hours'`,
    );
    return rows[0]!.count;
  }

  /** Sent ones only, as for new services. */
  async unvettedCardsInLastDay(): Promise<number> {
    const { rows } = await this.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM discount_candidates
       WHERE route = ANY($1)
         AND card_message_id IS NOT NULL
         AND carded_at > now() - interval '24 hours'`,
      [[...UNVETTED_ROUTES]],
    );
    return rows[0]!.count;
  }

  /** Both kinds of card go to the same channel, and the limit is the channel's. */
  async cardsInLastHour(): Promise<number> {
    const { rows } = await this.pool.query<{ count: number }>(
      `SELECT ((SELECT count(*) FROM discount_candidates
                WHERE carded_at > now() - interval '1 hour')
             + (SELECT count(*) FROM problem_reports
                WHERE carded_at > now() - interval '1 hour')
             + (SELECT count(*) FROM discord_guilds
                WHERE carded_at > now() - interval '1 hour'))::int AS count`,
    );
    return rows[0]!.count;
  }

  /** Taken before sending. False when another run has it or the owner just made it red. */
  async claimCandidateCard(id: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE discount_candidates SET carded_at = now()
       WHERE id = $1 AND carded_at IS NULL AND band IN ('green', 'yellow')`,
      [id],
    );
    return result.rowCount === 1;
  }

  /** Only for a send Discord refused, so the card goes out on a later run. */
  async releaseCandidateCard(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE discount_candidates SET carded_at = NULL
       WHERE id = $1 AND card_message_id IS NULL`,
      [id],
    );
  }

  async saveCandidateCardMessage(id: string, messageId: string): Promise<void> {
    await this.pool.query(
      `UPDATE discount_candidates SET card_message_id = $2 WHERE id = $1`,
      [id, messageId],
    );
  }

  async candidateForDecision(id: string): Promise<CandidateForDecision | null> {
    const { rows } = await this.pool.query<CandidateForDecision>(
      `SELECT id, kind, route, domain, title, url, evidence, band, tags, operator,
              price_check AS "priceCheck", terms_note AS "termsNote", status
       FROM discount_candidates WHERE id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  /** When another card can go out, or null while the last hour has room. */
  async publicationRetryAt(perHour: number): Promise<Date | null> {
    const { rows } = await this.pool.query<{ retryAt: Date }>(
      PUBLICATION_RETRY_AT,
      [perHour - 1],
    );
    return rows[0]?.retryAt ?? null;
  }

  /**
   * Taken before sending, so double clicks and two open tabs send once. The lock
   * keeps two different cards from both taking the hour's last place. Over the
   * limit nothing changes and `retryAt` says when to try.
   */
  async claimCandidatePublication(
    id: string,
    perHour: number,
  ): Promise<{ claimed: boolean; retryAt: Date | null }> {
    return this.transaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('discount_publication'))",
      );
      const { rows } = await client.query<{ retryAt: Date }>(
        PUBLICATION_RETRY_AT,
        [perHour - 1],
      );
      if (rows[0]) return { claimed: false, retryAt: rows[0].retryAt };
      const result = await client.query(
        `UPDATE discount_candidates SET status = 'published', decided_at = now()
         WHERE id = $1 AND status = 'new' AND band IN ('green', 'yellow')`,
        [id],
      );
      return { claimed: result.rowCount === 1, retryAt: null };
    });
  }

  /** Only for a send Discord refused, so the owner can press the button again. */
  async releaseCandidatePublication(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE discount_candidates SET status = 'new', decided_at = NULL
       WHERE id = $1 AND status = 'published' AND public_message_id IS NULL`,
      [id],
    );
  }

  async saveCandidatePublicMessage(
    id: string,
    messageId: string,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE discount_candidates SET public_message_id = $2 WHERE id = $1`,
      [id, messageId],
    );
  }

  async discardCandidate(id: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE discount_candidates SET status = 'discarded', decided_at = now()
       WHERE id = $1 AND status = 'new'`,
      [id],
    );
    return result.rowCount === 1;
  }

  /** Oldest first: each is a question waiting for the owner. */
  async problemReportsForCards(limit: number): Promise<ProblemReportForCard[]> {
    const { rows } = await this.pool.query<ProblemReportForCard>(
      `SELECT id, url, domain, reporter_id AS "reporterId", memo
       FROM problem_reports
       WHERE carded_at IS NULL AND decision IS NULL
       ORDER BY reported_at, id LIMIT $1`,
      [limit],
    );
    return rows;
  }

  async claimProblemCard(id: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE problem_reports SET carded_at = now()
       WHERE id = $1 AND carded_at IS NULL AND decision IS NULL`,
      [id],
    );
    return result.rowCount === 1;
  }

  async releaseProblemCard(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE problem_reports SET carded_at = NULL
       WHERE id = $1 AND card_message_id IS NULL`,
      [id],
    );
  }

  async saveProblemCardMessage(id: string, messageId: string): Promise<void> {
    await this.pool.query(
      `UPDATE problem_reports SET card_message_id = $2 WHERE id = $1`,
      [id, messageId],
    );
  }

  /**
   * Null when it was already decided. Red turns every row of the domain red at
   * once, and says how many of them had already gone to the public channel.
   */
  async decideProblemReport(
    id: string,
    decision: ProblemDecision,
    decidedBy: string,
  ): Promise<{
    url: string;
    domain: string;
    turnedRed: number;
    alreadyPublished: number;
  } | null> {
    return this.transaction(async (client) => {
      const { rows } = await client.query<{ url: string; domain: string }>(
        `UPDATE problem_reports
         SET decision = $2, decided_by = $3, decided_at = now()
         WHERE id = $1 AND decision IS NULL
         RETURNING url, domain`,
        [id, decision, decidedBy],
      );
      const report = rows[0];
      if (!report) return null;
      if (decision !== "red")
        return { ...report, turnedRed: 0, alreadyPublished: 0 };
      const red = await client.query<{ status: string }>(
        `UPDATE discount_candidates SET band = 'red' WHERE domain = $1 RETURNING status`,
        [report.domain],
      );
      return {
        ...report,
        turnedRed: red.rows.length,
        alreadyPublished: red.rows.filter((row) => row.status === "published")
          .length,
      };
    });
  }

  async saveItem(
    item: NormalizedItem,
    summary: string,
    transactionClient?: PoolClient,
  ): Promise<{ id: string; inserted: boolean }> {
    const work = async (
      client: PoolClient,
    ): Promise<{ id: string; inserted: boolean }> => {
      const result = await client.query<{ id: string }>(
        `INSERT INTO source_items
          (id, raw_event_id, normalizer_version, canonical_url, title, body, author, published_at,
           collected_at, visibility, content_fingerprint, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
         ON CONFLICT (raw_event_id, normalizer_version) DO NOTHING RETURNING id`,
        [
          item.id,
          item.rawEventId,
          item.normalizerVersion,
          item.canonicalUrl,
          item.title,
          item.body,
          item.author,
          item.publishedAt,
          item.collectedAt,
          item.visibility,
          item.contentFingerprint,
          JSON.stringify({ ...item.metadata, sourceId: item.sourceId }),
        ],
      );
      if (!result.rows[0]) {
        const existing = await client.query<{ id: string }>(
          "SELECT id FROM source_items WHERE raw_event_id=$1 AND normalizer_version=$2",
          [item.rawEventId, item.normalizerVersion],
        );
        return { id: existing.rows[0]!.id, inserted: false };
      }
      for (const category of item.categories) {
        await client.query(
          `INSERT INTO classifications (id, source_item_id, taxonomy_version, label, score, evidence)
           VALUES ($1,$2,'rules-v1',$3,1,'deterministic keyword rule') ON CONFLICT DO NOTHING`,
          [randomUUID(), item.id, category],
        );
      }
      const cacheKey = `${item.id}:item:rules-v1:summary-v1`;
      await client.query(
        `INSERT INTO summaries (id,purpose,cache_key,model_policy_version,prompt_version,content,evidence_item_ids)
         VALUES ($1,'item',$2,'rules-v1','summary-v1',$3,$4::uuid[]) ON CONFLICT (cache_key) DO NOTHING`,
        [randomUUID(), cacheKey, summary, [item.id]],
      );
      const related = await client.query<{ id: string }>(
        `SELECT id FROM source_items WHERE id <> $1 AND (canonical_url=$2 OR content_fingerprint=$3) LIMIT 1`,
        [item.id, item.canonicalUrl, item.contentFingerprint],
      );
      if (related.rows[0]) {
        await client.query(
          `INSERT INTO item_relations (source_item_id,related_item_id,relation,policy_version)
           VALUES ($1,$2,'duplicate_candidate','dedup-v1') ON CONFLICT DO NOTHING`,
          [item.id, related.rows[0].id],
        );
      }
      return { id: item.id, inserted: true };
    };
    return transactionClient ? work(transactionClient) : this.transaction(work);
  }

  async allowedDiscordGuilds(): Promise<
    Array<{ guildId: string; allowedAt: Date | null }>
  > {
    const result = await this.pool.query<{
      guild_id: string;
      decided_at: Date | null;
    }>("SELECT guild_id,decided_at FROM discord_guilds WHERE status='allowed'");
    return result.rows.map((row) => ({
      guildId: row.guild_id,
      allowedAt: row.decided_at,
    }));
  }

  /**
   * One row per guild, so one open request. Only a guild that is neither allowed,
   * blocked nor already waiting opens a new one, and only after the wait.
   */
  async openGuildRequest(
    input: { guildId: string; requesterId: string; reason: string | null },
    waitDays: number,
  ): Promise<{
    status: "opened" | "pending" | "allowed" | "blocked" | "waiting";
    retryAt: Date | null;
  }> {
    const opened = await this.pool.query(
      `INSERT INTO discord_guilds (guild_id, status, requester_id, reason)
       VALUES ($1, 'pending', $2, $3)
       ON CONFLICT (guild_id) DO UPDATE
       SET status = 'pending', requester_id = $2, reason = $3, requested_at = now(),
           decided_at = NULL, decided_by = NULL, carded_at = NULL, card_message_id = NULL
       WHERE discord_guilds.status IN ('rejected', 'left')
         AND COALESCE(discord_guilds.decided_at, discord_guilds.requested_at)
             <= now() - make_interval(days => $4::int)
       RETURNING guild_id`,
      [input.guildId, input.requesterId, input.reason, waitDays],
    );
    if (opened.rows[0]) return { status: "opened", retryAt: null };
    const { rows } = await this.pool.query<{
      status: string;
      retry_at: Date;
    }>(
      `SELECT status, COALESCE(decided_at, requested_at) + make_interval(days => $2::int) AS retry_at
       FROM discord_guilds WHERE guild_id = $1`,
      [input.guildId, waitDays],
    );
    const status = rows[0]?.status;
    return status === "pending" || status === "allowed" || status === "blocked"
      ? { status, retryAt: null }
      : { status: "waiting", retryAt: rows[0]?.retry_at ?? null };
  }

  /** The card's decision. False when the request is no longer open, as on a double click. */
  async decideGuildRequest(
    guildId: string,
    status: "allowed" | "blocked",
    decidedBy: string,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE discord_guilds SET status = $2, decided_at = now(), decided_by = $3
       WHERE guild_id = $1 AND status = 'pending'`,
      [guildId, status, decidedBy],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** /서버 승인 and /서버 차단: whatever state the guild is in, with or without a request. */
  async setGuildStatus(
    guildId: string,
    status: "allowed" | "blocked",
    decidedBy: string,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO discord_guilds (guild_id, status, decided_at, decided_by)
       VALUES ($1, $2, now(), $3)
       ON CONFLICT (guild_id) DO UPDATE
       SET status = $2, decided_at = now(), decided_by = $3
       WHERE discord_guilds.status <> $2`,
      [guildId, status, decidedBy],
    );
  }

  /** /서버 해제. The guild is not approved by this, and its wait counts from now. */
  async liftGuildBlock(guildId: string, decidedBy: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE discord_guilds SET status = 'rejected', decided_at = now(), decided_by = $2
       WHERE guild_id = $1 AND status = 'blocked'`,
      [guildId, decidedBy],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async guildRequestsForCards(limit: number): Promise<
    Array<{
      guildId: string;
      name: string | null;
      requesterId: string | null;
      reason: string | null;
    }>
  > {
    const { rows } = await this.pool.query<{
      guild_id: string;
      name: string | null;
      requester_id: string | null;
      reason: string | null;
    }>(
      `SELECT guild_id, name, requester_id, reason FROM discord_guilds
       WHERE status = 'pending' AND carded_at IS NULL
       ORDER BY requested_at LIMIT $1`,
      [limit],
    );
    return rows.map((row) => ({
      guildId: row.guild_id,
      name: row.name,
      requesterId: row.requester_id,
      reason: row.reason,
    }));
  }

  /** Taken before sending. False when another run has it or it was decided meanwhile. */
  async claimGuildCard(guildId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE discord_guilds SET carded_at = now()
       WHERE guild_id = $1 AND carded_at IS NULL AND status = 'pending'`,
      [guildId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async releaseGuildCard(guildId: string): Promise<void> {
    await this.pool.query(
      `UPDATE discord_guilds SET carded_at = NULL WHERE guild_id = $1`,
      [guildId],
    );
  }

  async saveGuildCardMessage(
    guildId: string,
    messageId: string,
    name: string | null,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE discord_guilds SET card_message_id = $2, name = COALESCE($3, name)
       WHERE guild_id = $1`,
      [guildId, messageId, name],
    );
  }

  async guildFeatureSettings(
    guildId: string,
  ): Promise<Array<{ feature: string; enabled: boolean }>> {
    const result = await this.pool.query<{
      feature: string;
      enabled: boolean;
    }>("SELECT feature,enabled FROM discord_guild_features WHERE guild_id=$1", [
      guildId,
    ]);
    return result.rows;
  }

  async setGuildFeature(
    guildId: string,
    feature: string,
    enabled: boolean,
    actorId: string,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO discord_guild_features(guild_id,feature,enabled,updated_by) VALUES($1,$2,$3,$4)
       ON CONFLICT (guild_id,feature) DO UPDATE SET enabled=$3,updated_by=$4,updated_at=now()`,
      [guildId, feature, enabled, actorId],
    );
  }

  async guildChannels(
    guildId: string,
  ): Promise<Array<{ kind: string; channelId: string }>> {
    const result = await this.pool.query<{ kind: string; channelId: string }>(
      `SELECT kind, channel_id AS "channelId" FROM discord_guild_channels WHERE guild_id=$1`,
      [guildId],
    );
    return result.rows;
  }

  async publicGuildChannels(
    kind: string,
  ): Promise<Array<{ guildId: string; channelId: string }>> {
    const result = await this.pool.query<{
      guildId: string;
      channelId: string;
    }>(
      `SELECT guild_id AS "guildId", channel_id AS "channelId"
       FROM discord_guild_channels WHERE kind=$1 ORDER BY updated_at`,
      [kind],
    );
    return result.rows;
  }

  async setGuildChannel(
    guildId: string,
    kind: string,
    channelId: string,
    actorId: string,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO discord_guild_channels(guild_id,kind,channel_id,updated_by) VALUES($1,$2,$3,$4)
       ON CONFLICT (guild_id,kind) DO UPDATE SET channel_id=$3,updated_by=$4,updated_at=now()`,
      [guildId, kind, channelId, actorId],
    );
  }

  async clearGuildChannel(guildId: string, kind: string): Promise<void> {
    await this.pool.query(
      "DELETE FROM discord_guild_channels WHERE guild_id=$1 AND kind=$2",
      [guildId, kind],
    );
  }

  async rapiUpdateNoticed(): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      "SELECT 1 FROM rapi_update_notices LIMIT 1",
    );
    return (rowCount ?? 0) > 0;
  }

  async claimRapiUpdate(tag: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      "INSERT INTO rapi_update_notices(tag) VALUES($1) ON CONFLICT DO NOTHING",
      [tag],
    );
    return rowCount === 1;
  }

  async communityGuildPostSent(guildId: string, key: string): Promise<boolean> {
    const result = await this.pool.query(
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
    await this.pool.query(
      `INSERT INTO community_guild_posts(guild_id,key,channel_id,message_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [input.guildId, input.key, input.channelId, input.messageId],
    );
  }

  async communityPostExists(key: string): Promise<boolean> {
    const result = await this.pool.query(
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
    await this.pool.query(
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
    await this.pool.query(
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
    const result = await this.pool.query<{ key: string }>(
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
    const result = await this.pool.query<{
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
    const result = await this.pool.query(
      `UPDATE community_posts SET state=$2,channel_id=$3,message_id=$4,posted_at=now() WHERE key=$1 AND state='draft'`,
      [key, state, channelId, messageId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async lastCommunityPostAt(
    feed: string,
    prefix: string,
  ): Promise<Date | null> {
    const result = await this.pool.query<{ at: Date | null }>(
      "SELECT max(posted_at) AS at FROM community_posts WHERE feed=$1 AND starts_with(key,$2)",
      [feed, prefix],
    );
    return result.rows[0]?.at ?? null;
  }

  /** Removes bookkeeping markers; real posts and drafts are never touched. */
  async deleteCommunityMarkers(keys: string[]): Promise<void> {
    if (!keys.length) return;
    await this.pool.query(
      "DELETE FROM community_posts WHERE state='marker' AND key=ANY($1)",
      [keys],
    );
  }

  async communityPostKeys(prefix: string): Promise<string[]> {
    const result = await this.pool.query<{ key: string }>(
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
    const result = await this.pool.query(
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
    const result = await this.pool.query(
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

  /** One person's stars and everything learned from them. */
  starsOf(ownerId: string): StarOwnerStore {
    return new PostgresStarOwnerStore(
      this.pool,
      (work) => this.transaction(work),
      ownerId,
    );
  }

  /** Everyone who gets the daily DM, earliest first. */
  async starSubscribers(): Promise<StarSubscriber[]> {
    const { rows } = await this.pool.query<StarSubscriber>(
      `SELECT user_id AS "userId", github_login AS "githubLogin",
              subscribed_at AS "subscribedAt", paused_at AS "pausedAt",
              paused_reason AS "pausedReason"
       FROM star_subscribers ORDER BY subscribed_at, user_id`,
    );
    return rows;
  }

  async starSubscriber(userId: string): Promise<StarSubscriber | null> {
    const { rows } = await this.pool.query<StarSubscriber>(
      `SELECT user_id AS "userId", github_login AS "githubLogin",
              subscribed_at AS "subscribedAt", paused_at AS "pausedAt",
              paused_reason AS "pausedReason"
       FROM star_subscribers WHERE user_id = $1`,
      [userId],
    );
    return rows[0] ?? null;
  }

  /**
   * Turns reminders on for someone, or changes whose stars they read. A new
   * login drops the stars and neighbors read for the old one; the interests
   * they picked, their thumbs and what they were shown stay. Saving again
   * unpauses.
   */
  async saveStarSubscriber(userId: string, githubLogin: string): Promise<void> {
    await this.transaction(async (client) => {
      const before = await client.query<{ github_login: string }>(
        "SELECT github_login FROM star_subscribers WHERE user_id = $1 FOR UPDATE",
        [userId],
      );
      const old = before.rows[0]?.github_login;
      // What was read from the old login goes; what they were shown and when stays,
      // so nothing comes twice and today is not sent again.
      if (old !== undefined && old.toLowerCase() !== githubLogin.toLowerCase())
        for (const table of ["github_stars", "star_neighbors"])
          await client.query(`DELETE FROM ${table} WHERE owner_id = $1`, [
            userId,
          ]);
      await client.query(
        `INSERT INTO star_subscribers (user_id, github_login) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET github_login = EXCLUDED.github_login,
           paused_at = NULL, paused_reason = NULL`,
        [userId, githubLogin],
      );
    });
  }

  /** Adds the configured owner once; a login they connected themselves wins. */
  async addStarSubscriber(userId: string, githubLogin: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO star_subscribers (user_id, github_login) VALUES ($1, $2)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId, githubLogin],
    );
  }

  async pauseStarSubscriber(userId: string, reason: string): Promise<void> {
    await this.pool.query(
      `UPDATE star_subscribers SET paused_at = now(), paused_reason = $2
       WHERE user_id = $1 AND paused_at IS NULL`,
      [userId, reason.slice(0, 200)],
    );
  }

  /** Stops the DM and forgets everything about them. True when they were connected. */
  async removeStarSubscriber(userId: string): Promise<boolean> {
    return this.transaction(async (client) => {
      for (const table of [
        ...STAR_LOGIN_TABLES,
        "star_interests",
        "star_votes",
      ])
        await client.query(`DELETE FROM ${table} WHERE owner_id = $1`, [
          userId,
        ]);
      const removed = await client.query(
        "DELETE FROM star_subscribers WHERE user_id = $1",
        [userId],
      );
      return removed.rowCount === 1;
    });
  }

  /** Hands the rows from before stars had owners to the configured owner. */
  async adoptOwnerlessStars(ownerId: string): Promise<number> {
    return this.transaction(async (client) => {
      let moved = 0;
      for (const table of STAR_LOGIN_TABLES)
        moved +=
          (
            await client.query(
              `UPDATE ${table} SET owner_id = $1 WHERE owner_id = ''`,
              [ownerId],
            )
          ).rowCount ?? 0;
      return moved;
    });
  }

  async sourceStatus(): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(
      `SELECT s.id,s.kind,s.locator,s.state,s.collection_policy,c.last_success_at,c.last_error,COALESCE(c.failure_count,0) AS failure_count
       FROM sources s LEFT JOIN source_cursors c ON c.source_id=s.id ORDER BY s.created_at`,
    );
    return result.rows;
  }

  async collectableSources(): Promise<
    Array<{
      id: string;
      kind: string;
      locator: string;
      collection_policy: unknown;
      etag: string | null;
      last_success_at: Date | null;
    }>
  > {
    const result = await this.pool.query<{
      id: string;
      kind: string;
      locator: string;
      collection_policy: unknown;
      etag: string | null;
      last_success_at: Date | null;
    }>(
      `SELECT s.id,s.kind,s.locator,s.collection_policy,c.etag,c.last_success_at FROM sources s
       LEFT JOIN source_cursors c ON c.source_id=s.id
       WHERE s.state='active' AND s.kind IN ('github','rss','html','github_stars') ORDER BY s.created_at`,
    );
    return result.rows;
  }

  async sourceExternalIds(sourceId: string): Promise<string[]> {
    const result = await this.pool.query<{ external_event_id: string }>(
      "SELECT external_event_id FROM raw_events WHERE source_id=$1 AND external_event_id IS NOT NULL",
      [sourceId],
    );
    return result.rows.map((row) => row.external_event_id);
  }

  async checkHealth(): Promise<{
    latencyMs: number;
    databaseBytes: number;
    clusterDatabaseBytes: number;
  }> {
    const started = performance.now();
    const result = await this.pool.query<{
      bytes: string;
      cluster_bytes: string;
    }>(
      `SELECT pg_database_size(current_database())::text AS bytes,
        (SELECT sum(pg_database_size(datname))::text FROM pg_database) AS cluster_bytes`,
    );
    return {
      latencyMs: Math.round(performance.now() - started),
      databaseBytes: Number(result.rows[0]?.bytes ?? 0),
      clusterDatabaseBytes: Number(result.rows[0]?.cluster_bytes ?? 0),
    };
  }

  async appliedMigrationNames(): Promise<string[]> {
    const result = await this.pool.query<{ name: string }>(
      "SELECT name FROM schema_migrations ORDER BY name",
    );
    return result.rows.map((row) => row.name);
  }

  async managedDiscordResourceId(
    guildId: string,
    resourceType: "role" | "category" | "channel" | "message" | "webhook",
    key: string,
  ): Promise<string | null> {
    const result = await this.pool.query<{ discord_id: string }>(
      `SELECT discord_id FROM discord_managed_resources
       WHERE guild_id=$1 AND resource_type=$2 AND resource_key=$3`,
      [guildId, resourceType, key],
    );
    return result.rows[0]?.discord_id ?? null;
  }

  async listManagedDiscordResources(
    guildId: string,
  ): Promise<ManagedDiscordResourceRecord[]> {
    const result = await this.pool.query<{
      guild_id: string;
      resource_type: ManagedDiscordResourceRecord["resourceType"];
      resource_key: string;
      discord_id: string;
      last_applied_digest: string;
    }>(
      `SELECT guild_id,resource_type,resource_key,discord_id,last_applied_digest
       FROM discord_managed_resources WHERE guild_id=$1
       ORDER BY resource_type,resource_key`,
      [guildId],
    );
    return result.rows.map((row) => ({
      guildId: row.guild_id,
      resourceType: row.resource_type,
      key: row.resource_key,
      discordId: row.discord_id,
      layoutDigest: row.last_applied_digest,
    }));
  }

  async upsertManagedDiscordResource(input: {
    guildId: string;
    resourceType: ManagedDiscordResourceRecord["resourceType"];
    key: string;
    discordId: string;
    layoutDigest: string;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO discord_managed_resources
        (guild_id,resource_type,resource_key,discord_id,last_applied_digest)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (guild_id,resource_type,resource_key) DO UPDATE SET
         discord_id=EXCLUDED.discord_id,
         last_applied_digest=EXCLUDED.last_applied_digest,updated_at=now()`,
      [
        input.guildId,
        input.resourceType,
        input.key,
        input.discordId,
        input.layoutDigest,
      ],
    );
  }

  async removeManagedDiscordResource(
    guildId: string,
    resourceType: ManagedDiscordResourceRecord["resourceType"],
    discordId: string,
  ): Promise<void> {
    await this.pool.query(
      `DELETE FROM discord_managed_resources
       WHERE guild_id=$1 AND resource_type=$2 AND discord_id=$3`,
      [guildId, resourceType, discordId],
    );
  }

  async createDiscordLayoutPlan(input: {
    guildId: string;
    createdBy: string;
    layoutDigest: string;
    snapshotDigest: string;
    payload: Record<string, unknown>;
    expiresAt: Date;
  }): Promise<string> {
    const id = randomUUID();
    await this.pool.query(
      `INSERT INTO discord_layout_plans
        (id,guild_id,created_by,layout_digest,snapshot_digest,actions,expires_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
      [
        id,
        input.guildId,
        input.createdBy,
        input.layoutDigest,
        input.snapshotDigest,
        JSON.stringify(input.payload),
        input.expiresAt,
      ],
    );
    return id;
  }

  async discordLayoutPlan(
    guildId: string,
    id: string,
  ): Promise<DiscordLayoutPlanRecord | null> {
    const result = await this.pool.query<{
      id: string;
      guild_id: string;
      created_by: string;
      layout_digest: string;
      snapshot_digest: string;
      actions: Record<string, unknown>;
      expires_at: Date;
      applied_at: Date | null;
    }>(
      `SELECT id,guild_id,created_by,layout_digest,snapshot_digest,actions,
              expires_at,applied_at
       FROM discord_layout_plans WHERE guild_id=$1 AND id=$2`,
      [guildId, id],
    );
    const row = result.rows[0];
    return row
      ? {
          id: row.id,
          guildId: row.guild_id,
          createdBy: row.created_by,
          layoutDigest: row.layout_digest,
          snapshotDigest: row.snapshot_digest,
          payload: row.actions,
          expiresAt: row.expires_at,
          appliedAt: row.applied_at,
        }
      : null;
  }

  async markDiscordLayoutPlanApplied(
    guildId: string,
    id: string,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE discord_layout_plans SET applied_at=now()
       WHERE guild_id=$1 AND id=$2 AND applied_at IS NULL AND expires_at>now()`,
      [guildId, id],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async claimDiscordLayoutPlan(guildId: string, id: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE discord_layout_plans SET apply_started_at=now()
       WHERE guild_id=$1 AND id=$2 AND applied_at IS NULL
         AND apply_started_at IS NULL AND expires_at>now()`,
      [guildId, id],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async releaseDiscordLayoutPlanClaim(
    guildId: string,
    id: string,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE discord_layout_plans SET apply_started_at=NULL
       WHERE guild_id=$1 AND id=$2 AND applied_at IS NULL`,
      [guildId, id],
    );
  }
}
