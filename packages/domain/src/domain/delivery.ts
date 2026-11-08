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
