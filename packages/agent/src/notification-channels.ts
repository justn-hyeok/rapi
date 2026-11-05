import {
  canManageGuild,
  describeNotificationChannels,
  isGuildAllowed,
  isNotificationKind,
  isReviewKind,
  notificationKindLabel,
  type DeliveryAdapter,
  type DiscordIdentity,
  type PublicNotificationKind,
} from "@rapi/core";
import type { PostgresStore } from "@rapi/db";

const SNOWFLAKE = /^\d{1,20}$/;

export interface ReviewChannels {
  discount: string | undefined;
  newService: string | undefined;
  report: string | undefined;
  guildRequest: string | undefined;
  /** Buttons work in all of them, so a card sent before a move can still be decided. */
  ids: string[];
}

export interface NotificationChannels {
  review(): Promise<ReviewChannels>;
  /** Every allowed server's channel for this kind. Blocking a server stops its cards. */
  publicChannels(kind: PublicNotificationKind): Promise<string[]>;
  change(
    identity: DiscordIdentity,
    options: Record<string, unknown>,
  ): Promise<string>;
}

/**
 * Read on every use, so a change counts from the next card. The two environment
 * values keep working for the home server until it sets a channel of its own.
 */
export function createNotificationChannels(input: {
  store: Pick<
    PostgresStore,
    | "guildChannels"
    | "publicGuildChannels"
    | "setGuildChannel"
    | "clearGuildChannel"
  >;
  delivery: Pick<DeliveryAdapter, "send">;
  ownerIds: readonly string[];
  homeGuildId: string | undefined;
  allowedGuilds: () => Promise<readonly string[]>;
  reviewFallback: string | undefined;
  publicFallback: string | undefined;
}): NotificationChannels {
  const { store, homeGuildId, reviewFallback, publicFallback } = input;

  const saved = async (guildId: string) =>
    new Map(
      (await store.guildChannels(guildId)).map((row) => [
        row.kind,
        row.channelId,
      ]),
    );

  return {
    async review() {
      const home = homeGuildId ? await saved(homeGuildId) : new Map();
      const at = (kind: string): string | undefined =>
        home.get(kind) ?? reviewFallback;
      const review = {
        discount: at("review_discount"),
        newService: at("review_new_service"),
        report: at("review_report"),
        guildRequest: at("review_guild_request"),
      };
      return {
        ...review,
        ids: [
          ...new Set(
            [reviewFallback, ...Object.values(review)].filter(
              (id) => id !== undefined,
            ),
          ),
        ],
      };
    },

    async publicChannels(kind) {
      const allowed = await input.allowedGuilds();
      const rows = (await store.publicGuildChannels(kind)).filter((row) =>
        isGuildAllowed(row.guildId, allowed),
      );
      const homeHasOne = rows.some((row) => row.guildId === homeGuildId);
      return [
        ...new Set([
          ...(publicFallback && !homeHasOne ? [publicFallback] : []),
          ...rows.map((row) => row.channelId),
        ]),
      ];
    },

    async change(identity, options) {
      const { guildId, userId } = identity;
      if (!guildId) throw new Error("서버에서만 쓸 수 있는 명령입니다.");
      const owner = input.ownerIds.includes(userId);
      if (!owner && !canManageGuild(identity.guildPermissions))
        throw new Error("서버 관리 권한이 있어야 쓸 수 있는 명령입니다.");
      const home = guildId === homeGuildId;
      const showReview = owner && home;
      const action = options.action ?? "보기";
      if (action === "보기")
        return describeNotificationChannels(await saved(guildId), showReview);

      const kind = options.kind;
      if (!isNotificationKind(kind)) throw new Error("알 수 없는 알림입니다.");
      // A person in another server must not be able to read the owner's decisions.
      if (isReviewKind(kind) && !showReview)
        throw new Error("검토 알림은 소유자가 홈 서버에서만 정할 수 있습니다.");
      const label = notificationKindLabel(kind);

      if (action === "해제") {
        await store.clearGuildChannel(guildId, kind);
        return `${label} 채널을 해제했습니다.`;
      }
      if (action !== "설정") throw new Error("지원하지 않는 동작입니다.");
      const channelId = options.channel;
      if (typeof channelId !== "string" || !SNOWFLAKE.test(channelId))
        throw new Error("채널을 찾지 못했습니다.");

      // Sending is the only sure test that the bot can post there.
      const text = `이 채널로 ${label} 알림을 보냅니다.`;
      try {
        await input.delivery.send(
          { channel: "discord_channel", recipientId: channelId },
          {
            subject: text,
            text,
            html: "",
            itemIds: [],
            discord: { embeds: [], content: text },
          },
          `notification-channel:${guildId}:${kind}:${channelId}:${typeof options.requestId === "string" ? options.requestId : ""}`,
        );
      } catch {
        return `<#${channelId}>에 메시지를 보내지 못해 저장하지 않았습니다. 봇의 보기, 메시지 보내기, 링크 첨부 권한을 확인해 주세요.`;
      }
      await store.setGuildChannel(guildId, kind, channelId, userId);
      return `${label} 알림을 <#${channelId}>로 보냅니다.`;
    },
  };
}
