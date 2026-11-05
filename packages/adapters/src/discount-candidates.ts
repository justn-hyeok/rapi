import {
  discountEvidence,
  parseHtmlSourcePolicy,
  plainText,
  type DiscountCandidate,
  type DiscountCandidateKind,
  type ServicePage,
} from "@rapi/core";
import { publicFetch, type ResolveHostname } from "./public-fetch.js";
import {
  FeedSourceAdapter,
  HtmlSourceAdapter,
  parseServicePage,
  readSource,
  type ExternalItem,
  type SourceHttpOptions,
} from "./sources.js";

export interface CandidateResult {
  candidates: DiscountCandidate[];
  // Set when part of a source failed but the rest is still worth keeping.
  problem?: string;
  // What the next run compares against, for a source that says nothing about what changed.
  cursor?: string;
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
  // bodyChars: how far into an entry to look, when an offer sits low in long notes.
  | { format: "page"; entryStart: string; bodyChars?: number }
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
        const candidate = toCandidate(
          source.url,
          item,
          item.body,
          source.format === "page" ? source.bodyChars : undefined,
        );
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

function githubHeaders(token: string, accept: string): Record<string, string> {
  return {
    Accept: accept,
    "User-Agent": "rapi",
    "X-GitHub-Api-Version": "2022-11-28",
    Authorization: `Bearer ${token}`,
  };
}

// Checked against the 30 newest open models.dev PRs on 2026-11-05: it finds every
// PR that adds a provider.toml except one titled "update antling new models".
const ADDS_PROVIDER =
  /\badd(?:s|ing)?\b[^:]*\bproviders?\b|^feat\(providers?\):\s*add\b/i;
// One request a day: the newest page holds everything since the last run.
const PULL_REQUESTS_PER_RUN = 100;

export function addsProvider(title: string): boolean {
  return ADDS_PROVIDER.test(title);
}

/** Unmerged PRs that add a provider to a catalog repository. */
export class PullRequestRoute {
  constructor(
    private readonly token: string,
    private readonly options: SourceHttpOptions = {},
  ) {}

  async collect(repository: string): Promise<CandidateResult> {
    const { body } = await readSource(
      `https://api.github.com/repos/${repository}/pulls?state=open&sort=created&direction=desc&per_page=${PULL_REQUESTS_PER_RUN}`,
      githubHeaders(this.token, "application/vnd.github+json"),
      this.options,
    );
    const pulls = JSON.parse(body) as Array<{
      number: number;
      title: string;
      html_url: string;
      created_at: string;
      user?: { login?: string } | null;
    }>;
    return {
      candidates: pulls
        .filter((pull) => addsProvider(pull.title))
        .map((pull) => ({
          kind: "new_service",
          route: "pull_request",
          dedupeKey: `pull_request:${repository}#${pull.number}`,
          domain: null,
          title: plainText(pull.title, 300),
          url: pull.html_url,
          // The PR body is someone else's free text; the link leads to it.
          evidence: `${repository} PR #${pull.number}, ${pull.user?.login ?? "알 수 없음"}`,
          publishedAt: isoDate(pull.created_at),
        })),
    };
  }
}

const CODE_SEARCH_PER_QUERY = 100;
// Only an address written as the value of a base URL setting.
const BASE_URL_ADDRESS =
  /base_?url[^\n]{0,40}?(https?:\/\/[^\s"'`<>()[\]{},;$\\]+)/gi;
const REAL_HOSTNAME = /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i;
const PLACEHOLDER_HOSTNAME =
  /(?:^|[.-])(?:example|your[a-z]*|test|xxx+)(?:[.-]|$)|\.(?:internal|local|lan|invalid)$/i;
const API_PATH = /^(?:\/(?:[a-z][a-z-]{0,15}|v\d+[a-z0-9.]{0,8})){0,3}\/?$/i;

/**
 * The address alone: no credentials, query or fragment, and no path unless it
 * looks like an API path, because a key can sit in any of those.
 */
export function apiAddress(
  raw: string,
  denylist: readonly string[],
): { address: string; domain: string } | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const domain = url.hostname.toLowerCase();
  if (
    !REAL_HOSTNAME.test(domain) ||
    PLACEHOLDER_HOSTNAME.test(domain) ||
    denylist.some((name) => domain === name || domain.endsWith(`.${name}`))
  )
    return null;
  const path = API_PATH.test(url.pathname)
    ? url.pathname.replace(/\/$/, "")
    : "";
  return { address: `${url.protocol}//${url.host}${path}`, domain };
}

const SERVICE_PAGE_TIMEOUT_MS = 10_000;
const SERVICE_PAGE_MAX_BYTES = 1_000_000;

/**
 * The service's home page, or null when it cannot be read. The domain comes from
 * strangers' files, so every hop goes through publicFetch, only to port 443, and
 * no key or other credential is sent: these two headers are the whole request.
 */
export async function readServicePage(
  domain: string,
  options: SourceHttpOptions & { resolve?: ResolveHostname } = {},
): Promise<ServicePage | null> {
  const { resolve, ...http } = options;
  const guarded = {
    timeoutMs: SERVICE_PAGE_TIMEOUT_MS,
    maxBodyBytes: SERVICE_PAGE_MAX_BYTES,
    truncate: true,
    ...http,
    fetch: publicFetch(http.fetch, resolve),
  };
  // An API host rarely has a page of its own; the bare name usually does.
  const hosts = domain.startsWith("api.")
    ? [domain, domain.slice("api.".length)]
    : [domain];
  for (const host of hosts) {
    const url = `https://${host}/`;
    try {
      const { response, body } = await readSource(
        url,
        { Accept: "text/html", "User-Agent": "rapi" },
        guarded,
      );
      if (/html/i.test(response.headers.get("content-type") ?? ""))
        return parseServicePage(body, response.url || url);
    } catch {
      // Down, blocked or refused all read the same: this page was not seen.
    }
  }
  return null;
}

/** GitHub code search: API addresses people configure next to a model name. */
export class CodeSearchRoute {
  constructor(
    private readonly token: string,
    private readonly denylist: readonly string[],
    private readonly options: SourceHttpOptions = {},
  ) {}

  async collect(query: string): Promise<CandidateResult> {
    const { body } = await readSource(
      `https://api.github.com/search/code?q=${encodeURIComponent(query)}&per_page=${CODE_SEARCH_PER_QUERY}`,
      githubHeaders(this.token, "application/vnd.github.text-match+json"),
      this.options,
    );
    const { items } = JSON.parse(body) as {
      items: Array<{
        html_url: string;
        repository: { html_url: string };
        text_matches?: Array<{ fragment?: string }>;
      }>;
    };
    const found = new Map<string, DiscountCandidate>();
    for (const item of items)
      for (const match of item.text_matches ?? [])
        for (const [, raw] of (match.fragment ?? "").matchAll(
          BASE_URL_ADDRESS,
        )) {
          const api = apiAddress(raw!, this.denylist);
          if (!api || found.has(api.domain)) continue;
          // Public config files can hold keys: nothing else from the file is kept.
          found.set(api.domain, {
            kind: "new_service",
            route: "code_search",
            dedupeKey: `code_search:${api.domain}`,
            domain: api.domain,
            title: api.address,
            url: item.html_url,
            evidence: item.repository.html_url,
            publishedAt: null,
          });
        }
    return { candidates: [...found.values()] };
  }
}

export interface CatalogSource {
  providersUrl: string;
  modelsUrl: string;
  // A smaller drop is routing noise more often than a price cut.
  minPriceCutPercent: number;
}

interface CatalogSnapshot {
  providers: string[];
  free: string[];
  // Dollars per token as OpenRouter writes them: input, then output.
  prices: Record<string, [string, string]>;
}

// One model's price list is about 2 KB, and the whole list has to parse.
const CATALOG_MAX_BYTES = 5_000_000;

function readSnapshot(cursor: string | null): CatalogSnapshot | null {
  if (!cursor) return null;
  try {
    const value = JSON.parse(cursor) as Partial<CatalogSnapshot>;
    return value.providers && value.free && value.prices
      ? (value as CatalogSnapshot)
      : null;
  } catch {
    return null;
  }
}

const perMillion = (price: string) =>
  `$${Number((Number(price) * 1_000_000).toFixed(4))}`;

/** Whether nothing got dearer and something fell by at least the percent. */
export function isPriceCut(
  before: readonly [string, string],
  after: readonly [string, string],
  minPercent: number,
): boolean {
  const pairs = [0, 1].map((i) => [Number(before[i]), Number(after[i])]);
  // A router's own models say -1, and a price that was free cannot fall.
  if (pairs.some(([old, now]) => !(old! > 0) || !(now! > 0))) return false;
  return (
    pairs.every(([old, now]) => now! <= old!) &&
    pairs.some(([old, now]) => (old! - now!) / old! >= minPercent / 100)
  );
}

/**
 * OpenRouter's public lists, compared with the previous run: a new provider, a
 * new free model, a price that fell. The first run only records what is there,
 * or everything listed would read as new.
 */
export class CatalogRoute {
  constructor(private readonly options: SourceHttpOptions = {}) {}

  private async list<T>(url: string): Promise<T[]> {
    const { body } = await readSource(
      url,
      { Accept: "application/json", "User-Agent": "rapi" },
      { maxBodyBytes: CATALOG_MAX_BYTES, ...this.options },
    );
    const { data } = JSON.parse(body) as { data?: T[] };
    // An empty list is a broken answer, and saving it would make everything new tomorrow.
    if (!data?.length) throw new Error(`${url} returned an empty list`);
    return data;
  }

  async collect(
    source: CatalogSource,
    cursor: string | null,
  ): Promise<CandidateResult> {
    const providers = await this.list<{
      slug: string;
      name: string;
      privacy_policy_url?: string | null;
      terms_of_service_url?: string | null;
    }>(source.providersUrl);
    const models = await this.list<{
      id: string;
      name: string;
      expiration_date?: string | null;
      pricing?: { prompt?: string; completion?: string };
    }>(source.modelsUrl);
    const next: CatalogSnapshot = {
      providers: providers.map((provider) => provider.slug),
      free: models
        .filter((model) => model.id.endsWith(":free"))
        .map((model) => model.id),
      prices: Object.fromEntries(
        models.flatMap((model) =>
          model.pricing?.prompt && model.pricing.completion
            ? [[model.id, [model.pricing.prompt, model.pricing.completion]]]
            : [],
        ),
      ),
    };
    const seen = readSnapshot(cursor);
    if (!seen) return { candidates: [], cursor: JSON.stringify(next) };

    const candidates: DiscountCandidate[] = [];
    for (const provider of providers) {
      if (seen.providers.includes(provider.slug)) continue;
      const own = provider.privacy_policy_url ?? provider.terms_of_service_url;
      candidates.push({
        kind: "new_service",
        route: "catalog",
        dedupeKey: `catalog:provider:${provider.slug}`,
        domain: own ? hostname(own) : null,
        title: plainText(provider.name, 300),
        url: `https://openrouter.ai/provider/${encodeURIComponent(provider.slug)}`,
        evidence: "OpenRouter 제공사 목록에 새로 올라옴",
        publishedAt: null,
      });
    }
    for (const model of models) {
      const name = plainText(model.name, 280);
      const url = `https://openrouter.ai/${model.id}`;
      if (model.id.endsWith(":free") && !seen.free.includes(model.id))
        candidates.push({
          kind: "discount",
          route: "catalog",
          dedupeKey: `catalog:free:${model.id}`,
          domain: hostname(url),
          title: `${name} 무료 제공`,
          url,
          evidence: model.expiration_date
            ? `${model.expiration_date}까지`
            : "끝나는 날짜 없음",
          publishedAt: null,
        });
      const before = seen.prices[model.id];
      const after = next.prices[model.id];
      if (
        before &&
        after &&
        isPriceCut(before, after, source.minPriceCutPercent)
      )
        candidates.push({
          kind: "discount",
          route: "catalog",
          dedupeKey: `catalog:price:${model.id}:${after.join(":")}`,
          domain: hostname(url),
          title: `${name} 가격 인하`,
          url,
          evidence: `100만 토큰당 입력 ${perMillion(before[0])} → ${perMillion(after[0])}, 출력 ${perMillion(before[1])} → ${perMillion(after[1])}`,
          publishedAt: null,
        });
    }
    return { candidates, cursor: JSON.stringify(next) };
  }
}

export interface HackerNewsSource {
  discount: string[];
  newService: string[];
  maxAgeDays: number;
}

const HACKER_NEWS_SEARCH = "https://hn.algolia.com/api/v1/search_by_date";
const HACKER_NEWS_HITS = 20;
// The word for a price says nothing without something that sells tokens next to it.
const SELLS_TOKENS =
  /\b(?:llm|gpt|claude|gemini|deepseek|openai|anthropic|openrouter|inference|qwen|mistral|kimi|api|tokens?)\b|\bgpt-/i;
// Articles and repositories also say "LLM gateway"; these two offer the thing itself.
const OFFERS_A_SERVICE = /^show hn\b|\balternative\b/i;

/** Hacker News titles only: a story's body and comments mention everything. */
export class HackerNewsRoute {
  constructor(
    private readonly options: SourceHttpOptions = {},
    private readonly now: () => Date = () => new Date(),
  ) {}

  async collect(
    query: string,
    kind: DiscountCandidateKind,
    maxAgeDays: number,
  ): Promise<CandidateResult> {
    const since = Math.floor(
      (this.now().getTime() - maxAgeDays * 86_400_000) / 1000,
    );
    const params = new URLSearchParams({
      query,
      tags: "story",
      restrictSearchableAttributes: "title",
      numericFilters: `created_at_i>${since}`,
      hitsPerPage: String(HACKER_NEWS_HITS),
    });
    const { body } = await readSource(
      `${HACKER_NEWS_SEARCH}?${params}`,
      { Accept: "application/json", "User-Agent": "rapi" },
      this.options,
    );
    const { hits } = JSON.parse(body) as {
      hits: Array<{
        objectID: string;
        title: string;
        url?: string | null;
        points?: number | null;
        created_at: string;
      }>;
    };
    return {
      candidates: hits.flatMap((hit) => {
        const title = plainText(hit.title, 300);
        const fits =
          kind === "discount"
            ? SELLS_TOKENS.test(title) && discountEvidence(title, "")
            : OFFERS_A_SERVICE.test(title);
        if (!fits) return [];
        const url = hit.url?.startsWith("https:")
          ? hit.url
          : `https://news.ycombinator.com/item?id=${hit.objectID}`;
        const host = hostname(url);
        return [
          {
            kind,
            route: "hacker_news" as const,
            dedupeKey: `hacker_news:${hit.objectID}`,
            // A code host's home page says nothing about the service in the repository.
            domain:
              host === "github.com" || host === "news.ycombinator.com"
                ? null
                : host,
            title,
            url,
            evidence: `Hacker News ${hit.points ?? 0}점`,
            publishedAt: isoDate(hit.created_at),
          },
        ];
      }),
    };
  }
}
