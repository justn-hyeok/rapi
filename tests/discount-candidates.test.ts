import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ChangelogRoute } from "@rapi/adapters";
import { discountEvidence } from "@rapi/core";

const now = () => new Date("2026-11-05T00:00:00Z");
const pages = (byUrl: Record<string, string>): typeof fetch =>
  (async (url: string) => {
    const body = byUrl[url];
    return body === undefined
      ? new Response("missing", { status: 404 })
      : new Response(body);
  }) as typeof fetch;

test("discount wording matches every listed form", () => {
  for (const title of [
    "GPT-5.6 Sol is 50% off",
    "Get 50 % OFF this week",
    "Nano Banana Per-Request Price Cut",
    "A price reduction for Flash",
    "Prices drop today",
    "Promotional pricing is here",
    "Updated weights and lower pricing",
    "Clef-flash is now cheaper",
    "$100 in API credits",
    "A monthly credit for Max",
    "Available through November 21, 2026",
    "Runs until Sep 18",
    "Open until 2026-11-30",
    "신규 가입 20% 할인",
    "API 가격 인하",
    "무료 크레딧 지급",
  ])
    assert.ok(discountEvidence(title, ""), title);
});

test("discount wording leaves ordinary updates alone", () => {
  for (const title of [
    "Security Review now in public beta",
    "Pricing remains unchanged",
    "장애로 인하여 지연되었습니다",
    "인하대학교와 협력",
    "Runs through the night",
    "Walk through October planning",
    "Accreditation for our data centers",
    "50% offset of output tokens",
  ])
    assert.equal(discountEvidence(title, ""), null, title);
});

test("discount wording reads only the title and the start of the body", () => {
  const late = `${"x ".repeat(310)}50% off`;
  assert.equal(discountEvidence("Update", late), null);
  assert.ok(discountEvidence("Update", late, 1000));
  const long = discountEvidence("Update", `credits ${"z".repeat(2000)}`, 2000);
  assert.ok(long && long.length <= 600);
});

// Real events from the 2026-11-05 corpus, with the text the route reads for each.
// Google and Upstage are not in the list: no listed source carries those events.
test("replay: wording catches 6 of the 8 real events a listed changelog carried", () => {
  const events = JSON.parse(
    readFileSync("tests/fixtures/discount-replay.json", "utf8"),
  ) as Array<{ id: string; title: string; body: string; bodyChars?: number }>;
  assert.equal(events.length, 8);
  const caught = events.filter((event) =>
    discountEvidence(event.title, event.body, event.bodyChars),
  );
  assert.deepEqual(
    caught.map((event) => event.id),
    [
      "openai-gpt-5.6-sol-api-promo-2026-08",
      "vercel-ai-gateway-gpt-5.6-sol-50off-2026-08",
      "cloudflare-ai-gateway-gpt-5.6-sol-50off-2026-08",
      "anthropic-monthly-api-credits-max-team-2026-10",
      "openai-chatgpt-pro-business-api-credits-2026-10",
      "aws-bedrock-gpt-5.6-sol-reduced-pricing-2026-08",
    ],
  );
});

test("changelog feeds keep recent discount entries with a stable key", async () => {
  const url = "https://x.test/atom";
  const atom = `<feed>
    <entry><id>a</id><title>Sol is 50% off</title><link href="https://x.test/a"/><updated>2026-11-01T00:00:00Z</updated>
      <content type="xhtml"><div><p>Runs for a month.</p></div></content></entry>
    <entry><id>b</id><title>New dashboard</title><link href="https://x.test/b"/><updated>2026-11-02T00:00:00Z</updated></entry>
    <entry><id>c</id><title>Old 90% off</title><link href="https://x.test/c"/><updated>2026-01-01T00:00:00Z</updated></entry>
  </feed>`;
  const route = new ChangelogRoute({ fetch: pages({ [url]: atom }) }, now);
  const source = { url, format: "feed", maxAgeDays: 30 } as const;
  const { candidates } = await route.collect(source);
  assert.deepEqual(candidates, [
    {
      kind: "discount",
      route: "changelog",
      dedupeKey: "changelog:a",
      domain: "x.test",
      title: "Sol is 50% off",
      url: "https://x.test/a",
      evidence: "Sol is 50% off Runs for a month.",
      publishedAt: "2026-11-01T00:00:00.000Z",
    },
  ]);
  assert.deepEqual((await route.collect(source)).candidates, candidates);
});

test("changelog pages record matching updates under the page URL", async () => {
  const url = "https://x.test/updates";
  const route = new ChangelogRoute(
    {
      fetch: pages({
        [url]: `<h2>Date: 2026-10-27</h2><h3>Outage</h3><p>Sorry.</p><h3>Flash Price Cut</h3><p>Now 10% less.</p>`,
      }),
    },
    now,
  );
  const { candidates } = await route.collect({
    url,
    format: "page",
    entryStart: "<h[23]\\b",
    maxAgeDays: 30,
  });
  assert.deepEqual(
    candidates.map((candidate) => [
      candidate.title,
      candidate.url,
      candidate.publishedAt,
    ]),
    [["Flash Price Cut", url, "2026-10-27T00:00:00.000Z"]],
  );
  assert.match(
    candidates[0]!.dedupeKey,
    /^changelog:https:\/\/x\.test\/updates#/,
  );
});

test("a news list fetches only the newest articles and keeps them when one fails", async () => {
  const url = "https://x.test/news";
  const article = (slug: string, date: string) =>
    `<article><time>${date}</time><a href="/news/${slug}"><h3>${slug}</h3></a></article>`;
  const requested: string[] = [];
  const bodies: Record<string, string> = {
    [url]: [
      article("older", "Oct 1, 2026"),
      article("credit", "Oct 7, 2026"),
      article("plain", "Oct 8, 2026"),
      article("broken", "Oct 9, 2026"),
      article("stale", "Jan 9, 2026"),
    ].join(""),
    "https://x.test/news/credit": `<nav>Home</nav><main><p>${"Intro. ".repeat(100)}A new monthly API credit.</p></main>`,
    "https://x.test/news/plain": "<main><p>A new office.</p></main>",
    "https://x.test/news/older": "<main><p>$5 in credits.</p></main>",
  };
  const fetchPage = pages(bodies);
  const route = new ChangelogRoute(
    {
      fetch: ((page: string, init?: RequestInit) => {
        requested.push(page);
        return fetchPage(page, init);
      }) as typeof fetch,
    },
    now,
  );
  const result = await route.collect({
    url,
    format: "list",
    html: { linkPattern: "^/news/[a-z-]+$" },
    maxArticles: 3,
    articleChars: 1000,
    maxAgeDays: 60,
  });
  assert.deepEqual(requested, [
    url,
    "https://x.test/news/broken",
    "https://x.test/news/plain",
    "https://x.test/news/credit",
  ]);
  assert.deepEqual(
    result.candidates.map((candidate) => candidate.title),
    ["credit"],
  );
  assert.match(result.problem ?? "", /news\/broken: Source returned 404/);
});
