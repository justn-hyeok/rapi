import { type DiscordGateway } from "../discord/ports.js";
import { type DiscountCandidateStore } from "../discounts/ports.js";
import { type GuildStore } from "./ports.js";
import {
  canManageGuild,
  cleanGuildText,
  discordEmbed,
  GUILD_NAME_MAX_CHARS,
  GUILD_REQUEST_REASON_MAX_CHARS,
  GUILD_REQUEST_WAIT_DAYS,
  guildRequestCard,
  isGuildAllowed,
  type DeliveryPayload,
  type DiscordIdentity,
  type GuildRequestForCard,
} from "@rapi/domain";
import { messageBody } from "../community/feeds.js";
import type { DiscountPublishResult } from "../discounts/approval.js";
import {
  CARDS_PER_HOUR,
  isReviewChannel,
  sendClaimedCards,
} from "../discounts/candidates.js";

export const GUILD_APPROVE_PREFIX = "guild_approve:";
export const GUILD_BLOCK_PREFIX = "guild_block:";

export interface GuildRequests {
  store: Pick<
    GuildStore,
    | "openGuildRequest"
    | "decideGuildRequest"
    | "setGuildStatus"
    | "liftGuildBlock"
  >;
  gate: { allowed(): Promise<readonly string[]>; invalidate(): void };
  ownerIds: readonly string[];
  reviewChannelId: () => Promise<string | undefined>;
  reviewChannelIds: () => Promise<readonly string[]>;
  configuredGuildIds: readonly string[];
  commands: {
    register(guildId: string): Promise<void>;
    clear(guildId: string): Promise<void>;
  };
  onOpened?: () => void;
}

const TRY_AGAIN = "처리하지 못했습니다. 잠시 뒤 다시 시도해 주세요.";
const SNOWFLAKE = /^\d{1,20}$/;
const APPROVED =
  "승인했습니다. 기본 기능만 켜져 있고, 그 서버에서 /기능으로 바꿀 수 있습니다.";
const APPROVED_NO_COMMANDS =
  "승인했지만 명령을 등록하지 못했습니다. 봇을 applications.commands 권한으로 다시 초대한 뒤 /서버 승인을 다시 실행해 주세요.";
const BLOCKED =
  "차단했습니다. 이 서버의 요청은 모두 거절합니다. 되돌리려면 /서버 승인이나 /서버 해제를 쓰세요.";

const logFailure = (error: unknown) =>
  process.stderr.write(
    `guild requests: ${error instanceof Error ? error.message.slice(0, 200) : "failed"}\n`,
  );

/**
 * What /서버신청 answers, inside Discord's window: the card goes out on its own run.
 * The reply repeats nothing the requester typed. Never throws.
 */
export async function receiveGuildRequest(
  input: GuildRequests,
  identity: DiscordIdentity,
  reason: string | undefined,
): Promise<string> {
  if (!identity.guildId) return "서버에서만 요청할 수 있습니다.";
  if (!canManageGuild(identity.guildPermissions))
    return "서버 관리 권한이 있는 분만 요청할 수 있습니다.";
  try {
    if (isGuildAllowed(identity.guildId, await input.gate.allowed()))
      return "이미 승인된 서버입니다.";
    const { status, retryAt } = await input.store.openGuildRequest(
      {
        guildId: identity.guildId,
        requesterId: identity.userId,
        reason: cleanGuildText(reason, GUILD_REQUEST_REASON_MAX_CHARS),
      },
      GUILD_REQUEST_WAIT_DAYS,
    );
    switch (status) {
      case "opened":
        input.onOpened?.();
        return (await input.reviewChannelId())
          ? "승인 요청을 보냈습니다. 라피 운영자가 확인하면 이 서버에서 쓸 수 있어요."
          : "승인 요청을 저장했습니다. 아직 라피 운영자에게 전달되지 않았습니다.";
      case "pending":
        return "이미 승인 요청을 보냈습니다. 라피 운영자의 결정을 기다려 주세요.";
      case "allowed":
        return "이미 승인된 서버입니다.";
      case "blocked":
        return "이 서버는 라피 운영자가 차단해서 요청을 받지 않습니다.";
      case "waiting":
        return retryAt
          ? `지금은 다시 요청할 수 없습니다. <t:${Math.ceil(retryAt.getTime() / 1000)}:D> 이후에 요청해 주세요.`
          : `지금은 다시 요청할 수 없습니다. ${GUILD_REQUEST_WAIT_DAYS}일 뒤에 요청해 주세요.`;
    }
  } catch (error) {
    logFailure(error);
    return TRY_AGAIN;
  }
}

/** The row is already approved, so a failed registration leaves it approved and says so. */
async function registerApproved(
  input: GuildRequests,
  guildId: string,
): Promise<string> {
  input.gate.invalidate();
  try {
    await input.commands.register(guildId);
    return APPROVED;
  } catch (error) {
    logFailure(error);
    return APPROVED_NO_COMMANDS;
  }
}

/**
 * The owner pressed [승인] or [차단]. Who and where come from the signed request, on
 * every click, and only an open request changes, so a second click changes nothing.
 * Blocking a request needs no cleanup: an unapproved guild has no guild commands.
 */
export async function guildRequestButton(
  input: GuildRequests,
  identity: DiscordIdentity,
  customId: string,
): Promise<DiscountPublishResult> {
  if (!input.ownerIds.includes(identity.userId))
    return { notice: "소유자만 쓸 수 있는 버튼입니다." };
  try {
    if (!(await isReviewChannel(input.reviewChannelIds, identity.channelId)))
      return { notice: "검토 채널에서만 쓸 수 있는 버튼입니다." };
  } catch (error) {
    logFailure(error);
    return { notice: TRY_AGAIN };
  }
  const guildId = customId.slice(customId.indexOf(":") + 1);
  if (!SNOWFLAKE.test(guildId)) return { notice: "요청을 찾지 못했습니다." };
  const approve = customId.startsWith(GUILD_APPROVE_PREFIX);
  try {
    const decided = await input.store.decideGuildRequest(
      guildId,
      approve ? "allowed" : "blocked",
      identity.userId,
    );
    if (!decided) return { notice: "이미 처리한 요청입니다." };
  } catch (error) {
    logFailure(error);
    return { notice: TRY_AGAIN };
  }
  const content = approve
    ? await registerApproved(input, guildId)
    : (input.gate.invalidate(), BLOCKED);
  return { edit: { content, components: [] } };
}

/** /서버 승인, 차단, 해제. Answers the owner in every case. */
export async function changeGuild(
  input: GuildRequests,
  actorId: string,
  action: string,
  target: string,
): Promise<string> {
  const guildId = target.trim();
  if (!SNOWFLAKE.test(guildId)) return "서버 ID는 숫자여야 합니다.";
  if (action !== "승인" && input.configuredGuildIds.includes(guildId))
    return "설정 파일로 허용한 서버입니다. .env의 DISCORD_ALLOWED_GUILD_IDS나 홈 서버 설정을 바꿔야 합니다.";
  try {
    if (action === "승인") {
      await input.store.setGuildStatus(guildId, "allowed", actorId);
      return await registerApproved(input, guildId);
    }
    if (action === "차단") {
      await input.store.setGuildStatus(guildId, "blocked", actorId);
      input.gate.invalidate();
      try {
        await input.commands.clear(guildId);
        return BLOCKED;
      } catch (error) {
        logFailure(error);
        return `${BLOCKED} 명령은 지우지 못했지만 눌러도 거절만 합니다.`;
      }
    }
    if (action === "해제") {
      if (!(await input.store.liftGuildBlock(guildId, actorId)))
        return "차단된 서버가 아닙니다.";
      return `차단을 풀었습니다. 승인된 것은 아니며, ${GUILD_REQUEST_WAIT_DAYS}일 뒤부터 다시 요청할 수 있습니다. 바로 쓰게 하려면 /서버 승인을 쓰세요.`;
    }
    return "지원하지 않는 동작입니다.";
  } catch (error) {
    logFailure(error);
    return TRY_AGAIN;
  }
}

// Only the guild id travels in a custom_id; the click is checked when it arrives.
function guildCardPayload(request: GuildRequestForCard): DeliveryPayload {
  const title = "새 서버 승인 요청";
  return {
    subject: title,
    text: title,
    html: "",
    itemIds: [],
    discord: {
      ...messageBody([discordEmbed(guildRequestCard(request))]),
      components: [
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 3,
              label: "승인",
              custom_id: `${GUILD_APPROVE_PREFIX}${request.guildId}`,
            },
            {
              type: 2,
              style: 4,
              label: "차단",
              custom_id: `${GUILD_BLOCK_PREFIX}${request.guildId}`,
            },
          ],
        },
      ],
    },
  };
}

/**
 * Open requests, within the channel's hourly limit: anyone can add the bot to a new
 * server, so many of them cannot flood the owner. The rest wait for a later run.
 */
export async function sendGuildRequestCards(input: {
  store: Pick<DiscountCandidateStore, "cardsInLastHour"> &
    Pick<
      GuildStore,
      | "guildRequestsForCards"
      | "claimGuildCard"
      | "releaseGuildCard"
      | "saveGuildCardMessage"
    >;
  delivery: Pick<DiscordGateway, "send">;
  channelId: string;
  guildName: (guildId: string) => Promise<string | null>;
}): Promise<string[]> {
  const { store, delivery, channelId } = input;
  let budget: number;
  let rows: Array<GuildRequestForCard & { id: string }>;
  try {
    budget = CARDS_PER_HOUR - (await store.cardsInLastHour());
    if (budget <= 0) return [];
    const requests = await store.guildRequestsForCards(budget);
    rows = await Promise.all(
      requests.map(async (request) => ({
        ...request,
        id: request.guildId,
        name:
          cleanGuildText(
            (await input.guildName(request.guildId)) ?? undefined,
            GUILD_NAME_MAX_CHARS,
          ) ?? request.name,
      })),
    );
  } catch (error) {
    return [
      `guild cards: ${error instanceof Error ? error.message : "failed"}`,
    ];
  }
  const names = new Map(rows.map((row) => [row.id, row.name]));
  return sendClaimedCards({
    rows,
    budget,
    delivery,
    channelFor: () => channelId,
    claim: (id) => store.claimGuildCard(id),
    release: (id) => store.releaseGuildCard(id),
    saveMessage: (id, messageId) =>
      store.saveGuildCardMessage(id, messageId, names.get(id) ?? null),
    payload: guildCardPayload,
    deliveryKey: "guild-card",
  });
}
