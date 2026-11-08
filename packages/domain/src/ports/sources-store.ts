import type { NormalizedItem, Visibility } from "../domain/models.js";

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
