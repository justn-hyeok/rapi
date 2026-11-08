import { readFile } from "node:fs/promises";
import { type DiscordRest } from "@rapi/application";

export class DiscordRestClient implements DiscordRest {
  constructor(
    readonly token: string,
    readonly fetcher: typeof fetch = fetch,
  ) {}

  async request<T>(route: string, init: RequestInit = {}): Promise<T> {
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bot ${this.token}`);
      if (init.body) headers.set("content-type", "application/json");
      const response = await this.fetcher(
        `https://discord.com/api/v10${route}`,
        {
          ...init,
          headers,
          redirect: "manual",
          signal: AbortSignal.timeout(10_000),
        },
      );
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
}

/** What the layout manager reads: Discord as the bot, and the layout file. */
export function discordLayoutPorts(
  botToken: string,
  layoutFile: string,
): { rest: DiscordRest; readLayout: () => Promise<string> } {
  return {
    rest: new DiscordRestClient(botToken),
    readLayout: () => readFile(layoutFile, "utf8"),
  };
}
