import {
  canonicalizeUrl,
  cardLink,
  clip,
  REPORT_MEMO_MAX_CHARS,
  type DiscountCandidateKind,
  type DiscordIdentity,
  isPublicUrl,
} from "@rapi/core";
import type { PostgresStore } from "@rapi/db";
import { messageBody } from "./community-feeds.js";
import { isReviewChannel, PROBLEM_RED_PREFIX } from "./discount-candidates.js";

export const REPORTS_PER_HOUR = 5;

export interface ReportIntake {
  store: Pick<PostgresStore, "saveReport">;
  reviewChannelId: () => Promise<string | undefined>;
}

export interface ReportOptions {
  link: string;
  kind?: string | undefined;
  memo?: string | undefined;
}

const KINDS: ReadonlySet<string> = new Set<DiscountCandidateKind | "problem">([
  "discount",
  "new_service",
  "problem",
]);

/**
 * The address to keep and its domain, or null. Anyone in a server can send one,
 * so it has to look public now, and verification only reaches it through publicFetch.
 */
export function reportableLink(
  raw: string,
): { url: string; domain: string } | null {
  try {
    const parsed = new URL(raw.trim());
    parsed.username = "";
    parsed.password = "";
    const url = cardLink(canonicalizeUrl(parsed.href));
    return url && isPublicUrl(url)
      ? { url, domain: new URL(url).hostname }
      : null;
  } catch {
    return null;
  }
}

function cleanMemo(memo: string | undefined): string | null {
  const clean = memo?.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim();
  return clean ? clip(clean, REPORT_MEMO_MAX_CHARS) : null;
}

/**
 * What /제보 answers. Saves and replies inside Discord's window: the link is not
 * opened here. The reply repeats nothing the reporter typed. Never throws.
 */
export async function receiveReport(
  input: ReportIntake,
  identity: DiscordIdentity,
  options: ReportOptions,
): Promise<string> {
  const link = reportableLink(options.link);
  if (!link) return "공개된 https 링크만 받습니다.";
  const kind = (
    options.kind && KINDS.has(options.kind) ? options.kind : "discount"
  ) as DiscountCandidateKind | "problem";
  try {
    const outcome = await input.store.saveReport(
      {
        kind,
        ...link,
        reporterId: identity.userId,
        memo: cleanMemo(options.memo),
      },
      REPORTS_PER_HOUR,
    );
    if (outcome === "limited")
      return `제보는 한 사람당 시간당 ${REPORTS_PER_HOUR}건까지 받습니다. 나중에 다시 보내 주세요.`;
    if (outcome === "duplicate") return "이미 받은 링크입니다. 고맙습니다.";
  } catch (error) {
    process.stderr.write(
      `report: ${error instanceof Error ? error.message.slice(0, 200) : "failed"}\n`,
    );
    return "제보를 저장하지 못했습니다. 잠시 뒤 다시 보내 주세요.";
  }
  if (!(await input.reviewChannelId().catch(() => "unknown")))
    return "제보를 저장했습니다. 검토 채널이 설정되지 않아 아직 소유자에게 전달되지 않습니다.";
  return kind === "problem"
    ? "문제 제보를 받았습니다. 소유자가 직접 확인합니다."
    : "제보를 받았습니다. 확인한 뒤 소유자에게 전달합니다.";
}

export interface ProblemReview {
  store: Pick<PostgresStore, "decideProblemReport">;
  ownerIds: readonly string[];
  reviewChannelIds: () => Promise<readonly string[]>;
}

const ephemeral = (content: string) => ({
  type: 4,
  data: { content, flags: 64, allowed_mentions: { parse: [] } },
});

function decisionText(decided: {
  domain: string;
  turnedRed: number;
  alreadyPublished: number;
}): string {
  const published = decided.alreadyPublished
    ? ` 이미 공개 채널에 나간 ${decided.alreadyPublished}건은 직접 지워 주세요.`
    : "";
  return `${decided.domain}을 빨강으로 정했습니다. 후보 ${decided.turnedRed}건과 앞으로 찾는 후보는 게시되지 않습니다.${published}`;
}

/**
 * The response to [빨강으로 정함] or [문제 없음]. Checked as the approval buttons are:
 * who pressed it and where come from Discord's signed request, on every click.
 */
export async function problemCardButton(
  input: ProblemReview,
  identity: DiscordIdentity,
  customId: string,
): Promise<unknown> {
  if (!input.ownerIds.includes(identity.userId))
    return ephemeral("소유자만 쓸 수 있는 버튼입니다.");
  try {
    if (!(await isReviewChannel(input.reviewChannelIds, identity.channelId)))
      return ephemeral("검토 채널에서만 쓸 수 있는 버튼입니다.");
    const decision = customId.startsWith(PROBLEM_RED_PREFIX)
      ? "red"
      : "no_problem";
    const decided = await input.store.decideProblemReport(
      customId.slice(customId.indexOf(":") + 1),
      decision,
      identity.userId,
    );
    if (!decided) return ephemeral("이미 처리한 제보입니다.");
    return {
      type: 7,
      data: {
        content:
          decision === "red"
            ? decisionText(decided)
            : "문제 없음으로 닫았습니다.",
        // The link stays; only the decision buttons go.
        components: messageBody([{ url: decided.url }]).components ?? [],
        allowed_mentions: { parse: [] },
      },
    };
  } catch (error) {
    process.stderr.write(
      `problem report: ${error instanceof Error ? error.message.slice(0, 200) : "failed"}\n`,
    );
    return ephemeral("처리하지 못했습니다. 잠시 뒤 다시 눌러 주세요.");
  }
}
