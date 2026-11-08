import type { HtmlSourcePolicy } from "../domain/html-source.js";

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

export interface FeedReader {
  fetch(
    url: string,
    etag?: string,
    onPayload?: OnSourcePayload,
  ): Promise<FetchedItems>;
}

export interface HtmlReader {
  fetch(
    url: string,
    policy: HtmlSourcePolicy,
    etag?: string,
    onPayload?: OnSourcePayload,
  ): Promise<FetchedItems>;
}

export interface GitHubEventReader {
  fetchRepositoryEvents(
    owner: string,
    repository: string,
    etag?: string,
    onPayload?: OnSourcePayload,
  ): Promise<FetchedItems>;
}

export interface StarRecommender {
  recommend(
    user: string,
    exclude: ReadonlySet<string>,
  ): Promise<ExternalItem[]>;
}

/** Turns a raw feed body or GitHub event into items. */
export interface SourceParsers {
  feed(xml: string): ExternalItem[];
  githubEvent(payload: Record<string, unknown>): ExternalItem;
}
