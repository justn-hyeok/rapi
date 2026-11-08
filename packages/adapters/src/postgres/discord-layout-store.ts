import { randomUUID } from "node:crypto";
import {
  type DiscordLayoutPlanRecord,
  type ManagedDiscordResourceRecord,
} from "@rapi/application";
import type { DiscordLayoutStore } from "@rapi/application";
import type { PostgresDatabase } from "./database.js";

/** The Discord resources Rapi manages and its layout plans. */
export class PostgresDiscordLayoutStore implements DiscordLayoutStore {
  constructor(private readonly db: PostgresDatabase) {}

  async managedDiscordResourceId(
    guildId: string,
    resourceType: "role" | "category" | "channel" | "message" | "webhook",
    key: string,
  ): Promise<string | null> {
    const result = await this.db.pool.query<{ discord_id: string }>(
      `SELECT discord_id FROM discord_managed_resources
       WHERE guild_id=$1 AND resource_type=$2 AND resource_key=$3`,
      [guildId, resourceType, key],
    );
    return result.rows[0]?.discord_id ?? null;
  }

  async listManagedDiscordResources(
    guildId: string,
  ): Promise<ManagedDiscordResourceRecord[]> {
    const result = await this.db.pool.query<{
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
    await this.db.pool.query(
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
    await this.db.pool.query(
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
    await this.db.pool.query(
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
    const result = await this.db.pool.query<{
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
    const result = await this.db.pool.query(
      `UPDATE discord_layout_plans SET applied_at=now()
       WHERE guild_id=$1 AND id=$2 AND applied_at IS NULL AND expires_at>now()`,
      [guildId, id],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async claimDiscordLayoutPlan(guildId: string, id: string): Promise<boolean> {
    const result = await this.db.pool.query(
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
    await this.db.pool.query(
      `UPDATE discord_layout_plans SET apply_started_at=NULL
       WHERE guild_id=$1 AND id=$2 AND applied_at IS NULL`,
      [guildId, id],
    );
  }
}
