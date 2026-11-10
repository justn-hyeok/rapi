import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DiscordCommands,
  dashboardUrl,
  helpPageUrl,
  requiredCommandAccess,
  signedLinkToken,
  validDashboardLink,
  validHelpToken,
  type DashboardSite,
  type SourceCollection,
} from "@rapi/application";
import {
  dashboardSummary,
  sourceFailing,
  usd,
  type DashboardView,
} from "@rapi/domain";
import { PostgresDashboardStore } from "@rapi/adapters";
import { dashboardPages } from "../apps/bot/src/dashboard-page.js";
import {
  guildCommandDefinitions,
  slashCommandDefinitions,
} from "../apps/bot/src/discord-http.js";

const OWNER = "111222333444555666";
const NOW = new Date("2026-11-10T00:00:00Z");
const EVIL = '<script>alert("x")</script>&';

function view(over: Partial<DashboardView> = {}): DashboardView {
  return {
    jobs: [
      {
        name: "cards",
        running: false,
        lastStartedAt: "2026-11-10T00:00:00Z",
        lastError: EVIL,
      },
      {
        name: "stars",
        running: false,
        lastStartedAt: "2026-11-10T00:00:00Z",
        lastSuccessAt: "2026-11-10T00:01:00Z",
      },
      { name: "curation", running: false },
    ],
    sources: [
      {
        kind: "rss",
        locator: "https://ok.example/feed",
        state: "active",
        lastSuccessAt: "2026-11-10T00:00:00Z",
        lastError: null,
        failureCount: 0,
      },
      {
        kind: "rss",
        locator: `https://bad.example/${EVIL}`,
        state: "active",
        lastSuccessAt: null,
        lastError: EVIL,
        failureCount: 3,
      },
    ],
    candidates: {
      found7d: 12,
      carded7d: 4,
      waiting: 3,
      published: 2,
      discarded: 9,
    },
    models: [
      {
        feature: "translation",
        model: "deepseek-flash",
        calls: 5,
        failures: 1,
        inputTokens: 100,
        outputTokens: 50,
        costMicroUsd: 120_000,
        unpriced: 5,
      },
    ],
    guilds: [
      { name: EVIL, status: "allowed" },
      { name: null, status: "blocked" },
      { name: "대기 서버", status: "pending" },
    ],
    starsActive: 2,
    starsPaused: 1,
    connections: 3,
    ...over,
  };
}

function site(reads = { count: 0 }, source = view()): DashboardSite {
  return {
    secret: "secret",
    baseUrl: "https://rapi.example/",
    ownerIds: [OWNER],
    view: async () => {
      reads.count += 1;
      return source;
    },
  };
}

const get = (value: DashboardSite | undefined, target: URL) =>
  dashboardPages(value)("GET", target);

test("the link belongs to an owner, for one day", () => {
  const value = site();
  const link = new URL(dashboardUrl(value, OWNER, NOW));
  assert.equal(link.pathname, "/dashboard");
  assert.equal(link.origin, "https://rapi.example");
  const token = link.searchParams.get("t");
  assert.ok(validDashboardLink(value, OWNER, token, NOW));
  assert.equal(validDashboardLink(value, "999", token, NOW), false);
  assert.equal(validDashboardLink(value, OWNER, `${token}x`, NOW), false);
  assert.equal(
    validDashboardLink({ ...value, ownerIds: [] }, OWNER, token, NOW),
    false,
  );
  assert.equal(
    validDashboardLink(
      value,
      OWNER,
      token,
      new Date(NOW.getTime() + 2 * 86_400_000),
    ),
    false,
  );
});

test("a help link's token does not open the dashboard", () => {
  const value = site();
  const help = new URL(helpPageUrl(value, OWNER, NOW)).searchParams.get("t");
  assert.equal(validDashboardLink(value, OWNER, help, NOW), false);
});

test("help links keep working after the signing moved", () => {
  const value = { secret: "secret" };
  const token = signedLinkToken("secret", "rapi help link", OWNER, 7, NOW);
  assert.ok(validHelpToken(value, OWNER, token, NOW));
  const issued = new URL(
    helpPageUrl({ ...value, baseUrl: "https://x" }, OWNER, NOW),
  ).searchParams.get("t");
  assert.equal(issued, token);
});

test("without a valid link the page shows nothing and reads nothing", async () => {
  const reads = { count: 0 };
  const value = site(reads);
  for (const target of [
    "http://x/dashboard",
    `http://x/dashboard?u=${OWNER}&t=1.x`,
  ]) {
    const page = await get(value, new URL(target));
    assert.equal(page?.status, 401);
    assert.doesNotMatch(page!.body, /수집원/);
  }
  assert.equal(reads.count, 0);
});

test("other paths and methods are not the dashboard's", async () => {
  const value = site();
  assert.equal(await get(value, new URL("http://x/dashboard/x")), null);
  assert.equal(
    await dashboardPages(value)("POST", new URL("http://x/dashboard")),
    null,
  );
  assert.equal(await get(undefined, new URL("http://x/dashboard")), null);
});

async function openPage(source = view()) {
  const value = site({ count: 0 }, source);
  const link = new URL(dashboardUrl(value, OWNER, new Date()));
  const page = await get(value, link);
  assert.equal(page?.status, 200);
  assert.equal(page.type, "text/html");
  return { body: page!.body, link };
}

test("everything from outside is escaped and the token stays out", async () => {
  const { body, link } = await openPage();
  assert.equal(body.includes("<script"), false);
  assert.ok(body.includes("&lt;script&gt;"));
  assert.equal(body.includes(link.searchParams.get("t")!), false);
  assert.doesNotMatch(body, /<form|<button|<input/);
});

test("the page shows every panel with real numbers", async () => {
  const { body } = await openPage();
  for (const text of [
    "카드 보내기",
    "실패",
    "아직 안 돌았어요",
    "전체 2개, 실패 1개",
    "7일간 찾음 12",
    "검토 대기 3",
    "deepseek-flash",
    "$0.12 (가격 모름 5건)",
    "승인",
    "차단",
    "이름 없음",
    "스타 알림 받는 중 2명",
    "계정 연결 3명",
  ])
    assert.ok(body.includes(text), text);
  assert.ok(
    body.indexOf("bad.example") < body.indexOf("ok.example"),
    "failing sources come first",
  );
});

test("times are shown in KST", async () => {
  const { body } = await openPage();
  assert.ok(body.includes("2026-11-10 09:01"));
});

test("an empty database still renders", async () => {
  const { body } = await openPage(
    view({
      jobs: [],
      sources: [],
      models: [],
      guilds: [],
      candidates: {
        found7d: 0,
        carded7d: 0,
        waiting: 0,
        published: 0,
        discarded: 0,
      },
      starsActive: 0,
      starsPaused: 0,
      connections: 0,
    }),
  );
  assert.ok(body.includes("이번 달 사용 기록이 없어요."));
  assert.ok(body.includes("등록된 서버가 없어요."));
});

test("a read failure is said plainly", async () => {
  const value = site();
  value.view = async () => {
    throw new Error("db down");
  };
  const page = await get(
    value,
    new URL(dashboardUrl(value, OWNER, new Date())),
  );
  assert.equal(page?.status, 500);
  assert.equal(page.body.includes("db down"), false);
});

test("the Discord summary counts what matters and names the failures", () => {
  const text = dashboardSummary(view(), "https://rapi.example/dashboard?x");
  assert.ok(text.startsWith("**라피 대시보드**\n작업: 3개 중 실패 1개\n"));
  assert.match(text, /^- 카드 보내기: /m);
  assert.ok(text.includes("\\<script"));
  assert.ok(text.includes("수집원: 2개 중 실패 1개"));
  assert.ok(
    text.includes("후보: 7일간 찾음 12 · 카드 4 · 대기 3 · 게시 2 · 버림 9"),
  );
  assert.ok(
    text.includes("모델 이번 달: 호출 5 · 실패 1 · $0.12 · 가격 모름 5건"),
  );
  assert.ok(text.includes("서버: 승인 1 · 대기 1 · 차단 1"));
  assert.ok(text.includes("스타 알림: 2명 받는 중 · 1명 멈춤"));
  assert.ok(text.includes("자세히: <https://rapi.example/dashboard?x>"));
  assert.doesNotMatch(dashboardSummary(view()), /자세히|undefined/);
  assert.doesNotMatch(
    dashboardSummary(view({ models: [] })),
    /가격 모름|NaN|undefined/,
  );
});

test("small helpers", () => {
  assert.equal(usd(0), "$0.00");
  assert.equal(usd(1_234_567), "$1.23");
  assert.equal(sourceFailing(view().sources[0]!), false);
  assert.equal(sourceFailing(view().sources[1]!), true);
});

test("only the owner can run it, and only home sees it", async () => {
  assert.equal(requiredCommandAccess("dashboard"), "superadmin");
  const names = (guild: string) =>
    guildCommandDefinitions(guild, "home").map((command) => command.name);
  assert.ok(names("home").includes("대시보드"));
  assert.equal(names("other").includes("대시보드"), false);
  assert.ok(slashCommandDefinitions.some((c) => c.name === "대시보드"));

  let reads = 0;
  const commands = new DiscordCommands(
    {} as SourceCollection,
    { userIds: [OWNER], guildMembersAreUsers: true },
    {
      status: async () => "",
      guildAllowlist: async () => ["home"],
      dashboard: async () => {
        reads += 1;
        return "요약";
      },
    },
  );
  const identity = { guildId: "home", channelId: "c", roleIds: [] };
  await assert.rejects(
    commands.execute(
      { ...identity, userId: "999" },
      { name: "dashboard", options: {} },
    ),
    /소유자만/,
  );
  assert.equal(reads, 0);
  const result = await commands.execute(
    { ...identity, userId: OWNER },
    { name: "dashboard", options: {} },
  );
  assert.deepEqual(result.messages, ["요약"]);
});

test("the store turns Postgres strings into numbers and dates into strings", async () => {
  const pool = {
    async query(sql: string) {
      if (/source_cursors/.test(sql))
        return {
          rows: [
            {
              kind: "rss",
              locator: "u",
              state: "active",
              last_success_at: new Date("2026-11-10T00:00:00Z"),
              last_error: null,
              failure_count: "2",
            },
          ],
        };
      if (/discount_candidates/.test(sql))
        return {
          rows: [
            {
              found7d: "1",
              carded7d: "2",
              waiting: "3",
              published: "4",
              discarded: "5",
            },
          ],
        };
      if (/model_usage/.test(sql))
        return {
          rows: [
            {
              feature: "t",
              model: "m",
              calls: "6",
              failures: "1",
              input_tokens: "7",
              output_tokens: "8",
              cost_micro_usd: "9",
              unpriced: "6",
            },
          ],
        };
      if (/discord_guilds/.test(sql))
        return { rows: [{ name: "g", status: "allowed" }] };
      if (/star_subscribers/.test(sql))
        return { rows: [{ active: "2", paused: "1" }] };
      return { rows: [{ count: "4" }] };
    },
  };
  const numbers = await new PostgresDashboardStore({
    pool,
  } as never).dashboardNumbers(NOW);
  assert.equal(numbers.sources[0]!.failureCount, 2);
  assert.equal(numbers.sources[0]!.lastSuccessAt, "2026-11-10T00:00:00.000Z");
  assert.equal(numbers.candidates.discarded, 5);
  assert.deepEqual(numbers.models[0], {
    feature: "t",
    model: "m",
    calls: 6,
    failures: 1,
    inputTokens: 7,
    outputTokens: 8,
    costMicroUsd: 9,
    unpriced: 6,
  });
  assert.equal(numbers.starsActive, 2);
  assert.equal(numbers.starsPaused, 1);
  assert.equal(numbers.connections, 4);
});
