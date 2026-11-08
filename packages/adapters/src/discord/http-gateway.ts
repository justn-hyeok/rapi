import {
  type DiscordGateway,
  DiscordRateLimitError,
  DiscordServerError,
  UncertainDeliveryError,
} from "@rapi/application";
import type {
  DeliveryPayload,
  DeliveryResult,
  DeliveryTarget,
} from "@rapi/domain";
import { splitDiscordMessage } from "@rapi/domain";

export class DiscordHttpGateway implements DiscordGateway {
  constructor(private readonly botToken: string) {}

  async request<T>(route: string, init: RequestInit = {}): Promise<T> {
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bot ${this.botToken}`);
      if (init.body) headers.set("content-type", "application/json");
      const response = await fetch(`https://discord.com/api/v10${route}`, {
        ...init,
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) {
        if (response.status === 204) return undefined as T;
        return (await response.json()) as T;
      }
      const error = (await response.json().catch(() => ({}))) as {
        message?: string;
        retry_after?: number;
      };
      if (response.status === 429 && attempt < 4) {
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            Math.min(30_000, Math.max(1_000, (error.retry_after ?? 1) * 1_000)),
          ),
        );
        continue;
      }
      throw new Error(
        `Discord API ${response.status}${error.message ? `: ${error.message}` : ""}`,
      );
    }
    throw new Error("Discord API retry budget exhausted");
  }

  async send(
    target: DeliveryTarget,
    payload: DeliveryPayload,
  ): Promise<DeliveryResult> {
    let channelId = target.recipientId;
    if (target.channel === "discord_dm") {
      const dm = await this.post("/users/@me/channels", {
        recipient_id: target.recipientId,
      });
      channelId = String(dm.id);
    }
    let providerId = "";
    if (payload.discord) {
      const message = await this.post(`/channels/${channelId}/messages`, {
        ...payload.discord,
        allowed_mentions: { parse: [] },
      });
      return { providerId: String(message.id) };
    }
    for (const content of splitDiscordMessage(payload.text)) {
      try {
        const message = await this.post(`/channels/${channelId}/messages`, {
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

  private async post(
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
