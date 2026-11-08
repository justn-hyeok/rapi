export interface GuildStore {
  allowedDiscordGuilds(): Promise<
    { guildId: string; allowedAt: Date | null }[]
  >;
  openGuildRequest(
    input: { guildId: string; requesterId: string; reason: string | null },
    waitDays: number,
  ): Promise<{
    status: "opened" | "pending" | "allowed" | "blocked" | "waiting";
    retryAt: Date | null;
  }>;
  decideGuildRequest(
    guildId: string,
    status: "allowed" | "blocked",
    decidedBy: string,
  ): Promise<boolean>;
  setGuildStatus(
    guildId: string,
    status: "allowed" | "blocked",
    decidedBy: string,
  ): Promise<void>;
  liftGuildBlock(guildId: string, decidedBy: string): Promise<boolean>;
  guildRequestsForCards(limit: number): Promise<
    {
      guildId: string;
      name: string | null;
      requesterId: string | null;
      reason: string | null;
    }[]
  >;
  claimGuildCard(guildId: string): Promise<boolean>;
  releaseGuildCard(guildId: string): Promise<void>;
  saveGuildCardMessage(
    guildId: string,
    messageId: string,
    name: string | null,
  ): Promise<void>;
  guildFeatureSettings(
    guildId: string,
  ): Promise<{ feature: string; enabled: boolean }[]>;
  setGuildFeature(
    guildId: string,
    feature: string,
    enabled: boolean,
    actorId: string,
  ): Promise<void>;
  guildChannels(
    guildId: string,
  ): Promise<{ kind: string; channelId: string }[]>;
  publicGuildChannels(
    kind: string,
  ): Promise<{ guildId: string; channelId: string }[]>;
  setGuildChannel(
    guildId: string,
    kind: string,
    channelId: string,
    actorId: string,
  ): Promise<void>;
  clearGuildChannel(guildId: string, kind: string): Promise<void>;
}

export interface RapiUpdateStore {
  rapiUpdateNoticed(): Promise<boolean>;
  claimRapiUpdate(tag: string): Promise<boolean>;
}
