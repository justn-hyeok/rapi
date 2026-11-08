import type { GuildStore } from "@rapi/application";
import type { PostgresDatabase } from "./database.js";

/** Servers: requests, features and alert channels. */
export class PostgresGuildStore implements GuildStore {
  constructor(private readonly db: PostgresDatabase) {}

  async allowedDiscordGuilds(): Promise<
    Array<{ guildId: string; allowedAt: Date | null }>
  > {
    const result = await this.db.pool.query<{
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
    const opened = await this.db.pool.query(
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
    const { rows } = await this.db.pool.query<{
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
    const result = await this.db.pool.query(
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
    await this.db.pool.query(
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
    const result = await this.db.pool.query(
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
    const { rows } = await this.db.pool.query<{
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
    const result = await this.db.pool.query(
      `UPDATE discord_guilds SET carded_at = now()
       WHERE guild_id = $1 AND carded_at IS NULL AND status = 'pending'`,
      [guildId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async releaseGuildCard(guildId: string): Promise<void> {
    await this.db.pool.query(
      `UPDATE discord_guilds SET carded_at = NULL WHERE guild_id = $1`,
      [guildId],
    );
  }

  async saveGuildCardMessage(
    guildId: string,
    messageId: string,
    name: string | null,
  ): Promise<void> {
    await this.db.pool.query(
      `UPDATE discord_guilds SET card_message_id = $2, name = COALESCE($3, name)
       WHERE guild_id = $1`,
      [guildId, messageId, name],
    );
  }

  async guildFeatureSettings(
    guildId: string,
  ): Promise<Array<{ feature: string; enabled: boolean }>> {
    const result = await this.db.pool.query<{
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
    await this.db.pool.query(
      `INSERT INTO discord_guild_features(guild_id,feature,enabled,updated_by) VALUES($1,$2,$3,$4)
       ON CONFLICT (guild_id,feature) DO UPDATE SET enabled=$3,updated_by=$4,updated_at=now()`,
      [guildId, feature, enabled, actorId],
    );
  }

  async guildChannels(
    guildId: string,
  ): Promise<Array<{ kind: string; channelId: string }>> {
    const result = await this.db.pool.query<{
      kind: string;
      channelId: string;
    }>(
      `SELECT kind, channel_id AS "channelId" FROM discord_guild_channels WHERE guild_id=$1`,
      [guildId],
    );
    return result.rows;
  }

  async publicGuildChannels(
    kind: string,
  ): Promise<Array<{ guildId: string; channelId: string }>> {
    const result = await this.db.pool.query<{
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
    await this.db.pool.query(
      `INSERT INTO discord_guild_channels(guild_id,kind,channel_id,updated_by) VALUES($1,$2,$3,$4)
       ON CONFLICT (guild_id,kind) DO UPDATE SET channel_id=$3,updated_by=$4,updated_at=now()`,
      [guildId, kind, channelId, actorId],
    );
  }

  async clearGuildChannel(guildId: string, kind: string): Promise<void> {
    await this.db.pool.query(
      "DELETE FROM discord_guild_channels WHERE guild_id=$1 AND kind=$2",
      [guildId, kind],
    );
  }
}
