import { readFile } from "node:fs/promises";
import type {
  CandidateJob,
  DiscountCandidateKind,
  KnownOperator,
  ServicePages,
} from "@rapi/domain";
import { type CommitLogSource, CommitLogRoute } from "./commit-logs.js";
import { curlFetch } from "./curl-fetch.js";
import {
  CatalogRoute,
  ChangelogRoute,
  CodeSearchRoute,
  CommunityRoute,
  CreditFeedRoute,
  HackerNewsRoute,
  PullRequestRoute,
  readServicePage,
  type CatalogSource,
  type ChangelogSource,
  type FeedOfferSource,
  type HackerNewsSource,
} from "./discount-candidates.js";
import { type PromoClockSource, PromoClockRoute } from "./promoclock.js";
import type { ResolveHostname } from "./public-fetch.js";
import { type RelayListSource, RelayListRoute } from "./relay-lists.js";
import { type RelaySiteSource, RelaySiteRoute } from "./relay-sites.js";
import { siteOffer } from "./site-offers.js";
import type { SourceHttpOptions } from "./sources.js";

/** config/discount-sources.json: where discount candidates are looked for. */
export interface DiscountSources {
  changelogs: ChangelogSource[];
  pullRequests: { repository: string };
  codeSearch: { queries: string[]; denylist: string[] };
  catalog?: CatalogSource;
  hackerNews?: HackerNewsSource;
  creditFeed?: FeedOfferSource;
  communities?: FeedOfferSource[];
  relayLists?: RelayListSource[];
  freeLists?: RelayListSource[];
  commitLogs?: CommitLogSource[];
  promoClock?: PromoClockSource;
  relaySites?: RelaySiteSource[];
  operators: KnownOperator[];
}

export async function loadDiscountSources(
  root: string,
): Promise<DiscountSources> {
  return JSON.parse(
    await readFile(`${root}/config/discount-sources.json`, "utf8"),
  ) as DiscountSources;
}

const NO_TOKEN = "GITHUB_READ_TOKEN이 없어 건너뜀";

/** Every source in the list as a job; a GitHub route without a token is skipped. */
export function discountCandidateJobs(input: {
  sources: DiscountSources;
  githubToken?: string | undefined;
  http?: SourceHttpOptions;
  now?: () => Date;
}): CandidateJob[] {
  const { sources, githubToken: token, http } = input;
  const changelog = new ChangelogRoute(http, input.now);
  const pullRequests = token && new PullRequestRoute(token, http);
  const codeSearch =
    token && new CodeSearchRoute(token, sources.codeSearch.denylist, http);
  const catalogJob = (source: CatalogSource) => ({
    kind: "candidate_catalog",
    locator: source.modelsUrl,
    collect: async (cursor: () => Promise<string | null>) =>
      new CatalogRoute(http).collect(source, await cursor()),
  });
  const hackerNewsJobs = (source: HackerNewsSource) => {
    const route = new HackerNewsRoute(http, input.now);
    const job = (kind: DiscountCandidateKind) => (query: string) => ({
      kind: "candidate_hacker_news",
      locator: query,
      collect: () => route.collect(query, kind, source.maxAgeDays),
    });
    return [
      ...source.discount.map(job("discount")),
      ...source.newService.map(job("new_service")),
    ];
  };
  const creditFeedJob = (source: FeedOfferSource) => ({
    kind: "candidate_credit_feed",
    locator: source.url,
    collect: () => new CreditFeedRoute(http, input.now).collect(source),
  });
  const communityJob = (source: FeedOfferSource) => ({
    kind: "candidate_community",
    locator: source.url,
    collect: () =>
      new CommunityRoute(
        source.client === "curl" ? { ...http, fetch: curlFetch() } : http,
        input.now,
      ).collect(source),
  });
  const listJob =
    (route: "relay_list" | "free_list") => (source: RelayListSource) => ({
      kind: `candidate_${route}`,
      locator: `${source.repository}/${source.path}`,
      collect: async (cursor: () => Promise<string | null>) =>
        new RelayListRoute(http).collect(source, await cursor(), route),
    });
  const promoClockJob = (source: PromoClockSource) => ({
    kind: "candidate_promoclock",
    locator: source.url,
    collect: async (cursor: () => Promise<string | null>) =>
      new PromoClockRoute(http).collect(source, await cursor()),
  });
  const relaySiteJob = (source: RelaySiteSource) => ({
    kind: "candidate_relay_site",
    locator: source.url,
    collect: async (cursor: () => Promise<string | null>) =>
      new RelaySiteRoute(http).collect(source, await cursor()),
  });
  const commitLogJob = (source: CommitLogSource) => ({
    kind: "candidate_commit_log",
    locator: source.repository,
    collect: async (cursor: () => Promise<string | null>) =>
      new CommitLogRoute(token, http).collect(source, await cursor()),
  });
  return [
    ...sources.changelogs.map((source) => ({
      kind: "candidate_changelog",
      locator: source.url,
      collect: () => changelog.collect(source),
    })),
    {
      kind: "candidate_pull_request",
      locator: sources.pullRequests.repository,
      ...(pullRequests
        ? {
            collect: () =>
              pullRequests.collect(sources.pullRequests.repository),
          }
        : { skipped: NO_TOKEN }),
    },
    ...sources.codeSearch.queries.map((query) => ({
      kind: "candidate_code_search",
      locator: query,
      ...(codeSearch
        ? { collect: () => codeSearch.collect(query) }
        : { skipped: NO_TOKEN }),
    })),
    ...(sources.catalog ? [catalogJob(sources.catalog)] : []),
    ...(sources.hackerNews ? hackerNewsJobs(sources.hackerNews) : []),
    ...(sources.creditFeed ? [creditFeedJob(sources.creditFeed)] : []),
    ...(sources.communities ?? []).map(communityJob),
    ...(sources.relayLists ?? []).map(listJob("relay_list")),
    ...(sources.freeLists ?? []).map(listJob("free_list")),
    ...(sources.commitLogs ?? []).map(commitLogJob),
    ...(sources.promoClock ? [promoClockJob(sources.promoClock)] : []),
    ...(sources.relaySites ?? []).map(relaySiteJob),
  ];
}

/** Reads a service's own pages, refusing addresses that are not public. */
export function servicePages(
  http: SourceHttpOptions & { resolve?: ResolveHostname } = {},
): ServicePages {
  return {
    read: (domain) => readServicePage(domain, http),
    offer: (domain, page) => siteOffer(domain, page, http),
  };
}
