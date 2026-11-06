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
import {
  cardTemplates,
  fillTemplate,
  templateCard,
  templateText,
} from "./card-template.js";
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

export interface ProblemReportForCard {
  id: string;
  url: string;
  domain: string;
  reporterId: string;
  memo: string | null;
}

export type ProblemDecision = "red" | "no_problem";

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

const deadlineValue = (deadline: string) => {
  const clean = plainLine(deadline);
  return clean ? escapeMarkdown(clip(clean, DEADLINE_MAX_CHARS)) : "";
};

/** The line a confirmed deadline shows as, from the card's own deadline line. Blank shows nothing. */
export function deadlineLine(deadline: string): string {
  const line =
    cardTemplates().cards.discount.lines.find((text) =>
      text.includes("{마감}"),
    ) ?? "[[마감: {마감}]]";
  return fillTemplate(line, { 마감: deadlineValue(deadline) });
}

/** ROADMAP's "정해진 카드 규칙": source, linked title, details, tags. */
export function discountCard(
  candidate: CandidateForCard,
  deadline = "",
  extraLines: string[] = [],
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
      ? templateText("priceBelowList")
      : candidate.priceCheck === "list_price"
        ? templateText("priceList")
        : "";
  const risky = candidate.tags.includes("#위험");
  return templateCard(
    "discount",
    {
      출처: cardTemplates().routeLabels[candidate.route] ?? candidate.route,
      도메인: domain,
      제목: escapeMarkdown(title || domain) || templateText("unnamed"),
      위험: risky ? (cardTemplates().cards.discount.risk ?? "") : "",
      내용: escapeMarkdown(clip(detail, DETAIL_MAX_CHARS)),
      마감: deadlineValue(deadline),
      운영: candidate.operator
        ? escapeMarkdown(plainLine(candidate.operator))
        : "",
      가격: price,
      약관: candidate.termsNote ?? "",
      태그: candidate.tags.join(" "),
      띠: risky ? "warn" : candidate.band === "green" ? "green" : "yellow",
    },
    { url: link, extraLines },
  );
}

/** The card as the owner sees it: a report's memo is for reviewing, not publishing. */
export function reviewCard(candidate: CandidateForCard): DiscordCard {
  const memo = candidate.memo ? escapeMarkdown(plainLine(candidate.memo)) : "";
  return discountCard(
    candidate,
    "",
    cardTemplates().cards.review.lines.map((line) =>
      fillTemplate(line, { 메모: memo }),
    ),
  );
}

/**
 * A claim about a service, for the owner alone. It names the reporter so the owner
 * can weigh it; a mention inside an embed shows the name and pings nobody.
 */
export function problemCard(report: ProblemReportForCard): DiscordCard {
  return templateCard(
    "problem",
    {
      도메인: escapeMarkdown(plainLine(report.domain)),
      링크: escapeMarkdown(plainLine(report.url)),
      메모: report.memo ? escapeMarkdown(plainLine(report.memo)) : "",
      제보자: `<@${report.reporterId}>`,
    },
    { url: cardLink(report.url) },
  );
}
