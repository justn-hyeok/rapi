import {
  UNVETTED_ROUTES,
  type DiscountCandidateKind,
  type DiscountCandidateRoute,
} from "./discount-candidates.js";

// Red is the owner's call after reading evidence about that domain: no rule returns it.
export type CandidateBand = "green" | "yellow";
export type CandidateTag = "#직접호스팅" | "#오픈모델" | "#재판매" | "#위험";
export type CandidatePriceCheck = "below_list" | "list_price" | "unknown";
export type CandidateTermsNote = "확인 못 함" | "링크 없음";

export interface KnownOperator {
  domain: string;
  name: string;
  // official sells its own models; hosting and router sell others' too.
  service: "official" | "hosting" | "router" | "reseller";
  tags: CandidateTag[];
}

/** What a service's own page shows. Null when the page could not be read. */
export interface ServicePage {
  text: string;
  termsUrl: string | null;
}

export interface CandidateToVerify {
  id: string;
  kind: DiscountCandidateKind;
  route: DiscountCandidateRoute;
  domain: string | null;
  title: string;
  evidence: string;
}

export interface CandidateVerification {
  band: CandidateBand;
  tags: CandidateTag[];
  operator: string | null;
  priceCheck: CandidatePriceCheck;
  termsUrl: string | null;
  termsNote: CandidateTermsNote | null;
}

const CLOSED_MODEL =
  /\bgpt-?\d|\bclaude[- ](?:opus|sonnet|haiku|\d)|\bgemini[- ]\d|\bgrok[- ]?\d/i;
const OPEN_MODEL =
  /\b(?:llama[- ]?\d|qwen|deepseek|mistral|mixtral|gemma|glm[- ]?\d|kimi|minimax|gpt-oss|nemotron|olmo)/i;
const BELOW_LIST =
  /%\s*off\b|\bdiscount|\bcheaper\b|\bprice[\s-](?:cuts?|reductions?|drops?)\b|\b(?:promotional|lower|reduced) pricing\b|\bbelow (?:the )?(?:official|list)\b|할인|인하(?![여대])|저렴|최저가|\d\s*折|低至|便宜/i;
const NO_MARKUP =
  /\b(?:no|zero|without|0%) markup\b|\bat (?:the )?list prices?\b|\bat cost\b|수수료 없|정가 그대로/i;
// "You can self-host this" says nothing about who runs this service, so not that.
const DIRECT_HOSTING =
  /\bour own (?:gpus?|hardware|clusters?|infrastructure|data ?cent(?:er|re)s?)\b|\bwe (?:host|run|operate) (?:the |all |these |our |every )*(?:models?|gpus?|inference)\b|직접 호스팅|자체 (?:GPU|서버|인프라)|自建/i;
const SUPPLIERS_NAMED =
  /\b(?:upstream|inference) providers?\b|\b(?:powered|hosted|served) by\b|공급처|공급사|供应商/i;
const COMPANY = [
  /\b[A-Z][A-Za-z0-9&-]{0,40}(?: [A-Z][A-Za-z0-9&-]{0,40}){0,3},? (?:Inc\b\.?|LLC\b|Ltd\b\.?|Corp\b\.?|GmbH\b|Pte\b\.? Ltd\b\.?|Co\b\.?, Ltd\b\.?)/,
  /주식회사\s?[가-힣A-Za-z0-9]{1,30}|[가-힣A-Za-z0-9]{1,30}\s?주식회사|\(주\)\s?[가-힣A-Za-z0-9]{1,30}/,
  /[一-鿿]{2,30}有限公司/,
];

function companyIn(text: string): string | null {
  for (const pattern of COMPANY) {
    const match = pattern.exec(text);
    if (match) return match[0];
  }
  return null;
}

export function knownOperator(
  domain: string | null,
  operators: readonly KnownOperator[],
): KnownOperator | null {
  if (!domain) return null;
  return (
    operators.find(
      (operator) =>
        domain === operator.domain || domain.endsWith(`.${operator.domain}`),
    ) ?? null
  );
}

/**
 * The rules in ROADMAP's "정해진 카드 규칙". Rules only: no model decides this.
 * Terms never change the band, and a missing page never reads as a missing link.
 */
export function verifyCandidate(
  candidate: CandidateToVerify,
  known: KnownOperator | null,
  page: ServicePage | null,
): CandidateVerification {
  // A changelog entry describes its price. New services have only a title that
  // names a repository or PR, which says nothing about the service. A report's
  // title is its domain, chosen by whoever registered it, so that counts for nothing.
  const own =
    candidate.kind === "discount" && candidate.route !== "report"
      ? `${candidate.title} ${candidate.evidence}`
      : "";
  // A known operator's home page lists everything it sells, not this offer.
  const text = known ? own : `${own} ${page?.text ?? ""}`;
  // Code search only looks for closed model names next to a base URL.
  const closed = candidate.route === "code_search" || CLOSED_MODEL.test(text);
  const open = OPEN_MODEL.test(text);
  const belowList = BELOW_LIST.test(text);
  const noMarkup = !belowList && NO_MARKUP.test(text);
  const hosting = DIRECT_HOSTING.test(text);
  const operator = known?.name ?? companyIn(page?.text ?? "");

  const resold = known
    ? known.service === "reseller" ||
      (known.service !== "official" && closed && belowList)
    : closed && !noMarkup;
  const plainService =
    (hosting && !closed) ||
    noMarkup ||
    (open && !closed && SUPPLIERS_NAMED.test(text));
  const green = known ? !resold : Boolean(operator) && plainService;

  const tags = new Set<CandidateTag>(known?.tags ?? []);
  if (!known && hosting) tags.add("#직접호스팅");
  if (open) tags.add("#오픈모델");
  if (resold) tags.add("#재판매");
  // A forum post or a list entry is a stranger's claim, whatever it says about itself.
  const unvetted = UNVETTED_ROUTES.includes(candidate.route);
  if (unvetted) tags.add("#위험");
  // The lists are of relay sites, which pass on someone else's models.
  if (candidate.route === "relay_list") tags.add("#재판매");

  return {
    band: green && !unvetted ? "green" : "yellow",
    tags: [...tags],
    operator,
    priceCheck: belowList ? "below_list" : noMarkup ? "list_price" : "unknown",
    termsUrl: page?.termsUrl ?? null,
    termsNote: !page ? "확인 못 함" : page.termsUrl ? null : "링크 없음",
  };
}
