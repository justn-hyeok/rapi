import type {
  HtmlSourcePolicy,
  NormalizedItem,
  Visibility,
} from "@rapi/domain";

export interface RawEventResult {
  id: string;
  inserted: boolean;
}

export interface SourceStore {
  createSource(
    kind: string,
    locator: string,
    visibility: Visibility,
    policy?: Record<string, unknown>,
  ): Promise<string>;
  sourceVisibility(sourceId: string): Promise<Visibility>;
  insertRawEvent(
    sourceId: string,
    externalId: string | null,
    checksum: string,
    payload: unknown,
    collectedAt: Date,
  ): Promise<RawEventResult>;
  sourceCursor(sourceId: string): Promise<string | null>;
  saveCursor(
    sourceId: string,
    cursor: string | null,
    etag: string | null,
  ): Promise<void>;
  recordSourceFailure(sourceId: string, message: string): Promise<void>;
  saveItem(
    item: NormalizedItem,
    summary: string,
  ): Promise<{ id: string; inserted: boolean }>;
  sourceStatus(): Promise<Record<string, unknown>[]>;
  collectableSources(): Promise<
    {
      id: string;
      kind: string;
      locator: string;
      collection_policy: unknown;
      etag: string | null;
      last_success_at: Date | null;
    }[]
  >;
  sourceExternalIds(sourceId: string): Promise<string[]>;
}

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
