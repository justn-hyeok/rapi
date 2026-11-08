import {
  deadlineLine,
  DEADLINE_MAX_CHARS,
  findDeadline,
  shouldCardCandidate,
  type CandidateForDecision,
  type DeliveryAdapter,
  type DiscordIdentity,
  type PublicAlertKind,
  DiscordServerError,
  UncertainDeliveryError,
} from "@rapi/domain";
import {
  CARDS_PER_HOUR,
  cardPayloadFor,
  DISCOUNT_DISCARD_PREFIX,
  isReviewChannel,
} from "./discount-candidates.js";
import type { DiscountCandidateStore } from "@rapi/domain";

export const DISCOUNT_MODAL_PREFIX = "discount_publish_modal:";
export const DISCOUNT_DEADLINE_INPUT = "deadline";

export interface DiscountApproval {
  store: Pick<
    DiscountCandidateStore,
    | "candidateForDecision"
    | "publicationRetryAt"
    | "claimCandidatePublication"
    | "releaseCandidatePublication"
    | "saveCandidatePublicMessage"
    | "discardCandidate"
  >;
  delivery: Pick<DeliveryAdapter, "send">;
  ownerIds: readonly string[];
  reviewChannelIds: () => Promise<readonly string[]>;
  publicChannelIds: (kind: PublicAlertKind) => Promise<readonly string[]>;
}

/** What to do after a modal was acknowledged: edit the card, tell the owner, or both. */
export interface DiscountPublishResult {
  edit?: { content: string; components: unknown[] };
  notice?: string;
}

const ALREADY_DECIDED = "이미 처리한 후보입니다.";
const TRY_AGAIN = "처리하지 못했습니다. 잠시 뒤 다시 눌러 주세요.";
const NOT_PUBLISHABLE =
  "게시할 수 없는 후보입니다. 빨강이거나 카드 기준에 맞지 않습니다.";
const NO_CHANNEL =
  "검토 채널이나 공개 채널이 설정되지 않아 처리할 수 없습니다.";
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

const ephemeral = (content: string) => ({
  type: 4,
  data: { content, flags: 64, allowed_mentions: { parse: [] } },
});

const logFailure = (error: unknown) =>
  process.stderr.write(
    `discount approval: ${error instanceof Error ? error.message.slice(0, 200) : "failed"}\n`,
  );

const overLimit = (retryAt: Date) =>
  `공개 채널에는 시간당 ${CARDS_PER_HOUR}장까지만 보냅니다. <t:${Math.ceil(retryAt.getTime() / 1000)}:t> 이후에 다시 눌러 주세요. 후보는 그대로입니다.`;

// Only the row id travels in a custom_id. All the rest is read here, on every click.
async function decidable(
  input: DiscountApproval,
  identity: DiscordIdentity,
  customId: string,
): Promise<CandidateForDecision | string> {
  if (!input.ownerIds.includes(identity.userId))
    return "소유자만 쓸 수 있는 버튼입니다.";
  if (!(await input.reviewChannelIds()).length) return NO_CHANNEL;
  if (!(await isReviewChannel(input.reviewChannelIds, identity.channelId)))
    return "검토 채널에서만 쓸 수 있는 버튼입니다.";
  const id = customId.slice(customId.indexOf(":") + 1);
  const candidate = UUID.test(id)
    ? await input.store.candidateForDecision(id)
    : null;
  if (!candidate) return "후보를 찾지 못했습니다.";
  if (!(await input.publicChannelIds(candidate.kind)).length) return NO_CHANNEL;
  return candidate.status === "new" ? candidate : ALREADY_DECIDED;
}

// The card keeps its link; only the decision buttons go.
const linkRow = (candidate: CandidateForDecision) =>
  cardPayloadFor(candidate).discord?.components ?? [];

/** The response to [게시] or [버리기]. Never throws: the owner always gets an answer. */
export async function discountCardButton(
  input: DiscountApproval,
  identity: DiscordIdentity,
  customId: string,
): Promise<unknown> {
  try {
    const candidate = await decidable(input, identity, customId);
    if (typeof candidate === "string") return ephemeral(candidate);
    if (customId.startsWith(DISCOUNT_DISCARD_PREFIX)) {
      if (!(await input.store.discardCandidate(candidate.id)))
        return ephemeral(ALREADY_DECIDED);
      return {
        type: 7,
        data: {
          content: "버렸습니다.",
          components: linkRow(candidate),
          allowed_mentions: { parse: [] },
        },
      };
    }
    if (!shouldCardCandidate(candidate)) return ephemeral(NOT_PUBLISHABLE);
    const retryAt = await input.store.publicationRetryAt(CARDS_PER_HOUR);
    if (retryAt) return ephemeral(overLimit(retryAt));
    const deadline = findDeadline(candidate);
    return {
      type: 9,
      data: {
        custom_id: `${DISCOUNT_MODAL_PREFIX}${candidate.id}`,
        title: "게시 확인",
        components: [
          {
            type: 1,
            components: [
              {
                type: 4,
                custom_id: DISCOUNT_DEADLINE_INPUT,
                style: 1,
                label: "마감일 (비우면 표시하지 않음)",
                placeholder: "예: 2026-12-31",
                required: false,
                max_length: DEADLINE_MAX_CHARS,
                ...(deadline ? { value: deadline } : {}),
              },
            ],
          },
        ],
      },
    };
  } catch (error) {
    logFailure(error);
    return ephemeral(TRY_AGAIN);
  }
}

/**
 * The modal was submitted: claims the row, sends to every channel for its kind, then
 * says what happened. The claim comes first, so dying mid-send loses a card (published
 * without a message id) rather than sending it twice. One server's channel failing does
 * not stop the others, and the row goes back only when every channel definitely refused.
 */
export async function publishDiscountCard(
  input: DiscountApproval,
  identity: DiscordIdentity,
  customId: string,
  deadline: string,
): Promise<DiscountPublishResult> {
  let candidate: CandidateForDecision;
  let channelIds: readonly string[];
  try {
    const found = await decidable(input, identity, customId);
    if (typeof found === "string") return { notice: found };
    if (!shouldCardCandidate(found)) return { notice: NOT_PUBLISHABLE };
    channelIds = await input.publicChannelIds(found.kind);
    const claim = await input.store.claimCandidatePublication(
      found.id,
      CARDS_PER_HOUR,
    );
    if (claim.retryAt) return { notice: overLimit(claim.retryAt) };
    if (!claim.claimed) return { notice: ALREADY_DECIDED };
    candidate = found;
  } catch (error) {
    logFailure(error);
    return { notice: TRY_AGAIN };
  }

  let messageId: string | undefined;
  const sent: string[] = [];
  const uncertain: string[] = [];
  const refused: string[] = [];
  for (const channelId of channelIds) {
    try {
      const result = await input.delivery.send(
        { channel: "discord_channel", recipientId: channelId },
        cardPayloadFor(candidate, deadline),
        `discount-public:${candidate.id}:${channelId}`,
      );
      messageId ??= result.providerId;
      sent.push(channelId);
    } catch (error) {
      logFailure(error);
      (error instanceof UncertainDeliveryError ||
      error instanceof DiscordServerError
        ? uncertain
        : refused
      ).push(channelId);
    }
  }

  const places = (ids: readonly string[]) =>
    ids.map((id) => `<#${id}>`).join(", ");
  if (!messageId) {
    if (uncertain.length)
      return {
        edit: {
          content: `게시 결과를 알 수 없습니다. ${places(uncertain)}을 확인해 주세요.`,
          components: linkRow(candidate),
        },
        notice: `${places(uncertain)}에 갔는지 알 수 없어 다시 보내지 않습니다. 채널에 없으면 운영 문서대로 되돌려 주세요.`,
      };
    try {
      await input.store.releaseCandidatePublication(candidate.id);
    } catch (releaseError) {
      logFailure(releaseError);
      return {
        notice:
          "게시하지 못했고 후보도 되돌리지 못했습니다. 운영 문서대로 되돌려 주세요.",
      };
    }
    return {
      notice: `게시하지 못했습니다. ${places(refused)} 권한을 확인한 뒤 다시 눌러 주세요. 후보는 그대로입니다.`,
    };
  }

  const line = deadlineLine(deadline);
  const edit = {
    content: `${places(sent)}에 게시했습니다.${line ? ` ${line}` : ""}`,
    components: linkRow(candidate),
  };
  const missed = [...refused, ...uncertain];
  const partial = missed.length
    ? `${places(missed)}에는 보내지 못했거나 갔는지 알 수 없습니다. 다시 보내지는 않습니다.`
    : undefined;
  try {
    await input.store.saveCandidatePublicMessage(candidate.id, messageId);
  } catch (error) {
    logFailure(error);
    return {
      edit,
      notice: [
        "게시했지만 메시지 ID를 저장하지 못했습니다. 다시 보내지는 않습니다.",
        partial,
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }
  return partial ? { edit, notice: partial } : { edit };
}
