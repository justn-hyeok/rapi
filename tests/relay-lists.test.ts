import assert from "node:assert/strict";
import { test } from "node:test";
import {
  offerImproved,
  parseRelayList,
  RELAY_LIST_MAX_CHANGES,
  RelayListRoute,
  type RelayListSource,
  loadDiscountSources,
  discountCandidateJobs,
} from "@rapi/adapters";
import { collectDiscountCandidates } from "@rapi/agent";
import type { DiscountCandidate } from "@rapi/core";

const site = (id: string, credits: Record<string, unknown>) => ({
  id,
  name: id.toUpperCase(),
  homeUrl: `https://${id}.test/register?aff=abc`,
  credits,
  mirrors: [{ homeUrl: "https://mirror.test" }],
});
const hub = (...sites: unknown[]) => JSON.stringify({ meta: {}, sites });
const HUB: RelayListSource = {
  repository: "o/hub",
  path: "data/sites.json",
  format: "welfare-hub",
};
const serving = (body: string): typeof fetch =>
  (async () => new Response(body)) as typeof fetch;
const listed = (cursor: string | undefined) =>
  Object.keys((JSON.parse(cursor!) as { entries: object }).entries);
const collect = (body: string, cursor: string | null, source = HUB) =>
  new RelayListRoute({ fetch: serving(body) }).collect(source, cursor);

test("a hub entry keeps the site's own address and its amounts", () => {
  assert.deepEqual(
    parseRelayList(
      "welfare-hub",
      hub(
        site("agent", { signup: 100, invite: 50, dailyCheckin: 25 }),
        site("points", { signup: 5000, approx: true, unit: "point" }),
        site("nothing", { signup: null, invite: 0 }),
      ),
    ),
    [
      {
        key: "agent.test",
        name: "AGENT",
        url: "https://agent.test/",
        domain: "agent.test",
        offer: "가입 $100, 초대 $50, 출석 $25",
        amounts: { signup: 100, invite: 50, dailyCheckin: 25 },
      },
      {
        key: "points.test",
        name: "POINTS",
        url: "https://points.test/",
        domain: "points.test",
        offer: "가입 약 5000포인트",
        amounts: { signup: 5000 },
      },
      {
        key: "nothing.test",
        name: "NOTHING",
        url: "https://nothing.test/",
        domain: "nothing.test",
        offer: "",
        amounts: {},
      },
    ],
  );
});

test("a README table is read only where a column is headed with 额度", () => {
  const readme = [
    "| 名称 | 地址 | 免费额度 | 备注 |",
    "| --- | --- | --- | --- |",
    "| [快跑](#kp) | [注册](https://www.kuaipao.test/register?aff=x) | 注册送 ¥0.5 | 注册无限制 |",
    "| 无地址 | 没有 | 送 1 | |",
    "",
    "| 工具 | 地址 |",
    "| --- | --- |",
    "| new-api | https://github.com/x/new-api |",
  ].join("\n");
  assert.deepEqual(parseRelayList("table", readme), [
    {
      key: "kuaipao.test",
      name: "快跑",
      url: "https://www.kuaipao.test/",
      domain: "kuaipao.test",
      offer: "注册送 ¥0.5",
    },
  ]);
});

test("a stations list keeps one row per site", () => {
  const body = JSON.stringify({
    stations: [
      { name: "Any", url: "https://any.test/register?aff=b", quota: "送 $100" },
      { name: "Any again", url: "https://any.test/", quota: "送 $1" },
    ],
  });
  assert.deepEqual(
    parseRelayList("stations", body).map(({ name, offer }) => [name, offer]),
    [["Any", "送 $100"]],
  );
});

test("the first look at a list records it and reports nothing", async () => {
  const { candidates, cursor } = await collect(
    hub(site("agent", { signup: 100 })),
    null,
  );
  assert.deepEqual(candidates, []);
  assert.deepEqual(listed(cursor), ["agent.test"]);
});

test("a new site and a larger amount are reported, a smaller one is not", async () => {
  const { cursor } = await collect(
    hub(
      site("agent", { signup: 100, dailyCheckin: 25 }),
      site("down", { signup: 50 }),
    ),
    null,
  );
  const { candidates } = await collect(
    hub(
      site("agent", { signup: 150, dailyCheckin: 25 }),
      site("down", { signup: 20 }),
      site("fresh", { signup: 10 }),
    ),
    cursor!,
  );
  assert.deepEqual(
    candidates.map((c) => [c.dedupeKey, c.title, c.url, c.evidence]),
    [
      [
        candidates[0]!.dedupeKey,
        "AGENT: 가입 $150, 출석 $25",
        "https://agent.test/",
        "o/hub 목록에서 바뀜. 이전: 가입 $100, 출석 $25",
      ],
      [
        "relay_list:fresh.test:new",
        "FRESH: 가입 $10",
        "https://fresh.test/",
        "o/hub 목록에 새로 올라옴",
      ],
    ],
  );
  assert.match(
    candidates[0]!.dedupeKey,
    /^relay_list:agent\.test:[0-9a-f]{12}$/,
  );
  assert.ok(
    candidates.every((c) => c.route === "relay_list" && c.kind === "discount"),
  );
});

test("wording counts as better only when the words change and still offer something", () => {
  const before = { offer: "注册送 ¥0.5，需充值10元解锁签到" };
  const row = (offer: string) => ({
    key: "k",
    name: "n",
    url: "https://k.test/",
    domain: "k.test",
    offer,
  });
  assert.ok(offerImproved(before, row("注册送 ¥0.5，每日签到获取免费额度")));
  // Full-width and ASCII commas swap back and forth between commits.
  assert.ok(!offerImproved(before, row("注册送 ¥0.5, 需充值10元解锁签到")));
  assert.ok(!offerImproved(before, row("暂停注册")));
});

test("a rewritten list is recorded without a card for every row", async () => {
  const many = Array.from({ length: RELAY_LIST_MAX_CHANGES + 1 }, (_, i) =>
    site(`s${i}`, { signup: 1 }),
  );
  const { cursor } = await collect(hub(site("agent", { signup: 1 })), null);
  const result = await collect(hub(...many), cursor!);
  assert.deepEqual(result.candidates, []);
  assert.equal(listed(result.cursor).length, many.length);
});

test("a list with nothing readable fails and keeps the last snapshot", async () => {
  await assert.rejects(collect(hub(), "{}"), /lists no sites/);
});

function fakeStore() {
  const rows = new Map<string, DiscountCandidate>();
  const cursors = new Map<string, string>();
  const store = {
    knownCandidateKeys: async (keys: string[]) =>
      new Set(keys.filter((key) => rows.has(key))),
    createSource: async (kind: string, locator: string) => `${kind}|${locator}`,
    sourceCursor: async (id: string) => cursors.get(id) ?? null,
    saveDiscountCandidate: async (candidate: DiscountCandidate) => {
      rows.set(candidate.dedupeKey, candidate);
      return true;
    },
    saveCursor: async (id: string, cursor: string) =>
      void cursors.set(id, cursor),
    recordSourceFailure: async () => {},
  };
  return { store, rows };
}

const TABLE: RelayListSource = {
  repository: "o/t",
  path: "README.md",
  format: "table",
};
const table = (offer: string) =>
  [
    "| 名称 | 地址 | 免费额度 |",
    "| --- | --- | --- |",
    "| Old | https://old.test | 送 1 |",
    offer ? `| 新站 | https://new.test | ${offer} |` : "",
  ].join("\n");

async function seenThenChanged(
  translate?: (texts: string[]) => Promise<string[]>,
) {
  const { store, rows } = fakeStore();
  let body = table("");
  const run = () =>
    collectDiscountCandidates({
      store: store as never,
      jobs: discountCandidateJobs({
        sources: {
          changelogs: [],
          pullRequests: { repository: "a/b" },
          codeSearch: { queries: [], denylist: [] },
          relayLists: [TABLE],
          operators: [],
        },
        http: { fetch: (async () => new Response(body)) as typeof fetch },
      }),
      ...(translate && { translate }),
    });
  await run();
  body = table("注册送 $5");
  const failures = await run();
  return { rows: [...rows.values()], failures };
}

test("a list's Chinese goes out in Korean", async () => {
  const asked: string[][] = [];
  const { rows, failures } = await seenThenChanged(async (texts) => {
    asked.push(texts);
    return texts.map(() => "새 사이트: 가입 시 $5 지급");
  });
  assert.deepEqual(failures, []);
  // The evidence is already Korean; only the title has Chinese in it.
  assert.deepEqual(asked, [["新站: 注册送 $5"]]);
  assert.deepEqual(
    rows.map(({ title, evidence }) => [title, evidence]),
    [["새 사이트: 가입 시 $5 지급", "o/t 목록에 새로 올라옴"]],
  );
});

test("a failed translation keeps the original and says so", async () => {
  const { rows, failures } = await seenThenChanged(async () => {
    throw new Error("model down");
  });
  assert.deepEqual(
    rows.map(({ title }) => title),
    ["新站: 注册送 $5"],
  );
  assert.deepEqual(failures, ["o/t/README.md: translation: model down"]);
});

test("the shipped free lists skip what the OpenRouter route already watches", async () => {
  const sources = await loadDiscountSources(process.cwd());
  assert.deepEqual(
    sources.freeLists?.map(({ repository, format, exclude }) => [
      repository,
      format,
      exclude,
    ]),
    [
      ["mnfst/awesome-free-llm-apis", "free-llm-apis", ["openrouter.ai"]],
      ["nejib1/Free-LLM", "table", undefined],
    ],
  );
});

test("the shipped lists are the four relay lists", async () => {
  const sources = await loadDiscountSources(process.cwd());
  assert.deepEqual(
    sources.relayLists?.map(({ repository, format }) => [repository, format]),
    [
      ["boyan0928/ai-welfare-hub", "welfare-hub"],
      ["liumowan/Free-API", "stations"],
      ["kirito8/free-newapi", "table"],
      ["yeziqaz/API-Public-Benefits-Sites", "table"],
    ],
  );
});

const FREE: RelayListSource = {
  repository: "o/free",
  path: "data.json",
  format: "free-llm-apis",
  exclude: ["openrouter.ai"],
};
const provider = (
  name: string,
  url: string,
  description: string,
  models: string[],
) => ({
  name,
  url,
  description,
  models: models.map((id) => ({ id })),
});
const freeData = (...providers: unknown[]) => JSON.stringify({ providers });

test("a free list reports new providers and new free models, never reworded limits", async () => {
  const before = freeData(
    provider(
      "Cohere",
      "https://dashboard.cohere.com/api-keys",
      "1,000 calls/month.",
      ["a"],
    ),
    provider("OpenRouter", "https://openrouter.ai/keys", "50 a day.", [
      "x:free",
    ]),
  );
  const after = freeData(
    provider(
      "Cohere",
      "https://dashboard.cohere.com/api-keys",
      "500 calls/month.",
      ["a", "b"],
    ),
    provider("OpenRouter", "https://openrouter.ai/keys", "50 a day.", [
      "x:free",
      "y:free",
    ]),
    provider("Gonka", "https://gonka.test/", "Permanent free tier.", []),
  );
  const route = (body: string) => new RelayListRoute({ fetch: serving(body) });
  const { cursor } = await route(before).collect(FREE, null, "free_list");
  const { candidates } = await route(after).collect(FREE, cursor!, "free_list");
  assert.deepEqual(
    candidates.map((c) => [
      c.route,
      c.dedupeKey.replace(/:[0-9a-f]{12}$/, ":#"),
      c.title,
    ]),
    [
      [
        "free_list",
        "free_list:dashboard.cohere.com:models:#",
        "Cohere: 무료 모델 추가 (b)",
      ],
      ["free_list", "free_list:gonka.test:new", "Gonka: Permanent free tier."],
    ],
  );
});

test("a README table's limit columns are read when there is no credit column", () => {
  const readme = [
    "| Provider | Credit Card? | Daily Limit | Monthly Limit |",
    "|:---|:---:|:---|:---|",
    "| [Mistral](https://console.mistral.ai/) | Phone | - | Free |",
  ].join("\n");
  assert.deepEqual(
    parseRelayList("table", readme).map(({ key, offer }) => [key, offer]),
    [["console.mistral.ai", "Free"]],
  );
});
