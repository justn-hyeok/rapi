import type {
  DeliveryPayload,
  DeliveryResult,
  DeliveryTarget,
} from "@rapi/domain";

/** Discord, as the bot: messages, and its REST API for everything else. */
export interface DiscordGateway {
  request<T>(route: string, init?: RequestInit): Promise<T>;
  send(
    target: DeliveryTarget,
    payload: DeliveryPayload,
    idempotencyKey: string,
  ): Promise<DeliveryResult>;
}

export class UncertainDeliveryError extends Error {
  readonly possiblyDelivered = true;
}

export class PermanentDeliveryError extends Error {}

/** Nothing was sent; the caller should stop asking for a while. */
export class DiscordRateLimitError extends Error {}

/** A 5xx: usually nothing was posted, but Discord did not say so. */
export class DiscordServerError extends Error {}

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
