import { randomUUID } from "node:crypto";
export { DEFAULT_CODEX_MODEL as DEFAULT_SUMMARY_MODEL } from "@rapi/domain";
import type {
  ExternalItem,
  FeedReader,
  GitHubEventReader,
  HtmlReader,
  SourceParsers,
  SourcePayload,
  SourceStore,
  StarRecommender,
  Visibility,
} from "@rapi/domain";
import {
  canonicalizeUrl,
  parseHtmlSourcePolicy,
  plainText,
  checksumPayload,
  classify,
  contentFingerprint,
  summarize,
} from "@rapi/domain";

// A feed URL that embeds a credential (e.g. GitHub's private dashboard feed)
// is stored as `env:NAME` so the secret stays in the service environment and
// out of the database, status commands and raw payloads.
export function resolveFeedLocator(
  locator: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  if (!locator.startsWith("env:")) return locator;
  const name = locator.slice(4);
  if (!/^[A-Z][A-Z0-9_]*_FEED_URL$/.test(name))
    throw new Error("Feed locator environment name must end with _FEED_URL");
  const value = environment[name];
  if (!value?.startsWith("https://"))
    throw new Error(`${name} must be an https URL`);
  return value;
}

export function redactUrlTokens(body: string): string {
  return body.replace(
    /([?&](?:token|access_token)=)[^&"'<>\s]+/g,
    "$1REDACTED",
  );
}

export class RapiAgent {
  constructor(
    readonly store: SourceStore,
    private readonly parse: SourceParsers,
  ) {}

  createSource(
    kind: "github" | "rss" | "html" | "webhook" | "aside" | "github_stars",
    locator: string,
    visibility: Visibility,
    policy?: Record<string, unknown>,
  ): Promise<string> {
    return this.store.createSource(kind, locator, visibility, policy);
  }

  async ingestExternalItem(
    sourceId: string,
    item: ExternalItem,
    collectedAt = new Date(),
  ): Promise<{ itemId: string; inserted: boolean }> {
    const payload = { ...item };
    const raw = await this.store.insertRawEvent(
      sourceId,
      item.externalId || null,
      checksumPayload(payload),
      payload,
      collectedAt,
    );
    const visibility = await this.store.sourceVisibility(sourceId);
    const normalized = {
      id: randomUUID(),
      rawEventId: raw.id,
      sourceId,
      normalizerVersion: "source-v1",
      canonicalUrl: canonicalizeUrl(item.url),
      title: plainText(item.title, 300) || item.title.trim(),
      body: item.body.trim(),
      author: item.author,
      publishedAt: item.publishedAt ? new Date(item.publishedAt) : null,
      collectedAt,
      visibility,
      contentFingerprint: contentFingerprint(item.title, item.body),
      metadata: item.metadata,
      categories: classify(item.title, item.body),
    };
    const saved = await this.store.saveItem(normalized, summarize(normalized));
    return { itemId: saved.id, inserted: raw.inserted && saved.inserted };
  }

  async ingestFeed(
    sourceId: string,
    xml: string,
    collectedAt = new Date(),
  ): Promise<number> {
    await this.persistSourcePayload(
      sourceId,
      { contentType: "application/xml", body: xml },
      collectedAt,
    );
    let inserted = 0;
    for (const item of this.parse.feed(xml)) {
      const result = await this.ingestExternalItem(sourceId, item, collectedAt);
      if (result.inserted) inserted += 1;
    }
    await this.store.saveCursor(sourceId, collectedAt.toISOString(), null);
    return inserted;
  }

  async ingestGitHub(
    sourceId: string,
    payloads: Record<string, unknown>[],
    collectedAt = new Date(),
  ): Promise<number> {
    await this.persistSourcePayload(
      sourceId,
      { contentType: "application/json", body: JSON.stringify(payloads) },
      collectedAt,
    );
    let inserted = 0;
    for (const payload of payloads) {
      const result = await this.ingestExternalItem(
        sourceId,
        this.parse.githubEvent(payload),
        collectedAt,
      );
      if (result.inserted) inserted += 1;
    }
    await this.store.saveCursor(sourceId, collectedAt.toISOString(), null);
    return inserted;
  }

  async collectIndependently(
    jobs: Array<{ sourceId: string; collect: () => Promise<void> }>,
  ): Promise<void> {
    await Promise.all(
      jobs.map(async (job) => {
        try {
          await job.collect();
        } catch (error) {
          await this.store.recordSourceFailure(
            job.sourceId,
            error instanceof Error ? error.message : "Unknown collection error",
          );
        }
      }),
    );
  }

  async collectConfiguredSources(
    feed: FeedReader,
    github: GitHubEventReader,
    stars: StarRecommender | undefined,
    html: HtmlReader,
  ): Promise<void> {
    const sources = await this.store.collectableSources();
    await this.collectIndependently(
      sources.map((source) => ({
        sourceId: source.id,
        collect: async () => {
          if (source.kind === "rss" || source.kind === "html") {
            const secret = source.locator.startsWith("env:");
            const locator = resolveFeedLocator(source.locator);
            const result = await this.withFailureSnapshot(
              source.id,
              (onPayload) =>
                source.kind === "html"
                  ? html.fetch(
                      locator,
                      parseHtmlSourcePolicy(source.collection_policy),
                      source.etag ?? undefined,
                      onPayload,
                    )
                  : feed.fetch(locator, source.etag ?? undefined, onPayload),
              secret,
            );
            for (const item of result.items)
              await this.ingestExternalItem(source.id, item);
            await this.store.saveCursor(
              source.id,
              new Date().toISOString(),
              result.etag ?? null,
            );
            return;
          }
          if (source.kind === "github_stars") {
            if (!stars)
              throw new Error("GitHub star recommendations are not configured");
            // Recommendations are a daily digest, not a polled stream.
            if (
              source.last_success_at &&
              Date.now() - new Date(source.last_success_at).getTime() <
                20 * 3_600_000
            )
              return;
            const exclude = new Set(
              await this.store.sourceExternalIds(source.id),
            );
            for (const item of await stars.recommend(source.locator, exclude))
              await this.ingestExternalItem(source.id, item);
            await this.store.saveCursor(
              source.id,
              new Date().toISOString(),
              null,
            );
            return;
          }
          if (source.kind !== "github") return;
          const [owner, repository] = source.locator.split("/");
          if (!owner || !repository)
            throw new Error("GitHub source locator must be owner/repository");
          const result = await this.withFailureSnapshot(
            source.id,
            (onPayload) =>
              github.fetchRepositoryEvents(
                owner,
                repository,
                source.etag ?? undefined,
                onPayload,
              ),
          );
          for (const item of result.items)
            await this.ingestExternalItem(source.id, item);
          await this.store.saveCursor(
            source.id,
            new Date().toISOString(),
            result.etag ?? null,
          );
        },
      })),
    );
  }

  // The fetch hands over the raw response before parsing. A response that
  // parses is already stored item by item (keyed by external id), so keeping
  // the whole body too would add a row per poll whenever the body carries a
  // changing value such as a build time. Only a response that fails is kept.
  private async withFailureSnapshot<T>(
    sourceId: string,
    run: (onPayload: (payload: SourcePayload) => Promise<void>) => Promise<T>,
    redact = false,
  ): Promise<T> {
    let received: SourcePayload | undefined;
    try {
      return await run(async (payload) => {
        received = payload;
      });
    } catch (error) {
      if (received)
        await this.persistSourcePayload(
          sourceId,
          redact
            ? { ...received, body: redactUrlTokens(received.body) }
            : received,
        ).catch(() => undefined);
      throw error;
    }
  }

  private async persistSourcePayload(
    sourceId: string,
    payload: SourcePayload,
    collectedAt = new Date(),
  ): Promise<void> {
    await this.store.insertRawEvent(
      sourceId,
      null,
      checksumPayload(payload),
      payload,
      collectedAt,
    );
  }
}
