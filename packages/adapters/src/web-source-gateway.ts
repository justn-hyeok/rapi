import type { ExternalItem, SourceGateway } from "@rapi/application";
import type { HtmlSourcePolicy } from "@rapi/domain";
import { GitHubStarRecommender } from "./github-stars.js";
import {
  FeedSource,
  GitHubEventSource,
  HtmlSource,
  parseFeed,
  parseGitHubEvent,
  type SourceHttpOptions,
} from "./sources.js";

/** Every configured source, read over HTTP. GitHub is read with the token when there is one. */
export class WebSourceGateway implements SourceGateway {
  private readonly feeds: FeedSource;
  private readonly pages: HtmlSource;
  private readonly events: GitHubEventSource;
  private readonly stars: GitHubStarRecommender;

  constructor(
    options: {
      githubToken?: string | undefined;
      http?: SourceHttpOptions;
    } = {},
  ) {
    this.feeds = new FeedSource(options.http);
    this.pages = new HtmlSource(options.http);
    this.events = new GitHubEventSource(options.githubToken, options.http);
    this.stars = new GitHubStarRecommender(options.githubToken, options.http);
  }

  feed(
    url: string,
    etag?: string,
    onPayload?: Parameters<SourceGateway["feed"]>[2],
  ) {
    return this.feeds.fetch(url, etag, onPayload);
  }

  html(
    url: string,
    policy: HtmlSourcePolicy,
    etag?: string,
    onPayload?: Parameters<SourceGateway["html"]>[3],
  ) {
    return this.pages.fetch(url, policy, etag, onPayload);
  }

  githubEvents(
    owner: string,
    repository: string,
    etag?: string,
    onPayload?: Parameters<SourceGateway["githubEvents"]>[3],
  ) {
    return this.events.fetchRepositoryEvents(
      owner,
      repository,
      etag,
      onPayload,
    );
  }

  recommendStars(
    user: string,
    exclude: ReadonlySet<string>,
  ): Promise<ExternalItem[]> {
    return this.stars.recommend(user, exclude);
  }

  parseFeed(xml: string): ExternalItem[] {
    return parseFeed(xml);
  }

  parseGitHubEvent(payload: Record<string, unknown>): ExternalItem {
    return parseGitHubEvent(payload);
  }
}
