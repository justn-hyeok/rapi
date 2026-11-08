import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { type RawEventResult } from "@rapi/application";
import type { NormalizedItem, Visibility } from "@rapi/domain";
import { parseHtmlSourcePolicy, validateHtmlSourceLocator } from "@rapi/domain";
import type { SourceStore } from "@rapi/application";
import type { PostgresDatabase } from "./database.js";

/** Sources, their cursors, raw events and items. */
export class PostgresSourceStore implements SourceStore {
  constructor(private readonly db: PostgresDatabase) {}

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
    const result = await this.db.pool.query<{ id: string }>(
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
    const result = await (client ?? this.db.pool).query<{
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
    return transactionClient
      ? work(transactionClient)
      : this.db.transaction(work);
  }

  async sourceCursor(sourceId: string): Promise<string | null> {
    const { rows } = await this.db.pool.query<{ cursor_value: string | null }>(
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
    await this.db.pool.query(
      `INSERT INTO source_cursors (source_id, cursor_value, etag, last_success_at)
       VALUES ($1, $2, $3, now()) ON CONFLICT (source_id) DO UPDATE
       SET cursor_value = EXCLUDED.cursor_value, etag = EXCLUDED.etag, last_success_at = now(),
           last_error = NULL, failure_count = 0, updated_at = now()`,
      [sourceId, cursor, etag],
    );
  }

  async recordSourceFailure(sourceId: string, message: string): Promise<void> {
    await this.db.pool.query(
      `INSERT INTO source_cursors (source_id, last_error, failure_count)
       VALUES ($1, $2, 1) ON CONFLICT (source_id) DO UPDATE
       SET last_error = EXCLUDED.last_error, failure_count = source_cursors.failure_count + 1, updated_at = now()`,
      [sourceId, message.slice(0, 500)],
    );
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
    return transactionClient
      ? work(transactionClient)
      : this.db.transaction(work);
  }

  async sourceStatus(): Promise<Array<Record<string, unknown>>> {
    const result = await this.db.pool.query(
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
    const result = await this.db.pool.query<{
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
    const result = await this.db.pool.query<{ external_event_id: string }>(
      "SELECT external_event_id FROM raw_events WHERE source_id=$1 AND external_event_id IS NOT NULL",
      [sourceId],
    );
    return result.rows.map((row) => row.external_event_id);
  }
}
