import { Pool, type PoolClient } from "pg";

/** The connection pool and transactions every Postgres store shares. */
export class PostgresDatabase {
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
}
