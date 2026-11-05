import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  addsProvider,
  apiAddress,
  CatalogRoute,
  ChangelogRoute,
  CodeSearchRoute,
  CreditFeedRoute,
  HackerNewsRoute,
  isPriceCut,
  PullRequestRoute,
} from "@rapi/adapters";
import {
  collectDiscountCandidates,
  loadDiscountSources,
  verifyDiscountCandidates,
  verifyReports,
  type DiscountSources,
} from "@rapi/agent";
import {
  discountEvidence,
  knownOperator,
  type CandidateToVerify,
  type CandidateVerification,
  type DiscountCandidate,
} from "@rapi/core";

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
    "SVIP 10% discount for all groups",
    "API prices have been reduced accordingly",
    "peak/off-peak pricing",
    "무료 크레딧 지급",
    "OpenAI and Anthropic cut their LLM prices by up to 80%",
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
test("replay: wording catches 7 of the 8 real events a listed changelog carried", () => {
  // The DeepSeek fixture stops at 600 characters, before its price sentence.
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
      "apiyi-oct28-svip-10pct-discount-2026-10",
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

const githubReply = (
  payload: unknown,
  seen: Array<{ url: string; auth?: string }> = [],
) =>
  (async (url: string, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string> | undefined;
    seen.push({ url, ...(headers ? { auth: headers.Authorization! } : {}) });
    return new Response(JSON.stringify(payload));
  }) as typeof fetch;

test("unmerged PRs are recorded only when they add a provider", async () => {
  for (const title of [
    "feat(providers): add PingCode AI",
    "Add Infersia provider",
    "Add initial TheRouter provider metadata",
    "feat(inference-coop): add Inference Cooperative provider with 10 models",
    "Add CheapestToken provider (OpenAI-compatible gateway, 19 models)",
  ])
    assert.ok(addsProvider(title), title);
  for (const title of [
    "Feat/add model",
    "feat(liquid): add six open models and fix Auto metadata",
    "chore(sync): update OpenRouter model catalog",
    "feat(bothub): update provider URLs/prices and add Gemini",
    "fix(providers): point OpenRouter at its own module",
    "provider(vivgrid): remove retired models",
    "chore(gmicloud): sync provider model catalog from /v1/models (17 -> 86)",
  ])
    assert.equal(addsProvider(title), false, title);

  const seen: Array<{ url: string; auth?: string }> = [];
  const route = new PullRequestRoute("read-token", {
    fetch: githubReply(
      [
        {
          number: 7,
          title: "Add Infersia provider",
          html_url: "https://github.com/a/b/pull/7",
          created_at: "2026-11-04T04:48:11Z",
          user: { login: "infersia" },
          body: "my api key is sk-should-not-be-kept",
        },
        {
          number: 8,
          title: "Feat/add model",
          html_url: "https://github.com/a/b/pull/8",
          created_at: "2026-11-04T04:33:09Z",
        },
      ],
      seen,
    ),
  });
  const { candidates } = await route.collect("a/b");
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.auth, "Bearer read-token");
  assert.deepEqual(candidates, [
    {
      kind: "new_service",
      route: "pull_request",
      dedupeKey: "pull_request:a/b#7",
      domain: null,
      title: "Add Infersia provider",
      url: "https://github.com/a/b/pull/7",
      evidence: "a/b PR #7, infersia",
      publishedAt: "2026-11-04T04:48:11.000Z",
    },
  ]);
});

test("API addresses keep nothing a key could hide in", () => {
  const denylist = ["openai.com", "x.ai"];
  const address = (raw: string) => apiAddress(raw, denylist)?.address ?? null;
  assert.equal(address("https://api.hive.dev/v1/"), "https://api.hive.dev/v1");
  assert.equal(
    address("https://relay.io:8443/compatible-mode/v1"),
    "https://relay.io:8443/compatible-mode/v1",
  );
  assert.equal(
    address("https://user:sk-secret@relay.io/v1?key=sk-secret#a"),
    "https://relay.io/v1",
  );
  assert.equal(
    address("https://relay.io/sk-A1b2C3d4E5/v1"),
    "https://relay.io",
  );
  for (const raw of [
    "https://api.openai.com/v1",
    "https://eu.api.x.ai/v1",
    "https://localhost:3000/v1",
    "http://127.0.0.1:8080/v1",
    "https://api.example.com/v1",
    "https://gateway.example/v1",
    "https://your-domain.com/v1",
    "https://relay.agentrouter.internal/v1",
    "not a url",
  ])
    assert.equal(address(raw), null, raw);
  assert.equal(apiAddress("https://xai.dev", denylist)?.domain, "xai.dev");
});

test("code search stores only the address, the repository and the file", async () => {
  const seen: Array<{ url: string; auth?: string }> = [];
  const route = new CodeSearchRoute("read-token", ["openai.com"], {
    fetch: githubReply(
      {
        items: [
          {
            html_url: "https://github.com/o/r/blob/abc/config.ts",
            repository: { html_url: "https://github.com/o/r" },
            text_matches: [
              {
                fragment: `model: "gpt-6.1-sol",\n  apiKey: "sk-live-secret",\n  baseURL: "https://user:sk-url-secret@api.relay.io/v1?token=sk-query-secret",\n  other: "https://notes.relay.io/page"`,
              },
              { fragment: 'base_url = "https://api.openai.com/v1"' },
            ],
          },
          {
            html_url: "https://github.com/p/q/blob/def/a.py",
            repository: { html_url: "https://github.com/p/q" },
            text_matches: [
              { fragment: 'BASE_URL="https://api.relay.io/v1"' },
              { fragment: "see https://other.relay.io/v1 for details" },
            ],
          },
        ],
      },
      seen,
    ),
  });
  const { candidates } = await route.collect('"gpt-6.1-sol" baseURL');
  assert.deepEqual(candidates, [
    {
      kind: "new_service",
      route: "code_search",
      dedupeKey: "code_search:api.relay.io",
      domain: "api.relay.io",
      title: "https://api.relay.io/v1",
      url: "https://github.com/o/r/blob/abc/config.ts",
      evidence: "https://github.com/o/r",
      publishedAt: null,
    },
  ]);
  assert.doesNotMatch(JSON.stringify(candidates), /secret|gpt-6|apiKey/);
  assert.equal(seen.length, 1);
  assert.match(seen[0]!.url, /search\/code\?q=%22gpt-6\.1-sol%22%20baseURL/);
});

// Same uniqueness rule as discount_candidates.dedupe_key.
function fakeStore() {
  const rows = new Map<string, DiscountCandidate>();
  const ok: string[] = [];
  const failed: Array<[string, string]> = [];
  const store = {
    createSource: async (kind: string, locator: string) => `${kind}|${locator}`,
    saveDiscountCandidate: async (candidate: DiscountCandidate) => {
      if (rows.has(candidate.dedupeKey)) return false;
      rows.set(candidate.dedupeKey, candidate);
      return true;
    },
    saveCursor: async (id: string) => void ok.push(id),
    recordSourceFailure: async (id: string, message: string) =>
      void failed.push([id, message]),
  };
  return { store, rows, ok, failed };
}

const SOURCES: DiscountSources = {
  changelogs: [
    { url: "https://broken.test/atom", format: "feed", maxAgeDays: 30 },
    { url: "https://x.test/atom", format: "feed", maxAgeDays: 30 },
  ],
  pullRequests: { repository: "a/b" },
  codeSearch: { queries: ['"gpt-6.1-sol" baseURL'], denylist: [] },
  operators: [],
};
const atom = `<feed><entry><id>a</id><title>50% off</title><link href="https://x.test/a"/><updated>2026-11-01T00:00:00Z</updated></entry></feed>`;
const web = (async (url: string) => {
  if (url === "https://x.test/atom") return new Response(atom);
  if (url.includes("/pulls"))
    return new Response(
      JSON.stringify([
        {
          number: 7,
          title: "Add Infersia provider",
          html_url: "https://github.com/a/b/pull/7",
          created_at: "2026-11-04T04:48:11Z",
        },
      ]),
    );
  if (url.includes("/search/code"))
    return new Response(
      JSON.stringify({
        items: [
          {
            html_url: "https://github.com/o/r/blob/abc/c.ts",
            repository: { html_url: "https://github.com/o/r" },
            text_matches: [{ fragment: 'baseURL: "https://api.relay.io/v1"' }],
          },
        ],
      }),
    );
  return new Response("down", { status: 503 });
}) as typeof fetch;

test("one source failing leaves the others running and shows the failure", async () => {
  const { store, rows, ok, failed } = fakeStore();
  const failures = await collectDiscountCandidates({
    store: store as never,
    sources: SOURCES,
    githubToken: "read-token",
    http: { fetch: web },
    now,
  });
  assert.deepEqual(failed, [
    ["candidate_changelog|https://broken.test/atom", "Source returned 503"],
  ]);
  assert.deepEqual(failures, ["https://broken.test/atom: Source returned 503"]);
  assert.deepEqual(ok, [
    "candidate_changelog|https://x.test/atom",
    "candidate_pull_request|a/b",
    'candidate_code_search|"gpt-6.1-sol" baseURL',
  ]);
  assert.deepEqual(
    [...rows.keys()],
    ["changelog:a", "pull_request:a/b#7", "code_search:api.relay.io"],
  );
});

test("seeing the same candidates again adds nothing", async () => {
  const { store, rows } = fakeStore();
  const run = () =>
    collectDiscountCandidates({
      store: store as never,
      sources: SOURCES,
      githubToken: "read-token",
      http: { fetch: web },
      now,
    });
  await run();
  const first = [...rows.keys()];
  await run();
  assert.deepEqual([...rows.keys()], first);
  assert.equal(first.length, 3);
});

test("without a token the GitHub routes are skipped visibly, not failed", async () => {
  const { store, rows, failed } = fakeStore();
  const requested: string[] = [];
  const failures = await collectDiscountCandidates({
    store: store as never,
    sources: { ...SOURCES, changelogs: [SOURCES.changelogs[1]!] },
    http: {
      fetch: ((url: string, init?: RequestInit) => {
        requested.push(url);
        return web(url, init);
      }) as typeof fetch,
    },
    now,
  });
  assert.deepEqual(failures, []);
  assert.deepEqual(requested, ["https://x.test/atom"]);
  assert.deepEqual([...rows.keys()], ["changelog:a"]);
  assert.deepEqual(
    failed.map(([id]) => id),
    [
      "candidate_pull_request|a/b",
      'candidate_code_search|"gpt-6.1-sol" baseURL',
    ],
  );
  assert.match(failed[0]![1], /GITHUB_READ_TOKEN/);
});

test("the shipped source list loads and names every changelog", async () => {
  const sources = await loadDiscountSources(process.cwd());
  assert.deepEqual(sources.changelogs.map((source) => source.url).sort(), [
    "https://api-docs.deepseek.com/updates/",
    "https://aws.amazon.com/about-aws/whats-new/recent/feed/",
    "https://developers.cloudflare.com/changelog/rss/index.xml",
    "https://developers.openai.com/api/docs/changelog",
    "https://docs.apiyi.com/en/changelog",
    "https://vercel.com/atom",
    "https://www.anthropic.com/news",
  ]);
  assert.ok(sources.codeSearch.queries.length <= 4);
  for (const source of sources.changelogs) {
    if (source.format === "list") assert.ok(source.maxArticles <= 5);
    // An official changelog with no known operator would be read as a stranger.
    assert.ok(
      knownOperator(new URL(source.url).hostname, sources.operators),
      source.url,
    );
  }
});

const toVerify = (
  id: string,
  domain: string | null,
  route: CandidateToVerify["route"] = "code_search",
): CandidateToVerify => ({
  id,
  kind: "new_service",
  route,
  domain,
  title: domain ?? "Add Infersia provider",
  evidence: "https://github.com/o/r",
});

const HOME = { "content-type": "text/html" };
const resolve = async () => ["93.184.216.34"];

function verificationStore(rows: CandidateToVerify[]) {
  const saved = new Map<string, CandidateVerification>();
  return {
    saved,
    store: {
      unverifiedDiscountCandidates: async () => rows,
      saveCandidateVerification: async (
        id: string,
        verification: CandidateVerification,
      ) => {
        if (id === "unsavable") throw new Error("db down");
        saved.set(id, verification);
      },
    },
  };
}

test("one candidate failing to read or save leaves the others checked", async () => {
  const { store, saved } = verificationStore([
    toVerify("down", "down.io"),
    toVerify("unsavable", "up.io"),
    toVerify("local", "localhost"),
    toVerify("pr", null, "pull_request"),
    toVerify("up", "up.io"),
  ]);
  const requested: string[] = [];
  const failures = await verifyDiscountCandidates({
    store: store as never,
    operators: [],
    http: {
      resolve,
      fetch: (async (url: string) => {
        requested.push(url);
        if (url === "https://down.io/") throw new Error("ECONNREFUSED");
        return new Response('<a href="/terms">Terms</a>', { headers: HOME });
      }) as typeof fetch,
    },
  });
  assert.deepEqual(failures, ["up.io: db down"]);
  assert.deepEqual([...saved.keys()], ["down", "local", "pr", "up"]);
  assert.equal(saved.get("down")!.termsNote, "확인 못 함");
  assert.equal(saved.get("local")!.termsNote, "확인 못 함");
  assert.equal(saved.get("pr")!.termsNote, "확인 못 함");
  assert.equal(saved.get("up")!.termsUrl, "https://up.io/terms");
  assert.equal(saved.get("up")!.termsNote, null);
  for (const verification of saved.values())
    assert.equal(verification.band, "yellow");
  assert.deepEqual(requested, [
    "https://down.io/",
    "https://up.io/",
    "https://up.io/",
  ]);
});

test("the store failing to list is reported, not thrown", async () => {
  assert.deepEqual(
    await verifyDiscountCandidates({
      store: {
        unverifiedDiscountCandidates: async () => {
          throw new Error("db down");
        },
      } as never,
      operators: [],
    }),
    ["verification: db down"],
  );
});

test("the short timer asks only for reports, and few at a time", async () => {
  const asked: unknown[] = [];
  const failures = await verifyReports({
    store: {
      unverifiedDiscountCandidates: async (...args: unknown[]) => {
        asked.push(args);
        return [];
      },
      saveCandidateVerification: async () => {},
    } as never,
    operators: [],
  });
  assert.deepEqual(failures, []);
  assert.deepEqual(asked, [[20, "report"]]);
});

const CATALOG = {
  providersUrl: "https://or.test/providers",
  modelsUrl: "https://or.test/models",
  minPriceCutPercent: 20,
};
const catalogFetch = (providers: unknown[], models: unknown[]): typeof fetch =>
  pages({
    [CATALOG.providersUrl]: JSON.stringify({ data: providers }),
    [CATALOG.modelsUrl]: JSON.stringify({ data: models }),
  });
const relay = {
  slug: "relay",
  name: "Relay",
  privacy_policy_url: "https://relay.test/privacy",
};
const model = (id: string, prompt: string, completion: string) => ({
  id,
  name: id,
  pricing: { prompt, completion },
});

test("the first look at the catalog records it and reports nothing", async () => {
  const { candidates, cursor } = await new CatalogRoute({
    fetch: catalogFetch([relay], [model("a/b:free", "0", "0")]),
  }).collect(CATALOG, null);
  assert.deepEqual(candidates, []);
  assert.deepEqual((JSON.parse(cursor!) as { providers: string[] }).providers, [
    "relay",
  ]);
});

test("the catalog reports a new provider, a new free model and a price cut", async () => {
  const { cursor } = await new CatalogRoute({
    fetch: catalogFetch(
      [{ slug: "old", name: "Old" }],
      [model("a/b", "0.000002", "0.000004")],
    ),
  }).collect(CATALOG, null);
  const { candidates } = await new CatalogRoute({
    fetch: catalogFetch(
      [{ slug: "old", name: "Old" }, relay],
      [
        model("a/b", "0.000001", "0.000004"),
        { ...model("c/d:free", "0", "0"), expiration_date: "2026-12-31" },
      ],
    ),
  }).collect(CATALOG, cursor!);
  assert.deepEqual(
    candidates.map((c) => [c.kind, c.dedupeKey, c.domain]),
    [
      ["new_service", "catalog:provider:relay", "relay.test"],
      ["discount", "catalog:price:a/b:0.000001:0.000004", "openrouter.ai"],
      ["discount", "catalog:free:c/d:free", "openrouter.ai"],
    ],
  );
  assert.match(candidates[1]!.evidence, /입력 \$2 → \$1, 출력 \$4 → \$4/);
  assert.equal(candidates[2]!.evidence, "2026-12-31까지");
});

test("a price counts as cut only when nothing rose and the drop is large enough", () => {
  assert.ok(isPriceCut(["2", "4"], ["1", "4"], 20));
  assert.ok(!isPriceCut(["2", "4"], ["1", "5"], 20));
  assert.ok(!isPriceCut(["2", "4"], ["1.9", "4"], 20));
  assert.ok(!isPriceCut(["-1", "-1"], ["1", "1"], 20));
  assert.ok(!isPriceCut(["2", "4"], ["0", "0"], 20));
});

test("an empty catalog answer fails and keeps the last snapshot", async () => {
  await assert.rejects(
    new CatalogRoute({ fetch: catalogFetch([], []) }).collect(CATALOG, "{}"),
    /empty list/,
  );
});

const hackerNews = (hits: unknown[]): typeof fetch =>
  (async () => new Response(JSON.stringify({ hits }))) as typeof fetch;
const story = (objectID: string, title: string, url: string | null) => ({
  objectID,
  title,
  url,
  points: 12,
  created_at: "2026-11-04T00:00:00Z",
});

test("a Hacker News price story needs something that sells tokens in its title", async () => {
  const { candidates } = await new HackerNewsRoute(
    {
      fetch: hackerNews([
        story("1", "GPT-6.1 Terra's price cut, recomputed", "https://a.test/x"),
        story("2", "Europe's power price cut", "https://b.test/x"),
      ]),
    },
    now,
  ).collect("price cut", "discount", 7);
  assert.deepEqual(
    candidates.map((c) => [c.dedupeKey, c.domain, c.evidence]),
    [["hacker_news:1", "a.test", "Hacker News 12점"]],
  );
});

test("a Hacker News service has to offer itself, and stays linkable", async () => {
  const { candidates } = await new HackerNewsRoute(
    {
      fetch: hackerNews([
        story("1", "Go vs. Python for an LLM Gateway", "https://a.test/x"),
        story(
          "2",
          "Show HN: GoRoute, an LLM gateway",
          "https://github.com/a/b",
        ),
        story("3", "Nano-GPT, an alternative to OpenRouter", "http://c.test/"),
      ]),
    },
    now,
  ).collect('"LLM gateway"', "new_service", 7);
  assert.deepEqual(
    candidates.map((c) => [c.dedupeKey, c.domain, c.url]),
    [
      ["hacker_news:2", null, "https://github.com/a/b"],
      ["hacker_news:3", null, "https://news.ycombinator.com/item?id=3"],
    ],
  );
});

test("the Hacker News search asks for recent titles only", async () => {
  let asked = "";
  await new HackerNewsRoute(
    {
      fetch: (async (url: string) => {
        asked = url;
        return new Response(JSON.stringify({ hits: [] }));
      }) as typeof fetch,
    },
    now,
  ).collect("price cut", "discount", 7);
  const params = new URL(asked).searchParams;
  assert.equal(params.get("restrictSearchableAttributes"), "title");
  assert.equal(params.get("tags"), "story");
  assert.equal(
    params.get("numericFilters"),
    `created_at_i>${Date.parse("2026-10-29T00:00:00Z") / 1000}`,
  );
});

const rssItem = (guid: string, title: string, date: string) =>
  `<item><title>${title}</title><link>https://site.test/${guid}</link><guid>${guid}</guid><pubDate>${date}</pubDate><description>x</description></item>`;
const rss = (...items: string[]) =>
  `<?xml version="1.0"?><rss version="2.0"><channel>${items.join("")}</channel></rss>`;

test("the credit feed keeps only recent new listings, under their own name", async () => {
  const url = "https://aifree.test/feed.xml";
  const { candidates } = await new CreditFeedRoute(
    {
      fetch: pages({
        [url]: rss(
          rssItem(
            "a",
            "XCrawl Free Credits: Listed",
            "Mon, 02 Nov 2026 16:51:14 GMT",
          ),
          rssItem(
            "b",
            "Cohere Free Trial: Change detected",
            "Mon, 02 Nov 2026 16:51:14 GMT",
          ),
          rssItem(
            "c",
            "IBM free tier: Verified",
            "Mon, 02 Nov 2026 16:51:14 GMT",
          ),
          rssItem("d", "Old Credits: Listed", "Mon, 02 Mar 2026 16:51:14 GMT"),
        ),
      }),
    },
    now,
  ).collect({ url, maxAgeDays: 30 });
  assert.deepEqual(
    candidates.map((c) => [c.dedupeKey, c.title, c.kind]),
    [["credit_feed:a", "XCrawl Free Credits", "discount"]],
  );
});
