export interface ManagedDiscordResourceRecord {
  guildId: string;
  resourceType: "role" | "category" | "channel" | "message" | "webhook";
  key: string;
  discordId: string;
  layoutDigest: string;
}

export interface DiscordLayoutPlanRecord {
  id: string;
  guildId: string;
  createdBy: string;
  layoutDigest: string;
  snapshotDigest: string;
  payload: Record<string, unknown>;
  expiresAt: Date;
  appliedAt: Date | null;
}

export interface DiscordLayoutStore {
  managedDiscordResourceId(
    guildId: string,
    resourceType: "role" | "category" | "channel" | "message" | "webhook",
    key: string,
  ): Promise<string | null>;
  listManagedDiscordResources(
    guildId: string,
  ): Promise<ManagedDiscordResourceRecord[]>;
  upsertManagedDiscordResource(input: {
    guildId: string;
    resourceType: "role" | "category" | "channel" | "message" | "webhook";
    key: string;
    discordId: string;
    layoutDigest: string;
  }): Promise<void>;
  removeManagedDiscordResource(
    guildId: string,
    resourceType: "role" | "category" | "channel" | "message" | "webhook",
    discordId: string,
  ): Promise<void>;
  createDiscordLayoutPlan(input: {
    guildId: string;
    createdBy: string;
    layoutDigest: string;
    snapshotDigest: string;
    payload: Record<string, unknown>;
    expiresAt: Date;
  }): Promise<string>;
  discordLayoutPlan(
    guildId: string,
    id: string,
  ): Promise<DiscordLayoutPlanRecord | null>;
  markDiscordLayoutPlanApplied(guildId: string, id: string): Promise<boolean>;
  claimDiscordLayoutPlan(guildId: string, id: string): Promise<boolean>;
  releaseDiscordLayoutPlanClaim(guildId: string, id: string): Promise<void>;
}
