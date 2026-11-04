import assert from "node:assert/strict";
import { test } from "node:test";
import {
  findCitations,
  isFreeTokenNews,
  isOldStory,
  selectBlogItems,
  kstDateKey,
  kstReached,
} from "@rapi/core";

test("KST calendar helpers", () => {
  const now = new Date("2026-10-11T23:30:00Z"); // Mon 08:30 KST
  assert.equal(kstDateKey(now), "2026-10-12");
  assert.equal(kstReached(now, 8, 30), true);
  assert.equal(kstReached(now, 9), false);
});

test("citations match links, linking bodies and quoted titles", () => {
  const official = {
    id: "o",
    url: "https://www.anthropic.com/news/claude-code-2?utm_source=x",
    title: "Introducing Claude Code 2 for teams",
  };
  const others = [
    {
      id: "a",
      url: "https://anthropic.com/news/claude-code-2",
      title: "HN thread",
      body: "",
      source: "HN",
    },
    {
      id: "b",
      url: "https://simonwillison.net/x",
      title: "Notes",
      body: "I tried https://www.anthropic.com/news/claude-code-2 today",
      source: "Simon",
    },
    {
      id: "c",
      url: "https://news.hada.io/1",
      title: "Introducing Claude Code 2 for teams 요약",
      body: "",
      source: "GeekNews",
    },
    {
      id: "d",
      url: "https://example.com/other",
      title: "Unrelated",
      body: "anthropic.com/news/other",
      source: "X",
    },
    {
      id: "o",
      url: official.url,
      title: official.title,
      body: "",
      source: "Anthropic",
    },
  ];
  assert.deepEqual(
    findCitations(official, others).map((c) => c.id),
    ["a", "b", "c"],
  );
});

test("free offers count only when the title is about AI", () => {
  assert.ok(isFreeTokenNews("Copilot is now free for students", ""));
  assert.ok(isFreeTokenNews("새 AI 모델을 무료로 공개", ""));
  assert.ok(
    isFreeTokenNews("Gemini for developers", "Available at no additional cost"),
  );
  assert.ok(!isFreeTokenNews("이라스토야 - 일러스트를 무료로 제공", ""));
  // A domain is not the word AI.
  assert.ok(!isFreeTokenNews("Idealab.ai - 창업 아이디어를 무료로 제공", ""));
});

test("a title marked with an earlier year is an old story", () => {
  const now = new Date("2026-10-19T00:00:00Z");
  assert.ok(isOldStory("Cloudflare의 무료 버전 제공 이유 (2016)", now));
  assert.ok(!isOldStory("Free tier news (2026)", now));
  assert.ok(!isOldStory("Free tier for GPT-5 (2016 models)", now));
});

test("blog items drop off-topic posts and cap each source", () => {
  const item = (source: string, title: string, aiOnly = false) => ({
    source,
    title,
    aiOnly,
  });
  const busy = ["a", "b", "c", "d", "e"].map((n) => item("Busy", `Post ${n}`));
  const picked = selectBlogItems([
    ...busy,
    item("Quiet", "Quiet post"),
    item("Vendor", "Vendor appoints a new officer"),
    item("Changelog", "Dependabot supports Python 3.15", true),
    item("Changelog", "Copilot in JetBrains Air", true),
  ]);
  assert.deepEqual(
    picked.map((p) => p.title),
    ["Post a", "Post b", "Post c", "Quiet post", "Copilot in JetBrains Air"],
  );
});

test("free token news detection", () => {
  assert.ok(isFreeTokenNews("Gemini API free tier now includes 2.5 Pro", ""));
  assert.ok(isFreeTokenNews("Groq gives $50 free credits", ""));
  assert.ok(isFreeTokenNews("새 모델 무료 공개", ""));
  assert.ok(
    isFreeTokenNews("Startup program", "Apply for free API access this month"),
  );
  assert.ok(!isFreeTokenNews("Free software foundation news", "freedom"));
  assert.ok(!isFreeTokenNews("Rust 1.90 released", ""));
});
