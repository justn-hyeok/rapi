import assert from "node:assert/strict";
import test from "node:test";
import { CommunityFeeds } from "../packages/agent/src/community-feeds.js";

test("each AI blog post gets its own card without markup or entities", async () => {
  const drafts: Array<{ key: string; embeds: Array<Record<string, unknown>> }> =
    [];
  const marked: string[] = [];
  const store = {
    communityPostExists: async () => false,
    officialItems: async () => [
      {
        id: "1",
        source: "Example",
        title: "It&#8217;s <b>new</b>",
        url: "https://example.com/a",
        summary: "<p>소개 &lt;img src=x&gt; 문장</p>",
      },
      {
        id: "2",
        source: "Example",
        title: "Second post",
        url: "https://example.com/b",
        summary: "",
      },
    ],
    citationCandidates: async () => [],
    saveCommunityDraft: async (draft: {
      key: string;
      embeds: Array<Record<string, unknown>>;
    }) => {
      drafts.push(draft);
    },
    recordCommunityPost: async (post: { key: string }) => {
      marked.push(post.key);
    },
  };
  const feeds = new CommunityFeeds(store as never, undefined, {
    guildId: "g",
    post: async () => "m",
    getText: async () => {
      throw new Error("no network in tests");
    },
  });
  await feeds.aiBlogs(new Date("2026-10-27T01:00:00Z"));
  assert.deepEqual(
    drafts.map((d) => d.key),
    ["card:ai-blog:1", "card:ai-blog:2"],
  );
  const embed = drafts[0]!.embeds[0]!;
  assert.deepEqual(embed.author, { name: "Example" });
  assert.equal(embed.title, "It’s new");
  assert.equal(embed.url, "https://example.com/a");
  assert.equal(embed.description, "소개 문장");
  assert.deepEqual(marked, ["ai-blogs:2026-10-27"]);
});

const blogFeeds = (
  summarizer: unknown,
  items: Array<Record<string, string>>,
  sink: {
    drafts: Array<{ embeds: Array<Record<string, string>> }>;
    marked: string[];
  },
) =>
  new CommunityFeeds(
    {
      communityPostExists: async () => false,
      officialItems: async () => items,
      citationCandidates: async () => [],
      saveCommunityDraft: async (draft: {
        embeds: Array<Record<string, string>>;
      }) => {
        sink.drafts.push(draft);
      },
      recordCommunityPost: async (post: { key: string }) => {
        sink.marked.push(post.key);
      },
    } as never,
    summarizer as never,
    {
      guildId: "g",
      post: async () => "m",
      getText: async () => {
        throw new Error("no network in tests");
      },
    },
  );
const blogItem = (id: string, summary = "English excerpt of the post") => ({
  id,
  source: "Vendor",
  title: `Post ${id}`,
  url: `https://example.com/${id}`,
  summary,
});
const now = new Date("2026-10-27T01:00:00Z");

test("the model's Korean summary is shown and its rejects are dropped", async () => {
  const sink = { drafts: [], marked: [] };
  await blogFeeds(
    {
      policy: "t",
      summarize: async () => new Map(),
      curate: async () => new Map([["a", "새 도구를 쓸 수 있게 됐어요."]]),
    },
    [blogItem("a"), blogItem("b")],
    sink,
  ).aiBlogs(now);
  const text = JSON.stringify(sink.drafts);
  assert.equal(sink.drafts.length, 1);
  assert.match(text, /새 도구를 쓸 수 있게 됐어요/);
  assert.doesNotMatch(text, /Post b|English excerpt/);
});

test("without a working model, posts go out with no untranslated excerpt", async () => {
  const sink = { drafts: [], marked: [] };
  await blogFeeds(
    {
      policy: "t",
      summarize: async () => new Map(),
      curate: async () => {
        throw new Error("codex down");
      },
    },
    [blogItem("a"), blogItem("b", "규칙 요약인 한국어 문장이에요.")],
    sink,
  ).aiBlogs(now);
  const text = JSON.stringify(sink.drafts);
  assert.match(text, /Post a/);
  assert.doesNotMatch(text, /English excerpt/);
  assert.match(text, /규칙 요약인 한국어 문장이에요/);
});

test("a failed model call is written to the log", async (t) => {
  const written: string[] = [];
  t.mock.method(process.stderr, "write", (chunk: string) => {
    written.push(chunk);
    return true;
  });
  await blogFeeds(
    {
      policy: "t",
      summarize: async () => new Map(),
      curate: async () => {
        throw new Error("codex down");
      },
    },
    [blogItem("a")],
    { drafts: [], marked: [] },
  ).aiBlogs(now);
  assert.match(written.join(""), /Curation ai-blogs model failed.*codex down/);
});

test("a day where the model rejects everything is settled, not retried", async () => {
  const sink = { drafts: [], marked: [] as string[] };
  await blogFeeds(
    {
      policy: "t",
      summarize: async () => new Map(),
      curate: async () => new Map(),
    },
    [blogItem("a")],
    sink,
  ).aiBlogs(now);
  assert.equal(sink.drafts.length, 0);
  assert.deepEqual(sink.marked, ["ai-blogs:2026-10-27"]);
});
