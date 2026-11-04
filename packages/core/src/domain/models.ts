export type Visibility = "private" | "unlisted" | "public";

export interface SourceRecord {
  id: string;
  kind: "github" | "rss" | "html" | "webhook" | "aside" | "github_stars";
  locator: string;
  visibility: Visibility;
}

export interface RawInput {
  externalId: string | null;
  payload: unknown;
  collectedAt: Date;
}

export interface NormalizedItem {
  id: string;
  rawEventId: string;
  sourceId: string;
  normalizerVersion: string;
  canonicalUrl: string;
  title: string;
  body: string;
  author: string | null;
  publishedAt: Date | null;
  collectedAt: Date;
  visibility: Visibility;
  contentFingerprint: string;
  metadata: Record<string, unknown>;
  categories: string[];
}

export interface DeliveryTarget {
  channel: "discord_dm" | "discord_channel";
  recipientId: string;
}

export interface DeliveryPayload {
  subject: string;
  text: string;
  html: string;
  itemIds: string[];
  /** A Discord message (embeds and link buttons) replacing the text split. */
  discord?: {
    embeds: unknown[];
    components?: unknown[];
    content?: string;
    flags?: number;
  };
}

export interface DeliveryResult {
  providerId: string;
}

export interface DeliveryAdapter {
  send(
    target: DeliveryTarget,
    payload: DeliveryPayload,
    idempotencyKey: string,
  ): Promise<DeliveryResult>;
}
