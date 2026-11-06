import { createHash } from "node:crypto";
import { plainText, type DiscountCandidate } from "@rapi/core";
import type { CandidateResult } from "./discount-candidates.js";
import { readSource, type SourceHttpOptions } from "./sources.js";

/**
 * How a list is written. "welfare-hub" is ai-welfare-hub's sites.json, with amounts
 * as numbers; "stations" is Free-API's stations.json; "table" is a README whose
 * tables have a link column and a column headed with 额度 (credit).
 */
export type RelayListFormat = "welfare-hub" | "stations" | "table";

export interface RelayListSource {
  repository: string;
  path: string;
  format: RelayListFormat;
}

export interface RelayListEntry {
  key: string;
  name: string;
  url: string;
  domain: string | null;
  offer: string;
  // Amounts by kind, when the list writes them as numbers.
  amounts?: Record<string, number>;
}

interface RelayListSnapshot {
  entries: Record<string, { offer: string; amounts?: Record<string, number> }>;
}

// More changes than this in a day reads as the list being rewritten, not as news.
export const RELAY_LIST_MAX_CHANGES = 8;
const OFFER_MAX_CHARS = 200;
// A credit worth a card: a number, or words for giving or free.
const OFFER_WORDING = /送|赠|免费|白嫖|\d/;
const AMOUNT_LABEL: Record<string, string> = {
  signup: "가입",
  invite: "초대",
  dailyCheckin: "출석",
};

/** The site's own address: no path, query or referral code from whoever listed it. */
function siteAddress(raw: unknown): { url: string; domain: string } | null {
  if (typeof raw !== "string") return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const domain = url.hostname.toLowerCase().replace(/^www\./, "");
  return { url: `https://${url.host}/`, domain };
}

const text = (value: unknown, max = OFFER_MAX_CHARS) =>
  typeof value === "string" ? plainText(value, max) : "";

function welfareHub(body: string): RelayListEntry[] {
  const { sites } = JSON.parse(body) as { sites?: unknown };
  if (!Array.isArray(sites)) return [];
  return sites.flatMap((raw) => {
    const site = (raw ?? {}) as Record<string, unknown>;
    const address = siteAddress(site.homeUrl);
    const name = text(site.name, 80);
    if (!address || !name) return [];
    const credits = (site.credits ?? {}) as Record<string, unknown>;
    const unit = credits.unit === "point" ? "포인트" : "$";
    const approx = credits.approx === true ? "약 " : "";
    const amounts: Record<string, number> = {};
    const parts: string[] = [];
    for (const [kind, label] of Object.entries(AMOUNT_LABEL)) {
      const amount = credits[kind];
      if (typeof amount !== "number" || !(amount > 0)) continue;
      amounts[kind] = amount;
      parts.push(
        unit === "$"
          ? `${label} ${approx}$${amount}`
          : `${label} ${approx}${amount}${unit}`,
      );
    }
    return [
      {
        key: address.domain,
        name,
        ...address,
        offer: parts.join(", "),
        amounts,
      },
    ];
  });
}

function stations(body: string): RelayListEntry[] {
  const { stations: list } = JSON.parse(body) as { stations?: unknown };
  if (!Array.isArray(list)) return [];
  return list.flatMap((raw) => {
    const station = (raw ?? {}) as Record<string, unknown>;
    const address = siteAddress(station.url);
    const name = text(station.name, 80);
    if (!address || !name) return [];
    return [
      { key: address.domain, name, ...address, offer: text(station.quota) },
    ];
  });
}

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim());
const linkIn = (cell: string) =>
  /\]\((https?:\/\/[^)\s]+)\)/.exec(cell)?.[1] ??
  /https?:\/\/[^\s|)]+/.exec(cell)?.[0];
const cellText = (cell: string) =>
  plainText(cell.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1"), OFFER_MAX_CHARS);
const SEPARATOR = /^\|?\s*:?-{3,}/;

function tables(body: string): RelayListEntry[] {
  const lines = body.split("\n");
  const entries: RelayListEntry[] = [];
  for (let i = 0; i + 1 < lines.length; i += 1) {
    if (!lines[i]!.trim().startsWith("|") || !SEPARATOR.test(lines[i + 1]!))
      continue;
    const offerColumn = cells(lines[i]!).findIndex((cell) =>
      /额度|quota/i.test(cell),
    );
    let row = i + 2;
    for (; row < lines.length && lines[row]!.trim().startsWith("|"); row += 1) {
      if (offerColumn < 0) continue;
      const columns = cells(lines[row]!);
      const address = siteAddress(columns.map(linkIn).find(Boolean));
      const name = cellText(columns[0] ?? "");
      if (!address || !name) continue;
      entries.push({
        key: address.domain,
        name,
        ...address,
        offer: cellText(columns[offerColumn] ?? ""),
      });
    }
    i = row - 1;
  }
  return entries;
}

const PARSERS: Record<RelayListFormat, (body: string) => RelayListEntry[]> = {
  "welfare-hub": welfareHub,
  stations,
  table: tables,
};

export function parseRelayList(
  format: RelayListFormat,
  body: string,
): RelayListEntry[] {
  // A site listed twice keeps its first row.
  const seen = new Map<string, RelayListEntry>();
  for (const entry of PARSERS[format](body))
    if (!seen.has(entry.key)) seen.set(entry.key, entry);
  return [...seen.values()];
}

function readSnapshot(cursor: string | null): RelayListSnapshot | null {
  if (!cursor) return null;
  try {
    const value = JSON.parse(cursor) as Partial<RelayListSnapshot>;
    return value.entries && typeof value.entries === "object"
      ? (value as RelayListSnapshot)
      : null;
  } catch {
    return null;
  }
}

// Lists swap full-width and ASCII punctuation back and forth; only the words count.
const wording = (offer: string) => offer.replace(/[\s\p{P}]+/gu, "");

/** Whether a listed offer got better: a larger amount, or new wording that offers something. */
export function offerImproved(
  before: { offer: string; amounts?: Record<string, number> },
  after: RelayListEntry,
): boolean {
  if (after.amounts && before.amounts)
    return Object.entries(after.amounts).some(
      ([kind, amount]) => amount > (before.amounts![kind] ?? 0),
    );
  return (
    wording(after.offer) !== wording(before.offer) &&
    OFFER_WORDING.test(after.offer)
  );
}

const shortHash = (value: string) =>
  createHash("sha256").update(value).digest("hex").slice(0, 12);

/**
 * Someone else's list of free relay sites, compared with the previous run: a site
 * that appeared, or an offer that got better. The first run only records the list.
 * A new site's key is its domain alone, so the same site in two lists is one row.
 */
export class RelayListRoute {
  constructor(private readonly options: SourceHttpOptions = {}) {}

  async collect(
    source: RelayListSource,
    cursor: string | null,
  ): Promise<CandidateResult> {
    const { body } = await readSource(
      `https://raw.githubusercontent.com/${source.repository}/HEAD/${source.path}`,
      { Accept: "text/plain", "User-Agent": "rapi" },
      this.options,
    );
    const entries = parseRelayList(source.format, body);
    // An empty list is a changed format, and saving it would make everything new tomorrow.
    if (!entries.length)
      throw new Error(`${source.repository} lists no sites it can read`);
    const next: RelayListSnapshot = {
      entries: Object.fromEntries(
        entries.map((entry) => [
          entry.key,
          {
            offer: entry.offer,
            ...(entry.amounts ? { amounts: entry.amounts } : {}),
          },
        ]),
      ),
    };
    const seen = readSnapshot(cursor);
    if (!seen) return { candidates: [], cursor: JSON.stringify(next) };

    const candidates: DiscountCandidate[] = [];
    for (const entry of entries) {
      const before = seen.entries[entry.key];
      if (before && !offerImproved(before, entry)) continue;
      candidates.push({
        kind: "discount",
        route: "relay_list",
        dedupeKey: before
          ? `relay_list:${entry.key}:${shortHash(wording(entry.offer))}`
          : `relay_list:${entry.key}:new`,
        domain: entry.domain,
        title: entry.offer ? `${entry.name}: ${entry.offer}` : entry.name,
        url: entry.url,
        evidence: before
          ? `${source.repository} 목록에서 바뀜. 이전: ${before.offer || "없음"}`
          : `${source.repository} 목록에 새로 올라옴`,
        publishedAt: null,
      });
    }
    return {
      // A rewritten list is recorded as it now is, without a card for every row.
      candidates: candidates.length > RELAY_LIST_MAX_CHANGES ? [] : candidates,
      cursor: JSON.stringify(next),
    };
  }
}
