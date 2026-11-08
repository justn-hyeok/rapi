export type Visibility = "private" | "unlisted" | "public";

export interface SourceRecord {
  id: string;
  kind: "github" | "rss" | "html" | "webhook" | "aside" | "github_stars";
  locator: string;
  visibility: Visibility;
}

export interface RawInput {
  externalId: string | null;
  payload: unknown;
  collectedAt: Date;
}

export interface NormalizedItem {
  id: string;
  rawEventId: string;
  sourceId: string;
  normalizerVersion: string;
  canonicalUrl: string;
  title: string;
  body: string;
  author: string | null;
  publishedAt: Date | null;
  collectedAt: Date;
  visibility: Visibility;
  contentFingerprint: string;
  metadata: Record<string, unknown>;
  categories: string[];
}
