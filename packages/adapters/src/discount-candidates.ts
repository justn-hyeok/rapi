import {
  discountEvidence,
  parseHtmlSourcePolicy,
  plainText,
  type DiscountCandidate,
} from "@rapi/core";
import {
  FeedSourceAdapter,
  HtmlSourceAdapter,
  type ExternalItem,
  type SourceHttpOptions,
} from "./sources.js";

export interface CandidateResult {
  candidates: DiscountCandidate[];
  // Set when part of a source failed but the rest is still worth keeping.
  problem?: string;
}

function hostname(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function isoDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

export type ChangelogSource = {
  url: string;
  // Entries older than this are not news, and a first run should not backfill years.
  maxAgeDays: number;
} & (
  | { format: "feed" }
  | { format: "page"; entryStart: string }
  | {
      // A list with no prices in its titles: read the recent articles themselves.
      format: "list";
      html: unknown;
      maxArticles: number;
      articleChars: number;
    }
);

// A feed longer than this keeps its newest part. parseFeed accepts up to 2 MB.
const CHANGELOG_MAX_BYTES = 1_900_000;

/** Official changelogs: records entries whose wording says discount. */
export class ChangelogRoute {
  private readonly feed: FeedSourceAdapter;
  private readonly html: HtmlSourceAdapter;

  constructor(
    options: SourceHttpOptions = {},
    private readonly now: () => Date = () => new Date(),
  ) {
    const limits = {
      maxBodyBytes: CHANGELOG_MAX_BYTES,
      truncate: true,
      ...options,
    };
    this.feed = new FeedSourceAdapter(limits);
    this.html = new HtmlSourceAdapter(limits);
  }

  async collect(source: ChangelogSource): Promise<CandidateResult> {
    if (source.format === "list") return this.collectList(source);
    const items =
      source.format === "feed"
        ? (await this.feed.fetch(source.url)).items
        : await this.html.fetchEntries(source.url, source.entryStart);
    return {
      candidates: this.recent(items, source.maxAgeDays).flatMap((item) => {
        const candidate = toCandidate(source.url, item, item.body);
        return candidate ? [candidate] : [];
      }),
    };
  }

  private recent(items: ExternalItem[], maxAgeDays: number): ExternalItem[] {
    const oldest = this.now().getTime() - maxAgeDays * 86_400_000;
    return items.filter((item) => {
      const published = isoDate(item.publishedAt);
      return !published || new Date(published).getTime() >= oldest;
    });
  }

  private async collectList(
    source: Extract<ChangelogSource, { format: "list" }>,
  ): Promise<CandidateResult> {
    const { items } = await this.html.fetch(
      source.url,
      parseHtmlSourcePolicy({ html: source.html }),
    );
    // The list page is not in date order, and undated items cannot be called recent.
    const articles = this.recent(
      items.filter((item) => item.publishedAt),
      source.maxAgeDays,
    )
      .sort((a, b) => b.publishedAt!.localeCompare(a.publishedAt!))
      .slice(0, source.maxArticles);
    const candidates: DiscountCandidate[] = [];
    const problems: string[] = [];
    for (const item of articles) {
      try {
        const body = await this.html.fetchArticle(item.url);
        const candidate = toCandidate(
          source.url,
          item,
          body,
          source.articleChars,
        );
        if (candidate) candidates.push(candidate);
      } catch (error) {
        problems.push(
          `${item.url}: ${error instanceof Error ? error.message : "failed"}`,
        );
      }
    }
    return {
      candidates,
      ...(problems.length ? { problem: problems.join("; ") } : {}),
    };
  }
}

function toCandidate(
  sourceUrl: string,
  item: ExternalItem,
  body: string,
  bodyChars?: number,
): DiscountCandidate | null {
  const title = plainText(item.title, 300);
  // Decode the markup first so the character window counts words people read.
  const evidence = discountEvidence(title, plainText(body, 4000), bodyChars);
  if (!evidence) return null;
  const url = item.url || sourceUrl;
  return {
    kind: "discount",
    route: "changelog",
    dedupeKey: `changelog:${item.externalId || url}`,
    domain: hostname(url),
    title,
    url,
    evidence,
    publishedAt: isoDate(item.publishedAt),
  };
}
