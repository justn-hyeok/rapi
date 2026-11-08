import { plainText, type DiscountCandidate } from "@rapi/domain";
import { type CandidateResult } from "@rapi/application";
import { readSource, type SourceHttpOptions } from "../web/sources.js";

export interface PromoClockSource {
  url: string;
}

export interface PromoClockDeal {
  slug: string;
  title: string;
  terms: string;
  source: string;
}

// "- **Tool: Deal** — terms (start → end). Details: <page> · Source: <official> (verified <date>)"
const DEAL_LINE =
  /^- \*\*(.+?)\*\* — (.+?) Details: (https:\/\/promoclock\.co\/\S+) · Source: (https:\/\/\S+) \(verified [\d-]+\)\s*$/;
const DEAL_SECTION = /^## (?:Latest Claude changes|Live AI deals)/;
const PAUSED = /\(paused\)\s*$/i;

/** The deals in PromoClock's llms.txt, from the two sections that list them. */
export function parsePromoClock(body: string): PromoClockDeal[] {
  const deals: PromoClockDeal[] = [];
  let inDeals = false;
  for (const line of body.split("\n")) {
    if (line.startsWith("## ")) inDeals = DEAL_SECTION.test(line);
    if (!inDeals) continue;
    const match = DEAL_LINE.exec(line);
    if (!match || PAUSED.test(match[1]!)) continue;
    const slug = /\/deals\/([^/]+)\/?$/.exec(match[3]!)?.[1];
    if (!slug) continue;
    deals.push({
      slug,
      title: plainText(match[1]!, 300),
      // "→ end" reads as an end date to the card rules as "~ end".
      terms: plainText(match[2]!.replace(/\s*→\s*/g, " ~ "), 600),
      source: match[4]!,
    });
  }
  return deals;
}

function readSeen(cursor: string | null): string[] | null {
  if (!cursor) return null;
  try {
    const value = JSON.parse(cursor) as { slugs?: unknown };
    return Array.isArray(value.slugs) ? (value.slugs as string[]) : null;
  } catch {
    return null;
  }
}

/**
 * PromoClock's deal list, compared with the previous run: only deals that were
 * not listed before. The card links the official page PromoClock checked, not
 * PromoClock, whose links can be affiliate links. The first run only records.
 */
export class PromoClockRoute {
  constructor(private readonly options: SourceHttpOptions = {}) {}

  async collect(
    source: PromoClockSource,
    cursor: string | null,
  ): Promise<CandidateResult> {
    const { body } = await readSource(
      source.url,
      { Accept: "text/plain", "User-Agent": "rapi" },
      this.options,
    );
    const deals = parsePromoClock(body);
    if (!deals.length) throw new Error(`${source.url} lists no deals`);
    const next = JSON.stringify({ slugs: deals.map((deal) => deal.slug) });
    const seen = readSeen(cursor);
    if (!seen) return { candidates: [], cursor: next };
    const candidates: DiscountCandidate[] = deals
      .filter((deal) => !seen.includes(deal.slug))
      .map((deal) => ({
        kind: "discount",
        route: "promoclock",
        dedupeKey: `promoclock:${deal.slug}`,
        domain: new URL(deal.source).hostname,
        title: deal.title,
        url: deal.source,
        evidence: deal.terms,
        publishedAt: null,
      }));
    return { candidates, cursor: next };
  }
}
