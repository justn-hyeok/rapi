import type { HtmlSourcePolicy } from "@rapi/domain";

export interface SourcePayload {
  contentType: string;
  body: string;
}

export interface ExternalItem {
  externalId: string;
  url: string;
  title: string;
  body: string;
  author: string | null;
  publishedAt: string | null;
  metadata: Record<string, unknown>;
}

export type OnSourcePayload = (payload: SourcePayload) => Promise<void>;

export interface FetchedItems {
  items: ExternalItem[];
  etag?: string;
}

/** Where configured sources are read: feeds, HTML lists and GitHub. */
export interface SourceGateway {
  feed(
    url: string,
    etag?: string,
    onPayload?: OnSourcePayload,
  ): Promise<FetchedItems>;
  html(
    url: string,
    policy: HtmlSourcePolicy,
    etag?: string,
    onPayload?: OnSourcePayload,
  ): Promise<FetchedItems>;
  githubEvents(
    owner: string,
    repository: string,
    etag?: string,
    onPayload?: OnSourcePayload,
  ): Promise<FetchedItems>;
  /** Repositories like the ones `user` starred, minus `exclude`. */
  recommendStars(
    user: string,
    exclude: ReadonlySet<string>,
  ): Promise<ExternalItem[]>;
  /** Turns a raw feed body or GitHub event into items. */
  parseFeed(xml: string): ExternalItem[];
  parseGitHubEvent(payload: Record<string, unknown>): ExternalItem;
}
