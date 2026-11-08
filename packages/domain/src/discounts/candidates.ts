export type DiscountCandidateKind = "new_service" | "discount";
export type DiscountCandidateRoute =
  | "code_search"
  | "pull_request"
  | "changelog"
  | "report"
  | "catalog"
  | "hacker_news"
  | "credit_feed"
  | "community"
  | "relay_list"
  | "promoclock"
  | "relay_site"
  | "free_list"
  | "commit_log"
  | "site_offer";

/**
 * Routes whose rows are strangers' claims: a forum post, someone else's list of
 * free relay sites, or a relay site or an unknown service about itself. They are always risky, and they
 * share one daily card limit.
 */
export const UNVETTED_ROUTES: readonly DiscountCandidateRoute[] = [
  "community",
  "relay_list",
  "relay_site",
  "site_offer",
];

export interface DiscountCandidate {
  kind: DiscountCandidateKind;
  route: DiscountCandidateRoute;
  dedupeKey: string;
  domain: string | null;
  title: string;
  url: string;
  evidence: string;
  publishedAt: string | null;
}

/** What /제보 keeps: nothing from the page, which is read later and only by the rules. */
export interface NewReport {
  kind: DiscountCandidateKind | "problem";
  url: string;
  domain: string;
  reporterId: string;
  memo: string | null;
}

export type ReportOutcome = "saved" | "duplicate" | "limited";

export const DISCOUNT_EVIDENCE_MAX_CHARS = 600;
export const DISCOUNT_BODY_DEFAULT_CHARS = 600;
export const REPORT_MEMO_MAX_CHARS = 200;

export const MONTH =
  "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
// "인하" alone also matches "인하여" (because of) and "인하대".
/** Wording that says the price itself went down, enough to make a card on its own. */
export const PRICE_CUT =
  "%\\s*off\\b|\\bdiscount(?:s|ed)?\\b|\\bcuts?\\s+(?:[\\w-]+\\s+){0,3}prices?\\b|\\bprices?[\\s-](?:cuts?|reductions?|drops?)\\b|\\bprices?\\s+(?:(?:have|has)\\s+been\\s+|(?:were|was|are|is)\\s+)?(?:reduced|lowered|cut)\\b|\\boff-peak\\s+(?:pricing|prices?)\\b|할인|인하(?![여대])";
const DISCOUNT_WORDING = new RegExp(
  [
    PRICE_CUT,
    "\\bpromotional pricing\\b",
    "\\blower pricing\\b",
    "\\bcheaper\\b",
    "\\bcredits?\\b",
    `\\b(?:through|until)\\s+(?:${MONTH}\\s+\\d{1,2}|\\d{1,2}\\s+${MONTH}|${MONTH}\\s+\\d{4}|\\d{4}-\\d{2}-\\d{2})`,
    "크레딧",
  ].join("|"),
  "i",
);

/**
 * The text around the first discount wording in the title or the start of the
 * body, or null when there is none. Rules only: no model decides this.
 */
export function discountEvidence(
  title: string,
  body: string,
  bodyChars = DISCOUNT_BODY_DEFAULT_CHARS,
): string | null {
  const text = `${title} ${body.slice(0, bodyChars)}`;
  const match = DISCOUNT_WORDING.exec(text);
  if (!match) return null;
  const start = Math.max(0, match.index - 200);
  return text.slice(start, start + DISCOUNT_EVIDENCE_MAX_CHARS).trim();
}

// Gambling, shared account or certificate pools and rented identities are never
// a deal to pass on, whatever they cost, and they say so in their own words.
const HAZARD =
  /도박|룰렛|카지노|博彩|赌|轮盘|老虎机|\bcasino|\broulette|\bgambl|계정\s*풀|인증서\s*풀|号池|账号池|帳號池|证书池|證書池|人证|接码|\baccount\s+pools?\b|\bcert(?:ificate)?\s+pools?\b/i;

/** Whether a candidate offers something no one should be pointed to. Rules only. */
export function isHazardous(
  candidate: Pick<DiscountCandidate, "title" | "evidence">,
): boolean {
  return HAZARD.test(`${candidate.title} ${candidate.evidence}`);
}
