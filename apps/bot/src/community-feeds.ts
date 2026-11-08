import { readFile } from "node:fs/promises";
import { readSource } from "@rapi/adapters";
import {
  CommunityFeeds,
  CURATION_CHANNELS,
  feedGuildTargets,
  messageBody,
  MODEL_CATALOG_URL,
  type CommunityFeedStore,
  type GuildFeatureSwitch,
} from "@rapi/agent";
import type { ItemSummarizer } from "@rapi/core";

/** Builds the feeds from config/curation in a release root, posting as the bot. */
export async function createCommunityFeeds(input: {
  store: CommunityFeedStore;
  summarizer: ItemSummarizer | undefined;
  guildId: string;
  extraGuildIds?: readonly string[];
  guildFeatures: Pick<GuildFeatureSwitch, "enabled">;
  botToken: string;
  root: string;
}): Promise<CommunityFeeds> {
  let config: {
    autoPost?: Partial<Record<keyof typeof CURATION_CHANNELS, boolean>>;
  } = {};
  try {
    config = JSON.parse(
      await readFile(`${input.root}/config/curation/feeds.json`, "utf8"),
    ) as typeof config;
  } catch {
    // Without a config no card goes out.
  }
  return new CommunityFeeds(input.store, input.summarizer, {
    guildId: input.guildId,
    guildTargets: () => feedGuildTargets(input),
    getText: async (url, accept = "application/json") =>
      (
        await readSource(
          url,
          { "User-Agent": "rapi", Accept: accept },
          url === MODEL_CATALOG_URL
            ? { timeoutMs: 60_000, maxBodyBytes: 16_000_000 }
            : { timeoutMs: 20_000, maxBodyBytes: 4_000_000 },
        )
      ).body,
    ...(config.autoPost ? { autoPost: config.autoPost } : {}),
    post: async (channelId, embeds) => {
      const response = await fetch(
        `https://discord.com/api/v10/channels/${channelId}/messages`,
        {
          method: "POST",
          headers: {
            authorization: `Bot ${input.botToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(messageBody(embeds)),
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (!response.ok) throw new Error(`Discord returned ${response.status}`);
      const message = (await response.json()) as { id?: unknown };
      return typeof message.id === "string" ? message.id : "";
    },
    pin: async (channelId, messageId) => {
      const response = await fetch(
        `https://discord.com/api/v10/channels/${channelId}/messages/pins/${messageId}`,
        {
          method: "PUT",
          headers: { authorization: `Bot ${input.botToken}` },
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (!response.ok) throw new Error(`Discord returned ${response.status}`);
    },
  });
}
