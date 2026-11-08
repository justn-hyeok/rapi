import {
  plainText,
  type DiscountCandidate,
  type ServicePage,
} from "@rapi/domain";
import { publicFetch, type ResolveHostname } from "./public-fetch.js";
import { readSource, type SourceHttpOptions } from "./sources.js";

// Something concrete given away: an amount of credit, a percentage off, or
// sign-up credit. Not "free tier" or "100x cheaper", which every page says.
const OFFER =
  /\$\s?\d[\d.,]*\s*(?:in\s+)?(?:free\s+)?(?:api\s+)?(?:credits?|bonus)\b|\bfree\s+(?:api\s+)?credits?\b|\d+\s?%\s*(?:off|discount)\b|注册.{0,8}(?:送|赠|获得)|赠送.{0,10}(?:\$|¥|￥|额度)|免费额度|가입.{0,8}(?:지급|증정)|무료\s*크레딧/i;
// A page this short is a script shell, such as new-api's front page.
const SHELL_PAGE_CHARS = 500;

// Where a phrase on a page ends: a sentence mark, the gap between page parts,
// or a space between Chinese words, which Chinese only puts between buttons.
const BREAK =
  /[。！？，!?|·•]|\.\s|\s{2,}|(?<=\p{Script=Han})\s(?=\p{Script=Han})/u;
const PHRASE_MAX_CHARS = 80;

/**
 * The first concrete offer on a page, or null: the phrase it sits in.
 */
export function offerOnPage(text: string): { phrase: string } | null {
  const clean = plainText(text, 200_000);
  const match = OFFER.exec(clean);
  if (!match) return null;
  const end = match.index + match[0].length;
  // One character past the match start, so a break right before it can see what follows.
  const windowStart = Math.max(0, match.index - PHRASE_MAX_CHARS);
  const before = clean.slice(windowStart, match.index + 1);
  const lastBreak = [...before.matchAll(new RegExp(BREAK, "gu"))]
    .filter((mark) => mark.index < match.index - windowStart)
    .at(-1);
  const from =
    windowStart + (lastBreak ? lastBreak.index + lastBreak[0].length : 0);
  const after = clean.slice(end, end + PHRASE_MAX_CHARS);
  const to = end + (BREAK.exec(after)?.index ?? after.length);
  return {
    phrase: clean.slice(from, to).trim().slice(0, PHRASE_MAX_CHARS),
  };
}

/**
 * A sign-up bonus from a new-api site's public status, read once. The domain is
 * a stranger's, so the request goes through publicFetch with nothing but these
 * headers, and it is never added to the sites watched every day.
 */
async function newApiBonus(
  domain: string,
  options: SourceHttpOptions & { resolve?: ResolveHostname },
): Promise<string | null> {
  const { resolve, ...http } = options;
  try {
    const { body } = await readSource(
      `https://${domain}/api/status`,
      { Accept: "application/json", "User-Agent": "rapi" },
      {
        timeoutMs: 10_000,
        maxBodyBytes: 500_000,
        ...http,
        fetch: publicFetch(http.fetch, resolve),
      },
    );
    const { data } = JSON.parse(body) as {
      data?: { quota_for_invitee?: unknown; quota_per_unit?: unknown };
    };
    const quota = data?.quota_for_invitee;
    const unit = data?.quota_per_unit;
    if (
      typeof quota !== "number" ||
      typeof unit !== "number" ||
      !(quota > 0 && unit > 0)
    )
      return null;
    return `초대받아 가입하면 $${Math.round((quota / unit) * 100) / 100}`;
  } catch {
    return null;
  }
}

/**
 * An offer on the front page of a service another route found, as a candidate
 * of its own, or null. The page has been read already; a page that is only a
 * script shell gets one look at the new-api status behind it.
 */
export async function siteOffer(
  domain: string,
  page: ServicePage | null,
  options: SourceHttpOptions & { resolve?: ResolveHostname } = {},
): Promise<DiscountCandidate | null> {
  const onPage = page ? offerOnPage(page.text) : null;
  const bonus =
    !onPage && (!page || page.text.length < SHELL_PAGE_CHARS)
      ? await newApiBonus(domain, options)
      : null;
  const phrase = onPage?.phrase ?? bonus;
  if (!phrase) return null;
  return {
    kind: "discount",
    route: "site_offer",
    dedupeKey: `site_offer:${domain}`,
    domain,
    title: `${domain}: ${plainText(phrase, 200)}`,
    url: `https://${domain.startsWith("api.") ? domain.slice(4) : domain}/`,
    // The page around an offer is menus and quotes; the card says where it was.
    evidence: onPage
      ? `${domain} 첫 화면에 적힌 혜택`
      : `${domain}의 공개 상태(/api/status)에 적힌 초대 보너스`,
    publishedAt: null,
  };
}
