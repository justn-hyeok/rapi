import type {
  CandidateBand,
  CandidatePriceCheck,
  CandidateTermsNote,
} from "./candidate-verification.js";
import {
  MONTH,
  type DiscountCandidateKind,
  type DiscountCandidateRoute,
} from "./discount-candidates.js";
import { clip, type DiscordCard } from "./discord-card.js";

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

const BAND_COLOR = { green: 0x2e9e5b, yellow: 0xe0b020 } as const;
const ROUTE_LABEL: Record<DiscountCandidateRoute, string> = {
  changelog: "공식 변경로그",
  pull_request: "PR",
  code_search: "코드 검색",
  report: "제보",
};
const DETAIL_MAX_CHARS = 300;
// The longest URL Discord accepts on a link button.
const LINK_MAX_CHARS = 512;

// "Hobby" plans are free, so a policy notice can say so without offering anything.
const POLICY_NOTICE = /\b(?:terms of (?:service|use)|privacy policy)\b/i;
// Not "feel free", "tax-free", "credit card" or "load credits onto", which give nothing.
const FREE_OR_CREDIT =
  /(?<!feel |-)\bfree\b|(?<!\b(?:load|buy|purchase|add) )\bcredits?\b(?! cards?\b)|무료|크레딧/i;
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
 * collector also keeps ordinary updates that merely mention a date or a credit.
 * A report has no wording to judge, and a person chose to send it.
 */
export function shouldCardCandidate(candidate: CandidateForCard): boolean {
  if (candidate.band !== "green" && candidate.band !== "yellow") return false;
  if (!cardLink(candidate.url)) return false;
  if (candidate.kind === "new_service" || candidate.route === "report")
    return true;
  if (POLICY_NOTICE.test(candidate.title)) return false;
  return (
    candidate.priceCheck === "below_list" ||
    FREE_OR_CREDIT.test(`${candidate.title} ${candidate.evidence}`)
  );
}

// One line of a stranger's text. A bare address loses its scheme so it stays text.
function plainLine(value: string): string {
  return value
    .replace(/\p{Cf}+/gu, "")
    .replace(/[\p{Cc}\s]+/gu, " ")
    .replace(/[a-z][a-z0-9+.-]*:\/\//gi, "")
    .trim();
}

// Backslashes show as nothing in a title or body, and stop markdown, masked and
// bare links, and mentions from forming. Author names render no markdown at all.
function escapeMarkdown(value: string): string {
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
  const domain = plainLine(candidate.domain ?? "");
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
  return {
    author: [ROUTE_LABEL[candidate.route], domain].filter(Boolean).join(" · "),
    title: escapeMarkdown(title || domain) || "이름 없는 후보",
    ...(link ? { url: link } : {}),
    description: [
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
    color: candidate.band === "green" ? BAND_COLOR.green : BAND_COLOR.yellow,
  };
}

/** The card as the owner sees it: a report's memo is for reviewing, not publishing. */
export function reviewCard(candidate: CandidateForCard): DiscordCard {
  const card = discountCard(candidate);
  return candidate.memo
    ? {
        ...card,
        description: [
          card.description,
          `메모: ${escapeMarkdown(plainLine(candidate.memo))}`,
        ]
          .filter(Boolean)
          .join("\n"),
      }
    : card;
}
