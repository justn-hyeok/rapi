import type {
  DeliveryAdapter,
  DeliveryPayload,
  DeliveryResult,
  DeliveryTarget,
} from "@rapi/core";
import { splitDiscordMessage } from "@rapi/core";

export class UncertainDeliveryError extends Error {
  readonly possiblyDelivered = true;
}

export class PermanentDeliveryError extends Error {}

/** Nothing was sent; the caller should stop asking for a while. */
export class DiscordRateLimitError extends Error {}

/** A 5xx: usually nothing was posted, but Discord did not say so. */
export class DiscordServerError extends Error {}

export class DiscordDeliveryAdapter implements DeliveryAdapter {
  constructor(private readonly botToken: string) {}

  async send(
    target: DeliveryTarget,
    payload: DeliveryPayload,
  ): Promise<DeliveryResult> {
    let channelId = target.recipientId;
    if (target.channel === "discord_dm") {
      const dm = await this.request("/users/@me/channels", {
        recipient_id: target.recipientId,
      });
      channelId = String(dm.id);
    }
    let providerId = "";
    if (payload.discord) {
      const message = await this.request(`/channels/${channelId}/messages`, {
        ...payload.discord,
        allowed_mentions: { parse: [] },
      });
      return { providerId: String(message.id) };
    }
    for (const content of splitDiscordMessage(payload.text)) {
      try {
        const message = await this.request(`/channels/${channelId}/messages`, {
          content,
          allowed_mentions: { parse: [] },
        });
        providerId = String(message.id);
      } catch (error) {
        if (providerId && !(error instanceof UncertainDeliveryError))
          throw new UncertainDeliveryError(
            "Discord delivery was partially accepted",
            { cause: error },
          );
        throw error;
      }
    }
    return { providerId };
  }

  private async request(
    path: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetch(`https://discord.com/api/v10${path}`, {
        method: "POST",
        headers: {
          authorization: `Bot ${this.botToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      if (/^\/channels\/[^/]+\/messages$/.test(path))
        throw new UncertainDeliveryError(
          "Discord message delivery outcome is uncertain",
          { cause: error },
        );
      throw error;
    }
    if (response.status === 429)
      throw new DiscordRateLimitError("Discord returned 429");
    if (response.status >= 500)
      throw new DiscordServerError(`Discord returned ${response.status}`);
    if (!response.ok) throw new Error(`Discord returned ${response.status}`);
    try {
      const message = (await response.json()) as Record<string, unknown>;
      if (typeof message.id !== "string" || !message.id)
        throw new Error("Discord response has no message identity");
      return message;
    } catch (error) {
      if (/^\/channels\/[^/]+\/messages$/.test(path))
        throw new UncertainDeliveryError(
          "Discord delivery acknowledgement is uncertain",
          { cause: error },
        );
      throw error;
    }
  }
}
