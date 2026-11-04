import assert from "node:assert/strict";
import { test } from "node:test";
import {
  findDateText,
  parseHtmlArticle,
  parseHtmlEntries,
  parseHtmlList,
} from "@rapi/adapters";
import { parseHtmlSourcePolicy } from "@rapi/core";

const BASE = "https://www.anthropic.com/news";
const POLICY = {
  linkPattern: "^/news/[a-z0-9-]+$",
  exclude: ["^/news/(announcements|features|events)$"],
};

const PAGE = `<!doctype html><html><head><title>News</title>
<script>var x = '<a href="/news/from-script">no</a>';</script></head><body>
<nav><a href="/news/announcements">Announcements</a><a href="/news/features">Features</a>
<a href="/careers">Careers</a></nav>
<ul>
<li><a href="/news/claude-new-model"><span>Oct 18, 2026</span><h3>Introducing a new model</h3></a></li>
<li class="row"><div><a href="https://www.anthropic.com/news/second-post?utm=1#top">Second &amp; post</a>
  <time>October 25, 2026</time></div></li>
<li><div class="card"><a href="/news/third-post" aria-label="Third post"><img src="x.png"></a>
  <p>2026년 10월 3일</p></div></li>
<li><a href="/news/claude-new-model"><img alt=""></a></li>
<li><a href="https://evil.example/news/other-origin">Other origin</a></li>
<li><a href="/news/two-links-a">First of two</a> <a href="/news/two-links-b">Second of two</a> Oct 1, 2026</li>
<li><a href="/news/iso-post">ISO</a><time datetime="2026-09-30T10:00:00Z">yesterday</time></li>
</ul></body></html>`;

test("extracts same-origin post links in page order with titles and dates", () => {
  const items = parseHtmlList(PAGE, BASE, POLICY);
  assert.deepEqual(
    items.map((item) => item.url),
    [
      "https://www.anthropic.com/news/claude-new-model",
      "https://www.anthropic.com/news/second-post?utm=1",
      "https://www.anthropic.com/news/third-post",
      "https://www.anthropic.com/news/two-links-a",
      "https://www.anthropic.com/news/two-links-b",
      "https://www.anthropic.com/news/iso-post",
    ],
  );
  const [first, second, third, a, b, iso] = items;
  assert.equal(first!.title, "Introducing a new model");
  assert.equal(first!.publishedAt, "2026-10-18T00:00:00.000Z");
  assert.equal(first!.externalId, first!.url);
  assert.equal(first!.body, "");
  assert.deepEqual(first!.metadata, { feedType: "html" });
  assert.equal(second!.title, "Second & post");
  assert.equal(second!.publishedAt, "2026-10-25T00:00:00.000Z");
  assert.equal(third!.title, "Third post");
  assert.equal(third!.publishedAt, "2026-10-03T00:00:00.000Z");
  // A container holding two posts is ambiguous, so no date is guessed.
  assert.equal(a!.publishedAt, null);
  assert.equal(b!.publishedAt, null);
  assert.equal(iso!.publishedAt, "2026-09-30T10:00:00.000Z");
});

test("excludes category pages and ignores links inside scripts", () => {
  const urls = parseHtmlList(PAGE, BASE, POLICY).map((item) => item.url);
  assert.ok(
    !urls.some((url) => /announcements|features|from-script/.test(url)),
  );
  assert.ok(!urls.some((url) => url.includes("evil.example")));
});

test("keeps at most maxItems in page order and deduplicates by URL", () => {
  const items = parseHtmlList(PAGE, BASE, { ...POLICY, maxItems: 2 });
  assert.deepEqual(
    items.map((item) => item.title),
    ["Introducing a new model", "Second & post"],
  );
});

test("rejects input over 2 MB", () => {
  assert.throws(
    () => parseHtmlList("x".repeat(2_000_001), BASE, POLICY),
    /2 MB/,
  );
});

test("finds Korean, English and ISO dates", () => {
  assert.equal(findDateText("2026. 10. 18.")?.iso, "2026-10-18T00:00:00.000Z");
  assert.equal(findDateText("18 Oct 2026")?.iso, "2026-10-18T00:00:00.000Z");
  assert.equal(findDateText("Sept 3rd, 2026")?.iso, "2026-09-03T00:00:00.000Z");
  assert.equal(findDateText("2026-02-30"), null);
  assert.equal(findDateText("no date here"), null);
});

test("validates the html source policy", () => {
  assert.deepEqual(parseHtmlSourcePolicy({ html: { linkPattern: "^/a$" } }), {
    linkPattern: "^/a$",
    maxItems: 20,
    exclude: [],
  });
  assert.throws(() => parseHtmlSourcePolicy({}), /collection_policy\.html/);
  assert.throws(
    () => parseHtmlSourcePolicy({ html: { linkPattern: "(" } }),
    /valid regular expression/,
  );
  assert.throws(
    () => parseHtmlSourcePolicy({ html: { linkPattern: "a".repeat(200) } }),
    /shorter than 200/,
  );
  assert.throws(
    () => parseHtmlSourcePolicy({ html: { linkPattern: "a", exclude: ["["] } }),
    /valid regular expression/,
  );
  assert.throws(
    () => parseHtmlSourcePolicy({ html: { linkPattern: "a", maxItems: 0 } }),
    /maxItems/,
  );
});

test("splits a single page of updates and carries each kind of date", () => {
  const openai = parseHtmlEntries(
    `<nav><h3>Docs</h3></nav><h3>October, 2026</h3>
     <div><div class="b">Oct 28</div><span>Feature</span><p>Up to $500 in free API credits.</p></div>
     <h3>September, 2026</h3>
     <div><div class="b">Sep 2</div><span>Update</span><p>Sandbox billing changed.</p></div>`,
    "https://x.test/log",
    "<div[^>]*>(?:Oct|Sep) \\d{1,2}</div>",
  );
  assert.deepEqual(
    openai.map((item) => [item.title, item.publishedAt?.slice(0, 10)]),
    [
      ["Feature Up to $500 in free API credits.", "2026-10-28"],
      ["Update Sandbox billing changed.", "2026-09-02"],
    ],
  );
  const deepseek = parseHtmlEntries(
    `<h2>Date: 2026-10-17</h2><h3>Search API</h3><p>Now open to everyone today.</p>
     <h3>Flash Update</h3><p>A new flash model for all users.</p>`,
    "https://x.test/updates",
    "<h[23]\\b",
  );
  assert.deepEqual(
    deepseek.map((item) => [item.title, item.publishedAt?.slice(0, 10)]),
    [
      ["Search API", "2026-10-17"],
      ["Flash Update", "2026-10-17"],
    ],
  );
  assert.notEqual(deepseek[0]!.externalId, deepseek[1]!.externalId);
  const again = parseHtmlEntries(
    `<h2>Date: 2026-10-17</h2><h3>Search API</h3><p>Reworded.</p>`,
    "https://x.test/updates",
    "<h[23]\\b",
  );
  assert.equal(again[0]!.externalId, deepseek[0]!.externalId);
});

test("reads an article from main when the page marks it", () => {
  assert.equal(
    parseHtmlArticle(
      "<nav>Skip Home</nav><main><h1>Title</h1><p>Body</p></main>",
    ),
    "Title Body",
  );
  assert.equal(parseHtmlArticle("<p>Body</p>"), "Body");
});
