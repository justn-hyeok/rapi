import type { RapiUpdateStore } from "@rapi/application";
import type { PostgresDatabase } from "./database.js";

/** Which Rapi release was announced. */
export class PostgresRapiUpdateStore implements RapiUpdateStore {
  constructor(private readonly db: PostgresDatabase) {}

  async rapiUpdateNoticed(): Promise<boolean> {
    const { rowCount } = await this.db.pool.query(
      "SELECT 1 FROM rapi_update_notices LIMIT 1",
    );
    return (rowCount ?? 0) > 0;
  }

  async claimRapiUpdate(tag: string): Promise<boolean> {
    const { rowCount } = await this.db.pool.query(
      "INSERT INTO rapi_update_notices(tag) VALUES($1) ON CONFLICT DO NOTHING",
      [tag],
    );
    return rowCount === 1;
  }
}
