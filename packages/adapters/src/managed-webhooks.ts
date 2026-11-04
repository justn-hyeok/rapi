import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { splitDiscordMessage } from "@rapi/core";

function encryptionKey(value: string): Buffer {
  const key = Buffer.from(value, "base64");
  if (key.length !== 32)
    throw new Error(
      "WEBHOOK_ENCRYPTION_KEY must be 32 bytes encoded as base64",
    );
  return key;
}

export function encryptSecret(secret: string, encodedKey: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(encodedKey), iv);
  const ciphertext = Buffer.concat([
    cipher.update(secret, "utf8"),
    cipher.final(),
  ]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptSecret(value: string, encodedKey: string): string {
  const [version, ivValue, tagValue, ciphertextValue, extra] = value.split(".");
  if (version !== "v1" || !ivValue || !tagValue || !ciphertextValue || extra)
    throw new Error("Invalid encrypted secret");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(encodedKey),
    Buffer.from(ivValue, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextValue, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function parseDiscordWebhookUrl(value: string): {
  id: string;
  token: string;
} {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    !["discord.com", "discordapp.com"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Only official HTTPS Discord webhook URLs are allowed");
  const match = url.pathname.match(
    /^\/api(?:\/v\d+)?\/webhooks\/(\d{17,20})\/([A-Za-z0-9._-]{6,})\/?$/,
  );
  if (!match) throw new Error("Invalid Discord webhook URL");
  return { id: match[1]!, token: match[2]! };
}

export function webhookRetryDecision(
  status: number,
  body: Record<string, unknown>,
  attempt: number,
): { retry: boolean; delayMs: number } {
  if (status === 429) {
    const seconds = Number(body.retry_after);
    return {
      retry: true,
      delayMs: Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : 1000,
    };
  }
  if (status >= 500)
    return { retry: true, delayMs: Math.min(60_000, 1000 * 2 ** attempt) };
  return { retry: false, delayMs: 0 };
}

export class DiscordWebhookError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly delayMs: number,
  ) {
    super(message);
  }
}

type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export class DiscordWebhookClient {
  constructor(private readonly request: Fetch = fetch) {}

  async inspect(
    urlValue: string,
  ): Promise<{ id: string; channelId: string; guildId: string }> {
    const parsed = parseDiscordWebhookUrl(urlValue);
    const response = await this.request(urlValue, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) throw await this.error(response, 0);
    const body = (await response.json()) as Record<string, unknown>;
    if (
      String(body.id) !== parsed.id ||
      !/^\d{17,20}$/.test(String(body.channel_id)) ||
      !/^\d{17,20}$/.test(String(body.guild_id))
    )
      throw new Error("Discord webhook identity could not be verified");
    return {
      id: parsed.id,
      channelId: String(body.channel_id),
      guildId: String(body.guild_id),
    };
  }

  async send(
    urlValue: string,
    content: string,
    sentChunks = 0,
    progress?: (sentChunks: number) => Promise<void>,
    attempt = 0,
  ): Promise<void> {
    parseDiscordWebhookUrl(urlValue);
    const chunks = splitDiscordMessage(content);
    for (let index = sentChunks; index < chunks.length; index += 1) {
      const url = new URL(urlValue);
      url.searchParams.set("wait", "true");
      const response = await this.request(url, {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(3000),
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content: chunks[index],
          allowed_mentions: { parse: [] },
        }),
      });
      if (!response.ok) throw await this.error(response, attempt);
      await response.arrayBuffer();
      await progress?.(index + 1);
    }
  }

  private async error(
    response: Response,
    attempt: number,
  ): Promise<DiscordWebhookError> {
    let body: Record<string, unknown> = {};
    try {
      body = (await response.json()) as Record<string, unknown>;
    } catch {
      await response.arrayBuffer().catch(() => undefined);
    }
    const decision = webhookRetryDecision(response.status, body, attempt);
    return new DiscordWebhookError(
      `Discord webhook returned ${response.status}`,
      decision.retry,
      decision.delayMs,
    );
  }
}
