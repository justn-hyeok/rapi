import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RELAY_SITE_MAX_CHANGES,
  RelaySiteRoute,
  loadDiscountSources,
} from "@rapi/adapters";

interface Site {
  invitee?: number;
  models?: Array<[string, number, number]>;
  groups?: Record<string, number>;
  notices?: Array<[string, string]>;
}
const SOURCE = { name: "Relay", url: "https://relay.test" };
function serving(site: Site, asked: string[] = []): typeof fetch {
  return (async (url: string) => {
    asked.push(url);
    if (url.endsWith("/api/status"))
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            quota_for_invitee: (site.invitee ?? 25) * 500_000,
            quota_for_inviter: 25 * 500_000,
            quota_per_unit: 500_000,
            announcements: (site.notices ?? []).map(
              ([publishDate, content]) => ({
                publishDate,
                content,
              }),
            ),
          },
        }),
      );
    if (url.endsWith("/api/pricing"))
      return new Response(
        JSON.stringify({
          success: true,
          data: (site.models ?? []).map(([model_name, ratio, completion]) => ({
            model_name,
            quota_type: 0,
            model_ratio: ratio,
            completion_ratio: completion,
          })),
          group_ratio: site.groups ?? { default: 1 },
        }),
      );
    return new Response("missing", { status: 404 });
  }) as typeof fetch;
}
const collect = (site: Site, cursor: string | null, source = SOURCE) =>
  new RelaySiteRoute({ fetch: serving(site) }).collect(source, cursor);
const BASE: Site = {
  models: [
    ["sol", 5, 5],
    ["astra", 2, 4],
  ],
  groups: { default: 1, svip: 2 },
  notices: [["2026-10-01", "签到送 $25"]],
};
async function changed(after: Site) {
  const { cursor } = await collect(BASE, null);
  return (await collect({ ...BASE, ...after }, cursor!)).candidates;
}

test("the first look at a site records it and reports nothing", async () => {
  assert.deepEqual((await collect(BASE, null)).candidates, []);
});

test("a larger bonus, a cut ratio, a free model and a free group come out", async () => {
  const candidates = await changed({
    invitee: 50,
    models: [
      ["sol", 2, 5],
      ["astra", 2, 4],
      ["glm", 0, 0],
    ],
    groups: { default: 1, svip: 2, free: 0 },
  });
  assert.deepEqual(
    candidates.map((c) => [c.dedupeKey, c.title, c.evidence]),
    [
      [
        "relay_site:relay.test:bonus:invitee:50",
        "Relay: 초대받아 가입하면 $50",
        "이전: $25",
      ],
      [
        "relay_site:relay.test:ratio:sol:2:5",
        "Relay: sol 배율 인하",
        "배율 5 → 2, 출력 배율 5 → 5",
      ],
      ["relay_site:relay.test:free:glm:0:0", "Relay: glm 무료", "배율 0"],
      [
        "relay_site:relay.test:group:free:0",
        "Relay: free 그룹 무료",
        "그룹 배율 0",
      ],
    ],
  );
  assert.ok(
    candidates.every(
      (c) =>
        c.route === "relay_site" &&
        c.url === "https://relay.test/" &&
        c.domain === "relay.test",
    ),
  );
});

test("a ratio that rose anywhere, or fell a little, is not a cut", async () => {
  assert.deepEqual(
    await changed({
      models: [
        ["sol", 2, 6],
        ["astra", 1.9, 4],
      ],
      groups: { default: 1, svip: 4 },
    }),
    [],
  );
});

test("a new notice comes out only when it gives something", async () => {
  const candidates = await changed({
    notices: [
      ["2026-10-01", "签到送 $25"],
      [
        "2026-11-01",
        "## 重要通知\ngpt-6.1sol 不限量低倍率供应，建议优先使用。",
      ],
      ["2026-11-02", "probation 分组倍率翻倍"],
      ["2026-11-03", "免费用户速率较慢，请耐心等待"],
      ["2026-11-04", "claude 已调整为限量供应"],
    ],
  });
  assert.deepEqual(
    candidates.map((c) => [c.dedupeKey, c.title]),
    [
      [
        "relay_site:relay.test:notice:2026-11-01",
        "Relay: gpt-6.1sol 不限量低倍率供应，建议优先使用。",
      ],
    ],
  );
});

test("a site whose prices need a login is read for its status only", async () => {
  const asked: string[] = [];
  const route = new RelaySiteRoute({ fetch: serving(BASE, asked) });
  const source = { ...SOURCE, pricing: false };
  const { cursor } = await route.collect(source, null);
  const { candidates } = await new RelaySiteRoute({
    fetch: serving({ ...BASE, invitee: 30 }, asked),
  }).collect(source, cursor!);
  assert.deepEqual(asked, [
    "https://relay.test/api/status",
    "https://relay.test/api/status",
  ]);
  assert.deepEqual(
    candidates.map((c) => c.title),
    ["Relay: 초대받아 가입하면 $30"],
  );
});

test("a rebuilt site is recorded without a card for every row", async () => {
  const candidates = await changed({
    models: Array.from(
      { length: RELAY_SITE_MAX_CHANGES + 1 },
      (_, i): [string, number, number] => [`m${i}`, 0, 0],
    ),
  });
  assert.deepEqual(candidates, []);
});

test("an answer that says it failed is an error, not an empty site", async () => {
  await assert.rejects(
    new RelaySiteRoute({
      fetch: (async () =>
        new Response(JSON.stringify({ success: false }))) as typeof fetch,
    }).collect(SOURCE, null),
    /no success/,
  );
});

test("the shipped relay sites read prices only where they are public", async () => {
  const sources = await loadDiscountSources(process.cwd());
  assert.deepEqual(
    sources.relaySites?.map(({ url, pricing }) => [url, pricing ?? true]),
    [
      ["https://agentrouter.org", true],
      ["https://vsllm.com", true],
      ["https://docode.cc", false],
      ["https://api.hcnsec.cn", false],
    ],
  );
});
