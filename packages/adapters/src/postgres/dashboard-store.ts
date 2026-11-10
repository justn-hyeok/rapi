import type {
  DashboardNumbers,
  DashboardSource,
  DashboardGuild,
  DashboardModelRow,
} from "@rapi/domain";
import type { DashboardStore } from "@rapi/application";
import type { PostgresDatabase } from "./database.js";

const iso = (value: unknown): string | null =>
  value instanceof Date ? value.toISOString() : null;

/** Read-only numbers for /대시보드 and its page. One query per section. */
export class PostgresDashboardStore implements DashboardStore {
  constructor(private readonly db: Pick<PostgresDatabase, "pool">) {}

  async dashboardNumbers(now: Date): Promise<DashboardNumbers> {
    const [sources, candidates, models, guilds, stars, connections] =
      await Promise.all([
        this.db.pool.query<{
          kind: string;
          locator: string;
          state: string;
          last_success_at: Date | null;
          last_error: string | null;
          failure_count: string;
        }>(
          `SELECT s.kind,s.locator,s.state,c.last_success_at,c.last_error,
                  COALESCE(c.failure_count,0) AS failure_count
             FROM sources s
             LEFT JOIN source_cursors c ON c.source_id=s.id
             ORDER BY s.created_at`,
        ),
        this.db.pool.query<Record<string, string>>(
          `SELECT count(*) FILTER (WHERE first_seen_at >= $1::timestamptz - interval '7 days') AS found7d,
                  count(*) FILTER (WHERE carded_at >= $1::timestamptz - interval '7 days') AS carded7d,
                  count(*) FILTER (WHERE status='new' AND card_message_id IS NOT NULL) AS waiting,
                  count(*) FILTER (WHERE status='published') AS published,
                  count(*) FILTER (WHERE status='discarded') AS discarded
             FROM discount_candidates`,
          [now],
        ),
        this.db.pool.query<Record<string, string>>(
          `SELECT feature, model,
                  count(*) AS calls,
                  count(*) FILTER (WHERE NOT ok) AS failures,
                  COALESCE(sum(input_tokens),0) AS input_tokens,
                  COALESCE(sum(output_tokens),0) AS output_tokens,
                  COALESCE(sum(cost_micro_usd),0) AS cost_micro_usd,
                  count(*) FILTER (WHERE note='unknown_price') AS unpriced
             FROM model_usage
             WHERE at >= date_trunc('month', $1::timestamptz)
             GROUP BY feature, model
             ORDER BY feature, model`,
          [now],
        ),
        this.db.pool.query<{ name: string | null; status: string }>(
          "SELECT name,status FROM discord_guilds ORDER BY status,name",
        ),
        this.db.pool.query<{ active: string; paused: string }>(
          `SELECT count(*) FILTER (WHERE paused_at IS NULL) AS active,
                  count(*) FILTER (WHERE paused_at IS NOT NULL) AS paused
             FROM star_subscribers`,
        ),
        this.db.pool.query<{ count: string }>(
          "SELECT count(*) FROM user_connections",
        ),
      ]);
    const candidateRow = candidates.rows[0] ?? {};
    const starRow = stars.rows[0] ?? { active: "0", paused: "0" };
    return {
      sources: sources.rows.map(
        (row): DashboardSource => ({
          kind: row.kind,
          locator: row.locator,
          state: row.state,
          lastSuccessAt: iso(row.last_success_at),
          lastError: row.last_error,
          failureCount: Number(row.failure_count),
        }),
      ),
      candidates: {
        found7d: Number(candidateRow.found7d ?? 0),
        carded7d: Number(candidateRow.carded7d ?? 0),
        waiting: Number(candidateRow.waiting ?? 0),
        published: Number(candidateRow.published ?? 0),
        discarded: Number(candidateRow.discarded ?? 0),
      },
      models: models.rows.map(
        (row): DashboardModelRow => ({
          feature: String(row.feature),
          model: String(row.model),
          calls: Number(row.calls),
          failures: Number(row.failures),
          inputTokens: Number(row.input_tokens),
          outputTokens: Number(row.output_tokens),
          costMicroUsd: Number(row.cost_micro_usd),
          unpriced: Number(row.unpriced),
        }),
      ),
      guilds: guilds.rows.map(
        (row): DashboardGuild => ({ name: row.name, status: row.status }),
      ),
      starsActive: Number(starRow.active),
      starsPaused: Number(starRow.paused),
      connections: Number(connections.rows[0]?.count ?? 0),
    };
  }
}
