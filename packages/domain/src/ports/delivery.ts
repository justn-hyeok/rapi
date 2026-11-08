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

export class UncertainDeliveryError extends Error {
  readonly possiblyDelivered = true;
}

export class PermanentDeliveryError extends Error {}

/** Nothing was sent; the caller should stop asking for a while. */
export class DiscordRateLimitError extends Error {}

/** A 5xx: usually nothing was posted, but Discord did not say so. */
export class DiscordServerError extends Error {}
