import {
  discountEvidence,
  parseHtmlSourcePolicy,
  plainText,
  type DiscountCandidate,
} from "@rapi/core";
import {
  FeedSourceAdapter,
  HtmlSourceAdapter,
  readSource,
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
