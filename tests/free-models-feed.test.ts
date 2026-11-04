import assert from "node:assert/strict";
import test from "node:test";
import {
  CARD_COLORS,
  CommunityFeeds,
  messageBody,
} from "../packages/agent/src/community-feeds.js";

type Embed = {
  title: string;
  description: string;
  url?: string;
  color: number;
  author?: { name: string };
};

function harness(catalog: unknown, openRouter: unknown[] = []) {
  const keys = new Set<string>();
  /** Every card saved, in order. */
  const posts: Embed[] = [];
  const sent: string[] = [];
  const pinned: string[] = [];
  const waiting = new Map<string, { feed: string; embeds: Embed[] }>();
  const refused = new Set<string>();
  const marks = new Map<string, Date>();
  const state = { catalog, openRouter };
  const store = {
    communityPostKeys: async (prefix: string) =>
      [...keys].filter((key) => key.startsWith(prefix)),
    communityPostExists: async (key: string) => keys.has(key),
    recordCommunityPost: async (post: { key: string }) => {
      keys.add(post.key);
    },
    deleteCommunityMarkers: async (gone: string[]) => {
      for (const key of gone) keys.delete(key);
    },
    managedDiscordResourceId: async () => "channel",
    saveCommunityDraft: async (draft: {
      key: string;
      feed: string;
      embeds: Embed[];
    }) => {
      if (keys.has(draft.key)) return;
      keys.add(draft.key);
      posts.push(draft.embeds[0]!);
      waiting.set(draft.key, draft);
    },
    communityCardQueue: async (feed: string, prefix: string, limit: number) =>
      [...waiting.entries()]
        .filter(([key, d]) => d.feed === feed && key.startsWith(prefix))
        .map(([key]) => key)
        .slice(0, limit),
    communityDraft: async (key: string) => {
      const draft = waiting.get(key);
      return draft ? { key, ...draft, created: new Date(0) } : null;
    },
    settleCommunityDraft: async (key: string) => waiting.delete(key),
    lastCommunityPostAt: async (feed: string, prefix: string) => {
      const last = [...keys]
        .filter((key) => key.startsWith(prefix))
        .map((key) => new Date(key.slice(prefix.length)).getTime())
        .sort((a, b) => b - a)[0];
      return last ? new Date(last) : null;
    },
  };
  const feeds = new CommunityFeeds(store as never, undefined, {
    guildId: "g",
    owner: "o",
    autoPost: { "free-tokens": true },
    post: async (_channel, embeds) => {
      const title = (embeds[0] as Embed).title;
      if (refused.has(title)) throw new Error("Discord returned 400");
      sent.push(title);
      return "m";
    },
    pin: async (_channel, messageId) => {
      pinned.push(messageId);
    },
    getJson: async (url) =>
      url.includes("openrouter") ? { data: state.openRouter } : state.catalog,
  });
  return { feeds, keys, posts, sent, pinned, refused, waiting, marks, state };
}

const model = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id.toUpperCase(),
  cost: { input: 0, output: 0 },
  tool_call: true,
  ...extra,
});
const zen = (...models: Array<ReturnType<typeof model>>) => ({
  opencode: {
    models: Object.fromEntries(models.map((m) => [m.id, m])),
  },
});

test("each free model of a first list gets its own card, not new for learners", async () => {
  const { feeds, keys, posts } = harness(zen(model("a"), model("b")));
  await feeds.freeCatalogModels();
  assert.deepEqual(posts.map((p) => p.title).sort(), ["A", "B"]);
  assert.equal(posts[0]!.author?.name, "OpenCode Zen");
  assert.equal(posts[0]!.url, "https://opencode.ai/docs/zen/");
  assert.equal(posts[0]!.color, CARD_COLORS.safe);
  assert.match(posts[0]!.description, /사용법: OpenCode/);
  assert.match(posts[0]!.description, /#무료$/);
  assert.ok(keys.has("free-seen:opencode:a"));
  assert.ok(![...keys].some((key) => key.startsWith("free-model:")));
  await feeds.freeCatalogModels();
  assert.equal(posts.length, 2);
});

test("paid, deprecated and tool-less models are not announced", async () => {
  const { feeds, posts } = harness(
    zen(
      model("keep"),
      model("paid", { cost: { input: 1, output: 0 } }),
      model("nocost", { cost: undefined }),
      model("old", { status: "deprecated" }),
      model("embed", { tool_call: false }),
    ),
  );
  await feeds.freeCatalogModels();
  assert.equal(posts.length, 1);
  assert.match(posts[0]!.description, /`keep`/);
});

test("coding-plan providers are ignored even when every row is $0", async () => {
  const { feeds, posts } = harness({
    "alibaba-coding-plan": { models: { a: model("a") } },
  });
  await feeds.freeCatalogModels();
  assert.equal(posts.length, 0);
});

test("a later model is new for learners, and an ended one waits for a second check", async () => {
  const { feeds, keys, posts, state } = harness(
    zen(model("a"), model("b"), model("c")),
  );
  await feeds.freeCatalogModels();
  state.catalog = zen(model("a"), model("c"), model("d"));
  await feeds.freeCatalogModels();
  assert.equal(posts.length, 4);
  assert.equal(posts[3]!.title, "D");
  assert.ok(keys.has("free-model:opencode:d"));
  state.catalog = zen(model("a"), model("c"), model("d"), model("e"));
  await feeds.freeCatalogModels();
  assert.deepEqual(
    posts.slice(4).map((p) => p.title),
    ["E", "b 무료 종료"],
  );
  assert.equal(posts[5]!.color, CARD_COLORS.neutral);
  await feeds.freeCatalogModels();
  assert.equal(posts.length, 6);
});

test("a list that collapses is treated as a catalog problem, not mass ending", async () => {
  const { feeds, posts, state } = harness(
    zen(model("a"), model("b"), model("c"), model("d"), model("e")),
  );
  await feeds.freeCatalogModels();
  state.catalog = zen(model("a"));
  await feeds.freeCatalogModels();
  state.catalog = {};
  await feeds.freeCatalogModels();
  assert.equal(posts.length, 5);
});

test("OpenRouter's existing markers keep working next to catalog markers", async () => {
  const free = (id: string) => ({
    id,
    supported_parameters: ["tools"],
    pricing: { prompt: "0", completion: "0" },
  });
  const { feeds, keys, posts, state } = harness({}, [free("x/a:free")]);
  keys.add("free-model:x/a:free");
  keys.add("free-model:opencode:z");
  await feeds.freeModels();
  assert.equal(posts.length, 0, "catalog markers must not read as ended");
  state.openRouter = [free("x/a:free"), free("x/b:free")];
  await feeds.freeModels();
  assert.equal(posts[0]!.author?.name, "OpenRouter");
  assert.equal(posts[0]!.title, "x/b:free");
  assert.ok(keys.has("free-model:x/b:free"));
});

test("OpenRouter cards say what a model can do and when it stops being free", async () => {
  const { feeds, posts } = harness({}, [
    {
      id: "x/a:free",
      name: "A",
      context_length: 262144,
      supported_parameters: ["tools"],
      expiration_date: "2026-12-31",
      pricing: { prompt: "0", completion: "0" },
    },
    {
      id: "google/lyria",
      pricing: { prompt: "0", completion: "0" },
    },
  ]);
  await feeds.freeModels();
  assert.equal(posts.length, 1);
  assert.equal(posts[0]!.title, "A");
  assert.match(posts[0]!.description, /컨텍스트 262K · 2026-12-31까지 무료/);
  assert.match(posts[0]!.description, /`x\/a:free`/);
});

test("a known tool-less model still free is not reported as ended", async () => {
  const { feeds, keys, posts } = harness({}, [
    {
      id: "google/lyria",
      pricing: { prompt: "0", completion: "0" },
    },
  ]);
  keys.add("free-model:google/lyria");
  await feeds.freeModels();
  assert.equal(posts.length, 0);
});

test("a model missing from one response only is never reported", async () => {
  const { feeds, posts, state } = harness(zen(model("a"), model("b")));
  await feeds.freeCatalogModels();
  state.catalog = zen(model("a"));
  await feeds.freeCatalogModels();
  state.catalog = zen(model("a"), model("b"));
  await feeds.freeCatalogModels();
  state.catalog = zen(model("a"));
  await feeds.freeCatalogModels();
  assert.equal(posts.length, 2, "two separate misses are not two in a row");
});

test("a model that came back can be reported as ended again", async () => {
  const { feeds, keys, posts, state } = harness(zen(model("a"), model("b")));
  keys.add("free-model-ended:opencode:b");
  keys.add("free-seen:opencode:b");
  await feeds.freeCatalogModels();
  assert.ok(!keys.has("free-model-ended:opencode:b"));
  state.catalog = zen(model("a"));
  await feeds.freeCatalogModels();
  await feeds.freeCatalogModels();
  assert.equal(posts.at(-1)!.title, "b 무료 종료");
});

const batch = (i: number) => new Date(Date.UTC(2026, 10, 4, i));

test("a long queue goes out five cards an hour, oldest first", async () => {
  const { feeds, sent, state } = harness({});
  state.catalog = zen(...Array.from({ length: 7 }, (_, i) => model(`m${i}`)));
  await feeds.freeCatalogModels();
  await feeds.sendQueuedCards(batch(1));
  const cards = sent.filter((title) => title !== "띠 색깔 보는 법");
  assert.deepEqual(cards, ["M0", "M1", "M2", "M3", "M4"]);
  await feeds.sendQueuedCards(new Date(batch(1).getTime() + 59 * 60_000));
  assert.equal(sent.filter((t) => t !== "띠 색깔 보는 법").length, 5);
  await feeds.sendQueuedCards(batch(2));
  assert.equal(sent.filter((t) => t !== "띠 색깔 보는 법").length, 7);
});

test("the legend goes out once before the first batch and is pinned", async () => {
  const { feeds, sent, pinned, state } = harness({});
  state.catalog = zen(model("a"));
  await feeds.freeCatalogModels();
  await feeds.sendQueuedCards(batch(1));
  assert.deepEqual(sent, ["띠 색깔 보는 법", "A"]);
  assert.deepEqual(pinned, ["m"]);
  state.catalog = zen(model("a"), model("b"));
  await feeds.freeCatalogModels();
  await feeds.sendQueuedCards(batch(2));
  assert.deepEqual(sent, ["띠 색깔 보는 법", "A", "B"]);
});

test("a card Discord refuses stays queued and does not block the next", async () => {
  const { feeds, sent, refused, waiting, state } = harness({});
  state.catalog = zen(model("a"), model("b"));
  refused.add("A");
  await feeds.freeCatalogModels();
  await assert.rejects(feeds.sendQueuedCards(batch(1)), /400/);
  assert.ok(sent.includes("B"));
  assert.deepEqual([...waiting.keys()], ["card:free-model:opencode:a"]);
  refused.clear();
  await feeds.sendQueuedCards(batch(2));
  assert.ok(sent.includes("A"));
  assert.equal(waiting.size, 0);
});

test("nothing waiting leaves no batch marker behind", async () => {
  const { feeds, keys } = harness({});
  await feeds.sendQueuedCards(batch(1));
  assert.equal(keys.size, 0);
});

test("a single card gets a source button; a message of several does not", () => {
  const body = messageBody([{ title: "t", url: "https://x.example/a" }]);
  assert.deepEqual(body.components, [
    {
      type: 1,
      components: [
        { type: 2, style: 5, label: "원문 보기", url: "https://x.example/a" },
      ],
    },
  ]);
  assert.equal(
    messageBody([
      { url: "https://x.example/a" },
      { url: "https://x.example/b" },
    ]).components,
    undefined,
  );
  assert.equal(messageBody([{ title: "no link" }]).components, undefined);
});
