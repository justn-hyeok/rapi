import type {
  ConnectionProviderId,
  ConnectionStore,
  UserConnection,
} from "@rapi/core";
import type { PostgresStore } from "./postgres-store.js";

const COLUMNS = `user_id AS "userId", provider, account_id AS "accountId",
  account_name AS "accountName", token_sealed AS "sealedToken", scopes,
  connected_at AS "connectedAt"`;

/** user_connections: the accounts people connected, one per service. */
export class PostgresConnectionStore implements ConnectionStore {
  constructor(private readonly db: Pick<PostgresStore, "pool">) {}

  async connection(
    userId: string,
    provider: ConnectionProviderId,
  ): Promise<UserConnection | null> {
    const { rows } = await this.db.pool.query<UserConnection>(
      `SELECT ${COLUMNS} FROM user_connections WHERE user_id = $1 AND provider = $2`,
      [userId, provider],
    );
    return rows[0] ?? null;
  }

  async connections(userId: string): Promise<UserConnection[]> {
    const { rows } = await this.db.pool.query<UserConnection>(
      `SELECT ${COLUMNS} FROM user_connections WHERE user_id = $1 ORDER BY provider`,
      [userId],
    );
    return rows;
  }

  async saveConnection(
    connection: Omit<UserConnection, "connectedAt">,
  ): Promise<void> {
    await this.db.pool.query(
      `INSERT INTO user_connections (user_id, provider, account_id, account_name, token_sealed, scopes)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, provider) DO UPDATE SET account_id = EXCLUDED.account_id,
         account_name = EXCLUDED.account_name, token_sealed = EXCLUDED.token_sealed,
         scopes = EXCLUDED.scopes, connected_at = now()`,
      [
        connection.userId,
        connection.provider,
        connection.accountId,
        connection.accountName,
        connection.sealedToken,
        connection.scopes,
      ],
    );
  }

  async removeConnection(
    userId: string,
    provider: ConnectionProviderId,
  ): Promise<boolean> {
    const removed = await this.db.pool.query(
      "DELETE FROM user_connections WHERE user_id = $1 AND provider = $2",
      [userId, provider],
    );
    return removed.rowCount === 1;
  }
}
