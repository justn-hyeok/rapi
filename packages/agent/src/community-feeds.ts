import { readFile } from "node:fs/promises";
import {
  readSource,
  type CurationChannel,
  type ItemSummarizer,
  type SummaryInput,
} from "@rapi/adapters";
import {
  findCitations,
  isFreeTokenNews,
  isOldStory,
  kstDateKey,
  kstReached,
  plainText,
  selectBlogItems,
  selectFeedTargets,
  type CitationCandidate,
  type FeedGuildTarget,
} from "@rapi/core";
import type { PostgresStore } from "@rapi/db";

type Feed = "ai-blogs" | "free-tokens";
type Embed = Record<string, unknown>;

export const CURATION_CHANNELS: Record<Feed, string> = {
  "ai-blogs": "curation_ai_blogs",
  "free-tokens": "curation_free_tokens",
};

const clip = (value: string, limit: number) => {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
};

/** Public model catalog with per-provider prices; about 6 MB. */
const MODEL_CATALOG_URL = "https://models.dev/api.json";

interface FreeProvider {
  /** Marker scope; OpenRouter keeps the unscoped markers it already has. */
  id?: string;
  label: string;
  url: string;
  use: string;
  caution: string;
}

const OPENROUTER: FreeProvider = {
  label: "OpenRouter",
  url: "https://openrouter.ai/models?max_price=0",
  use: "OpenRouter API 키로 호출. [사용 제한 보기](https://openrouter.ai/docs/api-reference/limits)",
  caution:
    "스텔스 모델은 정체가 공개되지 않았어요. 민감한 내용은 넣지 마세요. 무료 조건은 예고 없이 바뀔 수 있어요.",
};

/**
 * Providers whose $0 prices mean free to anyone. The catalog also lists coding
 * plans at $0 because a subscription covers them, so this is not every $0 row.
 */
const FREE_CATALOG_PROVIDERS: Array<FreeProvider & { id: string }> = [
  {
    id: "opencode",
    label: "OpenCode Zen",
    url: "https://opencode.ai/docs/zen/",
    use: "OpenCode에서 골라 쓰거나 Zen API 키로 호출",
    caution:
      "기간 한정 무료예요. 일부 모델은 무료 기간에 입력을 모델 개선에 쓸 수 있으니 문서의 Privacy를 확인하세요.",
  },
  {
    id: "nvidia",
    label: "NVIDIA NIM",
    url: "https://build.nvidia.com/models",
    use: "build.nvidia.com API 키로 호출",
    caution: "체험용이에요. 사용 기록이 남으니 개인정보나 기밀은 넣지 마세요.",
  },
];
/** A channel gets this many cards at a time, so a long queue never floods it. */
const CARDS_PER_BATCH = 5;
const CARD_BATCH_INTERVAL = 3_600_000;
/** Cards wait under this key prefix and go out in batches. */
const CARD_PREFIX = "card:";
/** The colour bar says how far to trust what a card offers. */
export const CARD_COLORS = {
  safe: 0x2ecc71,
  ambiguous: 0xf1c40f,
  risky: 0xe74c3c,
  neutral: 0x80848e,
} as const;
const LEGEND_KEY = "free-tokens:legend";
// More than the card shows: the model drops some before the per-source cap.
const AI_BLOG_CANDIDATES_PER_SOURCE = 8;
const HANGUL = /[가-힣]/;

interface FreeModel {
  id: string;
  name?: string | undefined;
  context_length?: number | undefined;
  tools?: boolean | undefined;
  /** Last free day, when the provider has announced one. */
  expires?: string | null | undefined;
}

/** A summary worth showing without a model: Korean, and more than the title again. */
function usableSummary(summary: string, title: string): string {
  const text = clip(plainText(summary, 400) || summary, 130);
  return HANGUL.test(text) &&
    !text.toLowerCase().startsWith(title.slice(0, 30).toLowerCase())
    ? text
    : "";
}

/** One item in one Discord embed: source, linked title, details, then tags. */
function card(input: {
  source?: string;
  title: string;
  url?: string;
  lines: string[];
  tags?: string[];
  footer?: string;
  color: number;
}): Embed {
  return {
    ...(input.source ? { author: { name: clip(input.source, 200) } } : {}),
    title: clip(input.title, 240),
    ...(input.url ? { url: input.url } : {}),
    description: [
      ...input.lines,
      ...(input.tags?.length ? [input.tags.join(" ")] : []),
    ]
      .filter(Boolean)
      .join("\n")
      .slice(0, 3900),
    ...(input.footer ? { footer: { text: input.footer } } : {}),
    color: input.color,
  };
}

const contextSize = (tokens: number) =>
  tokens >= 1_000_000
    ? `${Math.round(tokens / 100_000) / 10}M`
    : `${Math.round(tokens / 1000)}K`;

/** The Discord request body; a one-card message gets a button to its source. */
export function messageBody(embeds: Embed[]): {
  embeds: Embed[];
  components?: unknown[];
  allowed_mentions: { parse: string[] };
} {
  const url = embeds.length === 1 ? embeds[0]!.url : undefined;
  return {
    embeds,
    ...(typeof url === "string" && url.length <= 512
      ? {
          components: [
            {
              type: 1,
              components: [{ type: 2, style: 5, label: "원문 보기", url }],
            },
          ],
        }
      : {}),
    allowed_mentions: { parse: [] },
  };
}

export interface CommunityFeedOptions {
  guildId: string;
  /** Feeds whose waiting cards go out by themselves. */
  autoPost?: Partial<Record<Feed, boolean>>;
  /** Other allowed guilds that receive the feeds too; absent means only `guildId`. */
  guildTargets?: () => Promise<FeedGuildTarget[]>;
  /** Posts one Discord message and returns its id. */
  post(channelId: string, embeds: Embed[]): Promise<string>;
  /** Pins a message; failing is only a missing convenience. */
  pin?(channelId: string, messageId: string): Promise<void>;
  getJson?: (url: string, accept?: string) => Promise<unknown>;
  getText?: (url: string, accept?: string) => Promise<string>;
}

/** The curation channels: AI blogs and free tokens. */
export class CommunityFeeds {
  private readonly getText: (url: string, accept?: string) => Promise<string>;
  private readonly getJson: (url: string, accept?: string) => Promise<unknown>;

  constructor(
    private readonly store: PostgresStore,
    private readonly summarizer: ItemSummarizer | undefined,
    private readonly options: CommunityFeedOptions,
  ) {
    this.getText =
      options.getText ??
      (async (url, accept = "application/json") =>
        (
          await readSource(
            url,
            {
              "User-Agent": "rapi",
              Accept: accept,
            },
            url === MODEL_CATALOG_URL
              ? { timeoutMs: 60_000, maxBodyBytes: 16_000_000 }
              : { timeoutMs: 20_000, maxBodyBytes: 4_000_000 },
          )
        ).body);
    this.getJson =
      options.getJson ??
      (async (url, accept) =>
        JSON.parse(await this.getText(url, accept)) as unknown);
  }

  private async channel(
    feed: Feed,
    guildId = this.options.guildId,
  ): Promise<string | null> {
    return this.store.managedDiscordResourceId(
      guildId,
      "channel",
      CURATION_CHANNELS[feed],
    );
  }

  /**
   * Sends a post that went to the community guild to every other allowed
   * guild that has the feed's channel, once per guild. A failing guild never
   * affects the others or the main post, and is not retried.
   */
  private async fanOut(
    feed: Feed,
    key: string,
    embeds: Embed[],
    createdAt: Date,
  ): Promise<void> {
    if (!this.options.guildTargets) return;
    const sent = new Set<string>();
    const guilds = (await this.options.guildTargets()).filter(
      (guild) => guild.guildId !== this.options.guildId,
    );
    for (const guild of guilds)
      if (await this.store.communityGuildPostSent(guild.guildId, key))
        sent.add(guild.guildId);
    for (const guildId of selectFeedTargets(createdAt, guilds, sent)) {
      try {
        const channelId = await this.channel(feed, guildId);
        if (!channelId) continue;
        const messageId = await this.options.post(channelId, embeds);
        await this.store.recordCommunityGuildPost({
          guildId,
          key,
          channelId,
          messageId: messageId || null,
        });
      } catch {
        // Another guild's failure must not block the rest.
      }
    }
  }

  /** Saves one card to go out with a later batch, once per key. */
  private async enqueue(feed: Feed, key: string, embed: Embed): Promise<void> {
    await this.store.saveCommunityDraft({
      key: `${CARD_PREFIX}${key}`,
      feed,
      title: typeof embed.title === "string" ? embed.title : key,
      embeds: [embed],
    });
  }

  /** Says once, in the pinned message, what the colour bar means. */
  private async postLegend(now: Date): Promise<void> {
    if (await this.store.communityPostExists(LEGEND_KEY)) return;
    const channelId = await this.channel("free-tokens");
    if (!channelId) return;
    const embeds = [
      card({
        title: "띠 색깔 보는 법",
        lines: [
          "🟢 운영 주체 확인됨",
          "🟡 재판매 또는 출처 불분명",
          "🔴 문제 확인됨",
        ],
        color: CARD_COLORS.neutral,
      }),
    ];
    const messageId = await this.options.post(channelId, embeds);
    await this.store.recordCommunityPost({
      key: LEGEND_KEY,
      feed: "free-tokens",
      channelId,
      messageId,
      data: {},
    });
    await this.fanOut("free-tokens", LEGEND_KEY, embeds, now);
    try {
      await this.options.pin?.(channelId, messageId);
    } catch (error) {
      process.stderr.write(
        `Legend pin failed: ${error instanceof Error ? error.message.slice(0, 200) : "unknown"}\n`,
      );
    }
  }

  /**
   * Sends the oldest waiting cards of each automatic feed, a batch an hour. A
   * card Discord refuses stays queued without holding back the ones after it.
   */
  async sendQueuedCards(now: Date): Promise<void> {
    const failures: string[] = [];
    for (const feed of Object.keys(CURATION_CHANNELS) as Feed[]) {
      if (!this.options.autoPost?.[feed]) continue;
      const keys = await this.store.communityCardQueue(
        feed,
        CARD_PREFIX,
        CARDS_PER_BATCH,
      );
      if (!keys.length) continue;
      if (!(await this.due(feed, CARD_BATCH_INTERVAL, now, `${feed}:cards:`)))
        continue;
      if (feed === "free-tokens") await this.postLegend(now);
      for (const key of keys) {
        try {
          await this.sendDraft(key);
        } catch (error) {
          failures.push(
            `${key}: ${error instanceof Error ? error.message : "failed"}`,
          );
        }
      }
    }
    if (failures.length) throw new Error(failures.join("; "));
  }

  /** Sends a waiting card to its channel, once. */
  async sendDraft(key: string): Promise<{ ok: boolean; message: string }> {
    const draft = await this.store.communityDraft(key);
    if (!draft) return { ok: false, message: "이미 보냈거나 없는 초안입니다." };
    const channelId = await this.channel(draft.feed as Feed);
    if (!channelId)
      return { ok: false, message: "채널이 아직 만들어지지 않았습니다." };
    const messageId = await this.options.post(
      channelId,
      draft.embeds as Embed[],
    );
    await this.store.settleCommunityDraft(key, "posted", channelId, messageId);
    await this.fanOut(
      draft.feed as Feed,
      key,
      draft.embeds as Embed[],
      draft.created,
    );
    return { ok: true, message: "채널에 보냈습니다." };
  }

  /** Runs every feed that is due; one failing feed never blocks the others. */
  async runOnce(now = new Date()): Promise<string[]> {
    const failures: string[] = [];
    const run = async (name: string, work: () => Promise<unknown>) => {
      try {
        await work();
      } catch (error) {
        failures.push(
          `${name}: ${error instanceof Error ? error.message : "failed"}`,
        );
      }
    };
    if (kstReached(now, 9)) await run("ai-blogs", () => this.aiBlogs(now));
    if (await this.due("free-tokens", 6 * 3_600_000, now, "free-models:")) {
      await run("free-models", () => this.freeModels());
      await run("free-catalog", () => this.freeCatalogModels());
    }
    if (kstReached(now, 9, 5)) await run("free-news", () => this.freeNews(now));
    await run("cards", () => this.sendQueuedCards(now));
    return failures;
  }

  /** A periodic feed is due when its last check marker is older than the interval. */
  private async due(
    feed: Feed,
    interval: number,
    now: Date,
    prefix = `${feed}:check:`,
  ): Promise<boolean> {
    const last = await this.store.lastCommunityPostAt(feed, prefix);
    if (last && now.getTime() - last.getTime() < interval) return false;
    await this.store.recordCommunityPost({
      key: `${prefix}${now.toISOString()}`,
      feed,
      channelId: null,
      messageId: null,
      data: {},
    });
    return true;
  }

  /** The model's picks; null when it is missing or failed, so the post goes out without it. */
  private async curate(
    channel: CurationChannel,
    items: SummaryInput[],
  ): Promise<Map<string, string> | null> {
    if (!this.summarizer?.curate) return null;
    try {
      return await this.summarizer.curate(items, channel);
    } catch (error) {
      process.stderr.write(
        `Curation ${channel} model failed, posting without it: ${error instanceof Error ? error.message.slice(0, 200) : "unknown"}\n`,
      );
      return null;
    }
  }

  private async markChecked(feed: Feed, key: string): Promise<void> {
    await this.store.recordCommunityPost({
      key,
      feed,
      channelId: null,
      messageId: null,
      data: {},
    });
  }

  async aiBlogs(now: Date): Promise<void> {
    const key = `ai-blogs:${kstDateKey(now)}`;
    if (await this.store.communityPostExists(key)) return;
    const official = await this.store.officialItems(
      new Date(now.getTime() - 26 * 3_600_000),
    );
    if (!official.length) return;
    const others: CitationCandidate[] = await this.store.citationCandidates(
      new Date(now.getTime() - 7 * 86_400_000),
    );
    const candidates = selectBlogItems(official, AI_BLOG_CANDIDATES_PER_SOURCE);
    const curated = await this.curate(
      "ai-blogs",
      candidates.map((item) => ({
        id: item.id,
        title: item.title,
        url: item.url,
        body: item.summary,
      })),
    );
    const chosen = selectBlogItems(
      curated ? candidates.filter((item) => curated.has(item.id)) : candidates,
    );
    for (const item of chosen) {
      const cited = findCitations(item, others).slice(0, 3);
      const title = clip(plainText(item.title, 300) || item.title, 110);
      const summary =
        curated?.get(item.id) ?? usableSummary(item.summary, title);
      await this.enqueue(
        "ai-blogs",
        `ai-blog:${item.id}`,
        card({
          source: item.source,
          title,
          url: item.url,
          lines: [
            summary,
            cited.length
              ? `-# 다룬 곳 ${cited.length} · ${cited
                  .map((c) => `[${clip(c.source, 24)}](${c.url})`)
                  .join(" · ")}`
              : "",
          ],
          color: CARD_COLORS.neutral,
        }),
      );
    }
    // Settled even when every post was judged off-topic: no new model call today.
    await this.markChecked("ai-blogs", key);
  }

  async freeModels(): Promise<void> {
    const models =
      (
        (await this.getJson("https://openrouter.ai/api/v1/models")) as {
          data?: Array<{
            id: string;
            name?: string;
            context_length?: number;
            expiration_date?: string | null;
            supported_parameters?: string[];
            pricing?: { prompt?: string; completion?: string };
          }>;
        }
      ).data ?? [];
    await this.syncFreeModels(
      OPENROUTER,
      models
        .filter(
          (m) => m.pricing?.prompt === "0" && m.pricing.completion === "0",
        )
        .map((m) => ({
          id: m.id,
          name: m.name,
          context_length: m.context_length,
          tools: m.supported_parameters?.includes("tools"),
          expires: m.expiration_date,
        })),
    );
  }

  /** The free models of other providers, read from one public catalog. */
  async freeCatalogModels(): Promise<void> {
    const catalog = (await this.getJson(
      MODEL_CATALOG_URL,
      "application/json",
    )) as Record<
      string,
      | {
          models?: Record<
            string,
            {
              id: string;
              name?: string;
              status?: string | null;
              tool_call?: boolean;
              release_date?: string;
              cost?: { input?: number; output?: number };
              limit?: { context?: number };
            }
          >;
        }
      | undefined
    >;
    for (const provider of FREE_CATALOG_PROVIDERS) {
      const free = Object.values(catalog[provider.id]?.models ?? {})
        .filter(
          (m) =>
            m.cost?.input === 0 &&
            m.cost.output === 0 &&
            m.status !== "deprecated",
        )
        .sort((a, b) =>
          (b.release_date ?? "").localeCompare(a.release_date ?? ""),
        )
        .map((m) => ({
          id: m.id,
          name: m.name,
          context_length: m.limit?.context,
          tools: m.tool_call,
        }));
      await this.syncFreeModels(provider, free);
    }
  }

  /**
   * Posts what changed since the last look at one provider's free list. Its
   * first list is posted once as a whole, under markers the learner issue does
   * not count as new. An empty or much shorter list is treated as a catalog
   * problem, not as every model's free period ending. Only models that can
   * call tools are announced: the rest are guard, embedding, detection or music
   * models that bill per song, which nobody can code with.
   */
  private async syncFreeModels(
    provider: FreeProvider,
    free: FreeModel[],
  ): Promise<void> {
    if (!free.length) return;
    const scope = provider.id ? `${provider.id}:` : "";
    const otherScopes = FREE_CATALOG_PROVIDERS.map((p) => `${p.id}:`);
    const ids = async (prefix: string) =>
      (await this.store.communityPostKeys(prefix))
        .map((key) => key.slice(prefix.length))
        .filter((id) => scope || !otherScopes.some((s) => id.startsWith(s)));
    const seen = new Set([
      ...(await ids(`free-model:${scope}`)),
      ...(await ids(`free-seen:${scope}`)),
    ]);
    const first = seen.size === 0;
    const mark = (key: string, name: string) =>
      this.store.recordCommunityPost({
        key,
        feed: "free-tokens",
        channelId: null,
        messageId: null,
        data: { name },
      });
    const usable = free.filter((m) => m.tools);
    const fresh = usable.filter((m) => !seen.has(m.id));
    for (const model of fresh) {
      await this.enqueue(
        "free-tokens",
        `free-model:${scope}${model.id}`,
        card({
          source: provider.label,
          title: model.name ?? model.id,
          url: provider.url,
          lines: [
            [
              ...(model.context_length
                ? [`컨텍스트 ${contextSize(model.context_length)}`]
                : []),
              ...(model.expires ? [`${model.expires}까지 무료`] : []),
            ].join(" · "),
            `사용법: ${provider.use}`,
            `-# \`${model.id}\``,
          ],
          tags: ["#무료"],
          footer: provider.caution,
          color: CARD_COLORS.safe,
        }),
      );
      await mark(
        `${first && provider.id ? "free-seen" : "free-model"}:${scope}${model.id}`,
        model.name ?? model.id,
      );
    }
    const current = new Set(free.map((m) => m.id));
    const reported = new Set(await ids(`free-model-ended:${scope}`));
    const missing = new Set(await ids(`free-model-missing:${scope}`));
    // A model that came back can end again, and a one-off miss no longer counts.
    await this.store.deleteCommunityMarkers([
      ...[...reported]
        .filter((id) => current.has(id))
        .map((id) => `free-model-ended:${scope}${id}`),
      ...[...missing]
        .filter((id) => current.has(id))
        .map((id) => `free-model-missing:${scope}${id}`),
    ]);
    const gone =
      free.length * 2 < seen.size
        ? []
        : [...seen].filter((id) => !current.has(id) && !reported.has(id));
    // One response can be partial, so a model ends after two checks in a row.
    const ended = gone.filter((id) => missing.has(id));
    for (const id of gone)
      if (!missing.has(id)) await mark(`free-model-missing:${scope}${id}`, id);
    for (const id of ended) {
      await this.enqueue(
        "free-tokens",
        `free-ended:${scope}${id}:${kstDateKey(new Date())}`,
        card({
          source: provider.label,
          title: `${id} 무료 종료`,
          url: provider.url,
          lines: ["더 이상 무료로 쓸 수 없어요."],
          color: CARD_COLORS.neutral,
        }),
      );
      await mark(`free-model-ended:${scope}${id}`, id);
    }
  }

  async freeNews(now: Date): Promise<void> {
    const key = `free-news:${kstDateKey(now)}`;
    if (await this.store.communityPostExists(key)) return;
    const matches = (
      await this.store.citationCandidates(
        new Date(now.getTime() - 26 * 3_600_000),
        true,
      )
    )
      .filter((item) => isFreeTokenNews(item.title, item.body))
      .filter((item) => !isOldStory(item.title, now));
    if (!matches.length) return;
    const curated = await this.curate(
      "free-tokens",
      matches.slice(0, 20).map((item) => ({
        id: item.id,
        title: item.title,
        url: item.url,
        body: item.body,
      })),
    );
    const items = curated
      ? matches.filter((item) => curated.has(item.id))
      : matches;
    for (const item of items.slice(0, 10))
      await this.enqueue(
        "free-tokens",
        `free-news:${item.id}`,
        card({
          source: item.source,
          title: plainText(item.title, 200) || item.title,
          url: item.url,
          lines: [curated?.get(item.id) ?? ""],
          tags: ["#무료"],
          color: CARD_COLORS.neutral,
        }),
      );
    await this.markChecked("free-tokens", key);
  }
}

/** Builds the feeds from config/curation in a release root, posting as the bot. */
export async function createCommunityFeeds(input: {
  store: PostgresStore;
  summarizer: ItemSummarizer | undefined;
  guildId: string;
  /** Guilds from DISCORD_ALLOWED_GUILD_IDS; approved guilds are read from the database. */
  extraGuildIds?: readonly string[];
  botToken: string;
  root: string;
}): Promise<CommunityFeeds> {
  let config: {
    autoPost?: Partial<Record<Feed, boolean>>;
  } = {};
  try {
    config = JSON.parse(
      await readFile(`${input.root}/config/curation/feeds.json`, "utf8"),
    ) as typeof config;
  } catch {
    // Without a config no card goes out.
  }
  return new CommunityFeeds(input.store, input.summarizer, {
    guildId: input.guildId,
    guildTargets: async () => {
      const targets = new Map<string, FeedGuildTarget>();
      for (const guildId of input.extraGuildIds ?? [])
        targets.set(guildId, { guildId, allowedSince: null });
      for (const guild of await input.store.allowedDiscordGuilds())
        if (!targets.has(guild.guildId))
          targets.set(guild.guildId, {
            guildId: guild.guildId,
            allowedSince: guild.allowedAt,
          });
      return [...targets.values()];
    },
    ...(config.autoPost ? { autoPost: config.autoPost } : {}),
    post: async (channelId, embeds) => {
      const response = await fetch(
        `https://discord.com/api/v10/channels/${channelId}/messages`,
        {
          method: "POST",
          headers: {
            authorization: `Bot ${input.botToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(messageBody(embeds)),
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (!response.ok) throw new Error(`Discord returned ${response.status}`);
      const message = (await response.json()) as { id?: unknown };
      return typeof message.id === "string" ? message.id : "";
    },
    pin: async (channelId, messageId) => {
      const response = await fetch(
        `https://discord.com/api/v10/channels/${channelId}/messages/pins/${messageId}`,
        {
          method: "PUT",
          headers: { authorization: `Bot ${input.botToken}` },
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (!response.ok) throw new Error(`Discord returned ${response.status}`);
    },
  });
}
