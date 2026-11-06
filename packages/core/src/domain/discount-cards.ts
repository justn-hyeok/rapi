import type {
  CandidateBand,
  CandidatePriceCheck,
  CandidateTermsNote,
} from "./candidate-verification.js";
import {
  MONTH,
  PRICE_CUT,
  UNVETTED_ROUTES,
  type DiscountCandidateKind,
  type DiscountCandidateRoute,
} from "./discount-candidates.js";
import { CARD_COLOR, clip, type DiscordCard } from "./discord-card.js";

export interface CandidateForCard {
  id: string;
  kind: DiscountCandidateKind;
  route: DiscountCandidateRoute;
  domain: string | null;
  title: string;
  url: string;
  evidence: string;
  band: CandidateBand | "red" | null;
  tags: string[];
  operator: string | null;
  priceCheck: CandidatePriceCheck | null;
  termsNote: CandidateTermsNote | null;
  // What a reporter wrote. Only the owner's review card shows it, never a public one.
  memo?: string | null;
}

export interface CandidateForDecision extends CandidateForCard {
  status: string;
}

export interface ProblemReportForCard {
  id: string;
  url: string;
  domain: string;
  reporterId: string;
  memo: string | null;
}

export type ProblemDecision = "red" | "no_problem";

const BAND_COLOR = { green: 0x2e9e5b, yellow: 0xe0b020 } as const;
const ROUTE_LABEL: Record<DiscountCandidateRoute, string> = {
  changelog: "공식 변경로그",
  pull_request: "PR",
  code_search: "코드 검색",
  report: "제보",
  catalog: "OpenRouter",
  hacker_news: "Hacker News",
  credit_feed: "aifree.dev",
  community: "커뮤니티",
  relay_list: "무료 중계 목록",
  promoclock: "PromoClock",
  relay_site: "중계 사이트",
  free_list: "무료 API 목록",
  commit_log: "요금제 변경 기록",
};
const DETAIL_MAX_CHARS = 300;
// The longest URL Discord accepts on a link button.
const LINK_MAX_CHARS = 512;

// "Hobby" plans are free, so a policy notice can say so without offering anything.
const POLICY_NOTICE = /\b(?:terms of (?:service|use)|privacy policy)\b/i;
// Not "feel free", "tax-free", "credit card" or "load credits onto", which give nothing.
const FREE_OR_CREDIT =
  /(?<!feel |-)\bfree\b|(?<!\b(?:load|buy|purchase|add) )\bcredits?\b(?! cards?\b)|무료|크레딧/i;
const PRICE_CUT_WORDING = new RegExp(PRICE_CUT, "i");
const REFERRAL_PARAM = /^(?:ref|aff|invite|utm_|via$|code$)/i;
const NUMBER_MONTH = "(?:0?[1-9]|1[0-2])";
const DAY = "(?:0?[1-9]|[12]\\d|3[01])";
const ORDINAL_DAY = `${DAY}(?:st|nd|rd|th)?`;
const YEAR = "20\\d{2}";
const DATE = [
  `\\b${YEAR}[-./]${NUMBER_MONTH}[-./]${DAY}\\b`,
  `${YEAR}년\\s*${NUMBER_MONTH}월\\s*${DAY}일`,
  `${NUMBER_MONTH}월\\s*${DAY}일`,
  `\\b${MONTH}\\s+${ORDINAL_DAY}(?:,?\\s+${YEAR})?\\b`,
  `\\b${ORDINAL_DAY}\\s+${MONTH}(?:,?\\s+${YEAR})?(?![\\p{L}\\d])`,
].join("|");
const ANY_DATE = new RegExp(DATE, "iu");
const END_DATE = new RegExp(
  `(?:\\b(?:until|through|thru|by|ends?(?: on)?|expires?(?: on)?)\\s+|마감일?:?\\s*|~\\s*)(${DATE})|(${DATE})\\s*까지`,
  "iu",
);
export const DEADLINE_MAX_CHARS = 40;
const RISK_LINE =
  "위험: 검증하지 않은 커뮤니티 글입니다. 계정 풀 재판매이거나 갑자기 막힐 수 있습니다.";

const MONTHS = "janfebmaraprmayjunjulaugsepoctnovdec";
const HOURS_AHEAD_OF_UTC = 9;

// A date with no year means the one nearest today: "until Jan 15" read in December.
function nearestYear(month: number, day: number, now: Date): Date {
  return [-1, 0, 1]
    .map(
      (offset) => new Date(Date.UTC(now.getUTCFullYear() + offset, month, day)),
    )
    .reduce((best, date) =>
      Math.abs(date.getTime() - now.getTime()) <
      Math.abs(best.getTime() - now.getTime())
        ? date
        : best,
    );
}

function parseCardDate(text: string, now: Date): Date | null {
  const full =
    /(20\d{2})\s*(?:[-./]|년)\s*(\d{1,2})\s*(?:[-./]|월)\s*(\d{1,2})/.exec(
      text,
    );
  if (full)
    return new Date(
      Date.UTC(Number(full[1]), Number(full[2]) - 1, Number(full[3])),
    );
  const korean = /(\d{1,2})월\s*(\d{1,2})일/.exec(text);
  if (korean) return nearestYear(Number(korean[1]) - 1, Number(korean[2]), now);
  const name = new RegExp(MONTH, "i").exec(text);
  if (!name) return null;
  const month = MONTHS.indexOf(name[0].slice(0, 3).toLowerCase()) / 3;
  const day = /\b(\d{1,2})(?:st|nd|rd|th)?\b/.exec(text);
  if (!day) return null;
  const year = /\b20\d{2}\b/.exec(text);
  return year
    ? new Date(Date.UTC(Number(year[0]), month, Number(day[1])))
    : nearestYear(month, Number(day[1]), now);
}

/** Whether the wording gives an end date before today, in Korea. No end date is not ended. */
export function offerHasEnded(
  candidate: Pick<CandidateForCard, "title" | "evidence">,
  now: Date,
): boolean {
  const end = END_DATE.exec(
    plainLine(`${candidate.title} ${candidate.evidence}`),
  );
  const raw = end?.[1] ?? end?.[2];
  const date = raw ? parseCardDate(raw, now) : null;
  if (!date) return false;
  const today = new Date(now.getTime() + HOURS_AHEAD_OF_UTC * 3_600_000);
  today.setUTCHours(0, 0, 0, 0);
  return date.getTime() < today.getTime();
}

/** The row's own https address without referral parameters, or null. */
export function cardLink(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  for (const key of [...url.searchParams.keys()])
    if (REFERRAL_PARAM.test(key)) url.searchParams.delete(key);
  return url.href.length <= LINK_MAX_CHARS ? url.href : null;
}

/**
 * Whether this row becomes a card. Red is the owner's "do not post", a missing
 * band is not checked yet, and a changelog entry has to offer something: the
 * collector also keeps ordinary updates that merely mention a date or a credit,
 * and an offer whose own end date has passed is no longer news.
 * A report has no wording to judge, and a person chose to send it.
 */
export function shouldCardCandidate(
  candidate: CandidateForCard,
  now = new Date(),
): boolean {
  if (candidate.band !== "green" && candidate.band !== "yellow") return false;
  if (!cardLink(candidate.url)) return false;
  if (candidate.kind === "new_service" || candidate.route === "report")
    return true;
  // The collector already judged its Chinese wording, which the rules below cannot read.
  // PromoClock, the free API lists and the plan logs' kept commits are all offers.
  if (
    UNVETTED_ROUTES.includes(candidate.route) ||
    candidate.route === "promoclock" ||
    candidate.route === "free_list" ||
    candidate.route === "commit_log"
  )
    return !offerHasEnded(candidate, now);
  if (POLICY_NOTICE.test(candidate.title)) return false;
  if (offerHasEnded(candidate, now)) return false;
  return (
    candidate.priceCheck === "below_list" ||
    FREE_OR_CREDIT.test(`${candidate.title} ${candidate.evidence}`) ||
    PRICE_CUT_WORDING.test(`${candidate.title} ${candidate.evidence}`)
  );
}

// One line of a stranger's text. A bare address loses its scheme so it stays text.
export function plainLine(value: string): string {
  return value
    .replace(/\p{Cf}+/gu, "")
    .replace(/[\p{Cc}\s]+/gu, " ")
    .replace(/[a-z][a-z0-9+.-]*:\/\//gi, "")
    .trim();
}

// Backslashes show as nothing in a title or body, and stop markdown, masked and
// bare links, and mentions from forming. Author names render no markdown at all.
export function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_~|<>#[\]()@:.-]/g, "\\$&");
}

/**
 * A date to prefill for the owner to confirm, or "". A date that reads as an end
 * wins over the first one mentioned; it is never trusted without the owner.
 */
export function findDeadline(
  candidate: Pick<CandidateForCard, "title" | "evidence">,
): string {
  const text = plainLine(`${candidate.title} ${candidate.evidence}`);
  const end = END_DATE.exec(text);
  return end?.[1] ?? end?.[2] ?? ANY_DATE.exec(text)?.[0] ?? "";
}

/** The line a confirmed deadline shows as. Blank shows nothing. */
export function deadlineLine(deadline: string): string {
  const clean = plainLine(deadline);
  return clean
    ? `마감: ${escapeMarkdown(clip(clean, DEADLINE_MAX_CHARS))}`
    : "";
}

/** ROADMAP's "정해진 카드 규칙": source, linked title, details, tags. */
export function discountCard(
  candidate: CandidateForCard,
  deadline = "",
): DiscordCard {
  const link = cardLink(candidate.url);
  // A post's domain stays empty so a red mark cannot reach the whole forum; the
  // card still names the forum.
  const domain = plainLine(
    candidate.domain ??
      (candidate.route === "community" && link ? new URL(link).hostname : ""),
  );
  const title = plainLine(candidate.title);
  const detail = plainLine(
    candidate.evidence.startsWith(candidate.title)
      ? candidate.evidence.slice(candidate.title.length)
      : candidate.evidence,
  );
  const price =
    candidate.priceCheck === "below_list"
      ? "정가보다 쌈"
      : candidate.priceCheck === "list_price"
        ? "정가"
        : null;
  const risky = candidate.tags.includes("#위험");
  return {
    author: [ROUTE_LABEL[candidate.route], domain].filter(Boolean).join(" · "),
    title: escapeMarkdown(title || domain) || "이름 없는 후보",
    ...(link ? { url: link } : {}),
    description: [
      risky ? RISK_LINE : "",
      escapeMarkdown(clip(detail, DETAIL_MAX_CHARS)),
      deadlineLine(deadline),
      candidate.operator
        ? `운영: ${escapeMarkdown(plainLine(candidate.operator))}`
        : "",
      price ? `가격: ${price}` : "",
      candidate.termsNote ? `약관: ${candidate.termsNote}` : "",
      candidate.tags.join(" "),
    ]
      .filter(Boolean)
      .join("\n"),
    color: risky
      ? CARD_COLOR.warn
      : candidate.band === "green"
        ? BAND_COLOR.green
        : BAND_COLOR.yellow,
  };
}

const memoLine = (memo: string) => `메모: ${escapeMarkdown(plainLine(memo))}`;

/** The card as the owner sees it: a report's memo is for reviewing, not publishing. */
export function reviewCard(candidate: CandidateForCard): DiscordCard {
  const card = discountCard(candidate);
  return candidate.memo
    ? {
        ...card,
        description: [card.description, memoLine(candidate.memo)]
          .filter(Boolean)
          .join("\n"),
      }
    : card;
}

/**
 * A claim about a service, for the owner alone. It names the reporter so the owner
 * can weigh it; a mention inside an embed shows the name and pings nobody.
 */
export function problemCard(report: ProblemReportForCard): DiscordCard {
  const link = cardLink(report.url);
  return {
    author: "문제 제보",
    title: escapeMarkdown(plainLine(report.domain)),
    ...(link ? { url: link } : {}),
    description: [
      `링크: ${escapeMarkdown(plainLine(report.url))}`,
      report.memo ? memoLine(report.memo) : "",
      `제보자: <@${report.reporterId}>`,
    ]
      .filter(Boolean)
      .join("\n"),
    color: CARD_COLOR.warn,
  };
}
