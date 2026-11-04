export type DiscountCandidateKind = "new_service" | "discount";
export type DiscountCandidateRoute =
  | "code_search"
  | "pull_request"
  | "changelog";

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

export const DISCOUNT_EVIDENCE_MAX_CHARS = 600;
export const DISCOUNT_BODY_DEFAULT_CHARS = 600;

const MONTH =
  "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
// "인하" alone also matches "인하여" (because of) and "인하대".
const DISCOUNT_WORDING = new RegExp(
  [
    "%\\s*off\\b",
    "\\bprices?[\\s-](?:cuts?|reductions?|drops?)\\b",
    "\\bpromotional pricing\\b",
    "\\blower pricing\\b",
    "\\bcheaper\\b",
    "\\bcredits?\\b",
    `\\b(?:through|until)\\s+(?:${MONTH}\\s+\\d{1,2}|\\d{1,2}\\s+${MONTH}|${MONTH}\\s+\\d{4}|\\d{4}-\\d{2}-\\d{2})`,
    "할인",
    "인하(?![여대])",
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
