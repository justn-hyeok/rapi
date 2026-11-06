import { plainText, type DiscountCandidate } from "@rapi/core";
import type { CandidateResult } from "./discount-candidates.js";
import { readSource, type SourceHttpOptions } from "./sources.js";

/** A relay site built on new-api, whose /api/status and /api/pricing are public. */
export interface RelaySiteSource {
  name: string;
  url: string;
  // False when the price list needs a login: then only the status is compared.
  pricing?: boolean;
}

interface SiteSnapshot {
  // Sign-up and referral bonuses in dollars.
  bonus: { invitee: number | null; inviter: number | null };
  // Per model: the ratio and completion ratio, or the price per call.
  models: Record<string, [number, number]>;
  groups: Record<string, number>;
  notices: string[];
}

// A smaller drop is a relay rounding its ratios more often than a sale.
const MIN_CUT_PERCENT = 20;
// More changes than this in a day reads as a site rebuilt, not as news.
export const RELAY_SITE_MAX_CHANGES = 8;
// Notices worth a card give something away or make it cheaper. Not "倍率翻倍"
// (the ratio doubled) or "限量" (rationed), which take something away.
const OFFER_NOTICE =
  /送|赠|免费|限免|白嫖|折扣|打\s*\d+(?:\.\d+)?\s*折|降价|优惠|福利|兑换码|半价|不限量|低倍率|倍率.{0,6}(?:下调|降低|减半)|free|discount|% off|half price/i;

// "Free users" names a plan the site already had, not something given away.
const FREE_PLAN = /免费(?:用户|版|会员|账号|分组)/g;
const offersSomething = (text: string) =>
  OFFER_NOTICE.test(text.replace(FREE_PLAN, ""));

const asNumber = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

function dollars(quota: unknown, perUnit: unknown): number | null {
  const amount = asNumber(quota);
  const unit = asNumber(perUnit);
  return amount !== null && unit
    ? Math.round((amount / unit) * 100) / 100
    : null;
}

function readSnapshot(cursor: string | null): SiteSnapshot | null {
  if (!cursor) return null;
  try {
    const value = JSON.parse(cursor) as Partial<SiteSnapshot>;
    return value.bonus && value.models && value.groups && value.notices
      ? (value as SiteSnapshot)
      : null;
  } catch {
    return null;
  }
}

/** Whether nothing rose and something fell by at least the percent. */
function isCut(before: readonly number[], after: readonly number[]): boolean {
  if (before.some((old, i) => after[i]! > old)) return false;
  return before.some(
    (old, i) => old > 0 && (old - after[i]!) / old >= MIN_CUT_PERCENT / 100,
  );
}

const isFree = (price: readonly number[]) => price[0] === 0;

// The line that offers something, without markdown marks or emoji: a notice's
// own first line is often just "important notice".
function headline(content: string): string {
  const lines = content
    .split("\n")
    .map((line) =>
      plainText(
        line
          .replace(/[#*_`>]+/g, " ")
          .replace(/\p{Extended_Pictographic}/gu, ""),
        120,
      ),
    )
    .filter(Boolean);
  return lines.find(offersSomething) ?? lines[0] ?? "";
}

/**
 * A relay site's public status and price list, compared with the previous run: a
 * larger sign-up or referral bonus, a ratio that fell, a model or group that
 * became free, and a new notice that offers something. The first run records.
 */
export class RelaySiteRoute {
  constructor(private readonly options: SourceHttpOptions = {}) {}

  private async json<T>(url: string): Promise<T> {
    const { body } = await readSource(
      url,
      { Accept: "application/json", "User-Agent": "rapi" },
      this.options,
    );
    const parsed = JSON.parse(body) as { success?: boolean } & T;
    if (parsed.success === false) throw new Error(`${url} answered no success`);
    return parsed;
  }

  async collect(
    source: RelaySiteSource,
    cursor: string | null,
  ): Promise<CandidateResult> {
    const base = source.url.replace(/\/+$/, "");
    const { data: status } = await this.json<{
      data?: {
        quota_for_invitee?: unknown;
        quota_for_inviter?: unknown;
        quota_per_unit?: unknown;
        announcements?: Array<{ content?: string; publishDate?: string }>;
      };
    }>(`${base}/api/status`);
    if (!status) throw new Error(`${base}/api/status has no data`);
    const pricing =
      source.pricing === false
        ? {}
        : await this.json<{
            data?: Array<{
              model_name?: string;
              quota_type?: number;
              model_ratio?: number;
              completion_ratio?: number;
              model_price?: number;
            }>;
            group_ratio?: Record<string, unknown>;
          }>(`${base}/api/pricing`);

    const next: SiteSnapshot = {
      bonus: {
        invitee: dollars(status.quota_for_invitee, status.quota_per_unit),
        inviter: dollars(status.quota_for_inviter, status.quota_per_unit),
      },
      models: Object.fromEntries(
        (pricing.data ?? []).flatMap((model) => {
          if (!model.model_name) return [];
          const price =
            model.quota_type === 1
              ? [asNumber(model.model_price), 0]
              : [asNumber(model.model_ratio), asNumber(model.completion_ratio)];
          return price.every((value) => value !== null)
            ? [[model.model_name, price as [number, number]]]
            : [];
        }),
      ),
      groups: Object.fromEntries(
        Object.entries(pricing.group_ratio ?? {}).flatMap(([group, ratio]) =>
          asNumber(ratio) === null ? [] : [[group, ratio as number]],
        ),
      ),
      notices: (status.announcements ?? []).flatMap((notice) =>
        notice.publishDate ? [notice.publishDate] : [],
      ),
    };
    const seen = readSnapshot(cursor);
    if (!seen) return { candidates: [], cursor: JSON.stringify(next) };

    const host = new URL(base).hostname;
    const url = `https://${host}/`;
    const candidates: DiscountCandidate[] = [];
    const add = (key: string, title: string, evidence: string) =>
      candidates.push({
        kind: "discount",
        route: "relay_site",
        dedupeKey: `relay_site:${host}:${key}`,
        domain: host,
        title: `${source.name}: ${title}`,
        url,
        evidence,
        publishedAt: null,
      });

    for (const who of ["invitee", "inviter"] as const) {
      const before = seen.bonus[who];
      const after = next.bonus[who];
      if (after !== null && after > (before ?? 0))
        add(
          `bonus:${who}:${after}`,
          `${who === "invitee" ? "초대받아 가입하면" : "초대하면"} $${after}`,
          `이전: ${before === null ? "없음" : `$${before}`}`,
        );
    }
    for (const [model, after] of Object.entries(next.models)) {
      const before = seen.models[model];
      if (isFree(after) && (!before || !isFree(before)))
        add(`free:${model}:${after.join(":")}`, `${model} 무료`, "배율 0");
      else if (before && isCut(before, after))
        add(
          `ratio:${model}:${after.join(":")}`,
          `${model} 배율 인하`,
          `배율 ${before[0]} → ${after[0]}, 출력 배율 ${before[1]} → ${after[1]}`,
        );
    }
    for (const [group, after] of Object.entries(next.groups)) {
      const before = seen.groups[group];
      if (after === 0 && before !== 0)
        add(`group:${group}:0`, `${group} 그룹 무료`, "그룹 배율 0");
      else if (before !== undefined && isCut([before], [after]))
        add(
          `group:${group}:${after}`,
          `${group} 그룹 배율 인하`,
          `그룹 배율 ${before} → ${after}`,
        );
    }
    for (const notice of status.announcements ?? []) {
      const content = notice.content ?? "";
      if (!notice.publishDate || seen.notices.includes(notice.publishDate))
        continue;
      if (!offersSomething(content)) continue;
      add(
        `notice:${notice.publishDate}`,
        headline(content) || "공지",
        plainText(content, 600),
      );
    }
    return {
      // A rebuilt site is recorded as it now is, without a card for every row.
      candidates: candidates.length > RELAY_SITE_MAX_CHANGES ? [] : candidates,
      cursor: JSON.stringify(next),
    };
  }
}
