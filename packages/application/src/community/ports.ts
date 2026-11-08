import type { DiscordLayoutStore } from "../discord/ports.js";
import type { GuildStore } from "../guilds/ports.js";
export interface CommunityStore {
  communityGuildPostSent(guildId: string, key: string): Promise<boolean>;
  recordCommunityGuildPost(input: {
    guildId: string;
    key: string;
    channelId: string;
    messageId: string | null;
  }): Promise<void>;
  communityPostExists(key: string): Promise<boolean>;
  recordCommunityPost(input: {
    key: string;
    feed: string;
    channelId: string | null;
    messageId: string | null;
    data: Record<string, unknown>;
    state?: "posted" | "marker";
  }): Promise<void>;
  saveCommunityDraft(input: {
    key: string;
    feed: string;
    title: string;
    embeds: unknown[];
  }): Promise<void>;
  communityCardQueue(
    feed: string,
    prefix: string,
    limit: number,
  ): Promise<string[]>;
  communityDraft(key: string): Promise<{
    key: string;
    feed: string;
    embeds: unknown[];
    created: Date;
  } | null>;
  settleCommunityDraft(
    key: string,
    state: "posted",
    channelId?: string | null,
    messageId?: string | null,
  ): Promise<boolean>;
  lastCommunityPostAt(feed: string, prefix: string): Promise<Date | null>;
  deleteCommunityMarkers(keys: string[]): Promise<void>;
  communityPostKeys(prefix: string): Promise<string[]>;
  officialItems(since: Date): Promise<
    {
      id: string;
      url: string;
      title: string;
      summary: string;
      source: string;
      aiOnly: boolean;
    }[]
  >;
  citationCandidates(
    since: Date,
    includeOfficial?: boolean,
  ): Promise<
    { id: string; url: string; title: string; body: string; source: string }[]
  >;
}

/** The feeds post to every allowed server that has their channel. */
export type CommunityFeedStore = CommunityStore &
  Pick<GuildStore, "allowedDiscordGuilds"> &
  Pick<DiscordLayoutStore, "managedDiscordResourceId">;
