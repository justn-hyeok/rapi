import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cleanInterests,
  remindStars,
  starInterestUrl,
  starVoteButton,
  validStarToken,
  type StarInterestPage,
  type StarInterestSite,
} from "@rapi/application";
import {
  combinedInterests,
  facetCatalog,
  interestQueries,
  interestReason,
  pickFoundRepo,
  pickInterestingStar,
  repoFacets,
  type GitHubStar,
  type StoredStar,
} from "@rapi/domain";
import { starPages } from "../apps/bot/src/star-page.js";

const now = new Date("2026-11-07T00:30:00Z");
const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000);
const repo = (
  fullName: string,
  fields: Partial<StoredStar> = {},
): StoredStar => ({
  fullName,
  url: `https://github.com/${fullName}`,
  description: "",
  language: null,
  stars: 10,
  archived: false,
  starredAt: daysAgo(400),
  lastRemindedAt: null,
  ...fields,
});

const tui = repo("a/ratatui-thing", {
  description: "A terminal UI toolkit",
  language: "Rust",
  stars: 4_200,
  topics: ["tui", "terminal", "rust"],
  pushedAt: daysAgo(3),
  createdAt: daysAgo(800),
  ownerType: "Organization",
  license: "MIT",
});

test("a repository's facets cover language, field, form, size, activity, age, maker, license and topics", () => {
  const facets = repoFacets(tui, now);
  for (const key of [
    "언어:Rust",
    "분야:터미널·TUI",
    "규모:★1천–1만",
    "활동:이번 달에도 고침",
    "나이:1–3년",
    "만든 쪽:회사·단체",
    "라이선스:MIT·Apache 등 허용적",
    "topic:tui",
  ])
    assert.ok(facets.includes(key), key);
  const list = repoFacets(
    repo("b/awesome-mcp", {
      description: "A curated list of MCP servers",
      stars: 60,
      license: null,
    }),
    now,
  );
  assert.ok(list.includes("형태:목록·자료 모음"));
  assert.ok(list.includes("분야:MCP"));
  assert.ok(list.includes("규모:★100 미만 (숨은 것)"));
  assert.ok(list.includes("라이선스:라이선스 없음·기타"));
  // Unknown dates and licenses say nothing rather than guess.
  const bare = repoFacets(repo("c/d"), now);
  assert.ok(!bare.some((key) => /^(활동|나이|만든 쪽|라이선스):/.test(key)));
});

test("the catalog counts stars per facet and drops a topic only one star has", () => {
  const catalog = facetCatalog(
    [tui, repo("x/other-tui", { topics: ["tui"], language: "Go" })],
    now,
  );
  const tuiTopic = catalog.find((entry) => entry.key === "topic:tui");
  assert.equal(tuiTopic?.count, 2);
  assert.deepEqual(tuiTopic!.examples, ["a/ratatui-thing", "x/other-tui"]);
  assert.equal(
    catalog.find((entry) => entry.key === "topic:rust"),
    undefined,
  );
  // Fields come before languages, which come before topics.
  const groups = catalog.map((entry) => entry.key.split(":")[0]);
  assert.ok(groups.indexOf("분야") < groups.indexOf("언어"));
  assert.ok(groups.indexOf("언어") < groups.indexOf("topic"));
});

test("votes nudge the page's choices and every weight stays within -1..1", () => {
  const weights = combinedInterests({ "언어:Rust": 1, "언어:Go": -1 }, [
    { vote: 1, facets: ["언어:Rust", "분야:게임"] },
    { vote: -1, facets: ["언어:Go"] },
    { vote: 1, facets: ["분야:게임"] },
  ]);
  assert.equal(weights["언어:Rust"], 1);
  assert.equal(weights["언어:Go"], -1);
  assert.equal(weights["분야:게임"], 0.5);
});

test("the star that fits best wins, and size or license alone never picks one", () => {
  const python = repo("p/ml", {
    description: "deep learning training",
    language: "Python",
    stars: 4_200,
  });
  const interests = { "분야:터미널·TUI": 1, "언어:Python": -1 };
  const picked = pickInterestingStar([python, tui], interests, now, () => 0);
  assert.equal(picked?.repo.fullName, "a/ratatui-thing");
  assert.equal(picked!.reason, "터미널·TUI");
  assert.equal(
    pickInterestingStar([tui], { "규모:★1천–1만": 1 }, now, () => 0),
    null,
  );
  // Recently reminded stars are not forgotten, whatever they fit.
  assert.equal(
    pickInterestingStar(
      [{ ...tui, lastRemindedAt: daysAgo(10) }],
      interests,
      now,
    ),
    null,
  );
});

test("a found repository skips what the owner has seen", () => {
  const found = [
    { ...tui, fullName: "seen/one" },
    { ...tui, fullName: "new/two", stars: 900 },
  ];
  const pick = pickFoundRepo(
    found,
    new Set(["seen/one"]),
    { "분야:터미널·TUI": 1 },
    now,
  );
  assert.equal(pick?.repo.fullName, "new/two");
});

test("the reason lists fields first and marks topics", () => {
  assert.equal(
    interestReason(["topic:tui", "언어:Rust", "분야:터미널·TUI"]),
    "터미널·TUI · Rust · #tui",
  );
});

test("searches use liked topics and fields, in a liked language and size", () => {
  const queries = interestQueries(
    {
      "topic:mcp-server": 1,
      "분야:터미널·TUI": 0.5,
      "언어:Rust": 1,
      "규모:★1천–1만": 1,
      "분야:게임": -1,
    },
    now,
  );
  assert.equal(queries.length, 2);
  assert.match(
    queries[0]!,
    /^topic:mcp-server language:"Rust" stars:1000\.\.10000 pushed:>2026-08-09/,
  );
  assert.match(queries[1]!, /^topic:tui /);
  assert.ok(!queries.some((query) => query.includes("gamedev")));
});

const page = (
  store: Partial<StarInterestPage["store"]> = {},
): StarInterestPage => ({
  store: store as StarInterestPage["store"],
  ownerId: "42",
  secret: "deployment-secret",
  baseUrl: "https://rapi.example/",
});

// Everyone's pages over one store per person; only "42" is connected.
const siteOf = (
  stores: Record<string, Partial<StarInterestPage["store"]>>,
  defaultOwnerId?: string,
): StarInterestSite => ({
  store: {
    starsOf: (owner) => (stores[owner] ?? {}) as StarInterestPage["store"],
    starSubscriber: async (userId) => (userId === "42" ? { userId } : null),
  },
  secret: "deployment-secret",
  baseUrl: "https://rapi.example/",
  defaultOwnerId,
});

test("the link is signed for the owner and expires after a week", () => {
  const url = new URL(starInterestUrl(page(), now));
  assert.equal(url.origin + url.pathname, "https://rapi.example/stars");
  assert.equal(url.searchParams.get("u"), "42");
  const token = url.searchParams.get("t");
  assert.equal(validStarToken(page(), token, now), true);
  assert.equal(
    validStarToken(page(), token, new Date(now.getTime() + 8 * 86_400_000)),
    false,
  );
  assert.equal(validStarToken({ ...page(), ownerId: "43" }, token, now), false);
  assert.equal(
    validStarToken({ ...page(), secret: "other" }, token, now),
    false,
  );
  assert.equal(validStarToken(page(), null, now), false);
  assert.equal(validStarToken(page(), "garbage", now), false);
});

test("saved choices keep only well-formed keys and weights", () => {
  assert.deepEqual(
    cleanInterests({
      facets: {
        "언어:Rust": 1,
        "분야:게임": -1,
        "topic:tui": 0.5,
        "규모:x": 3,
        nocolon: 1,
        "언어:Go": "1",
      },
    }),
    { "언어:Rust": 1, "분야:게임": -1, "topic:tui": 0.5 },
  );
  assert.throws(() => cleanInterests({ facets: [] }));
  assert.throws(() => cleanInterests(null));
});

test("the page answers only with a valid token, and saves what it was sent", async () => {
  let saved: unknown;
  const site = siteOf(
    {
      "42": {
        currentStars: async () => [tui],
        starInterests: async () => ({
          picked: { "언어:Rust": 1 },
          votes: [],
        }),
        saveStarInterests: async (facets) => {
          saved = facets;
        },
      },
    },
    "42",
  );
  const handle = starPages(site);
  const link = new URL(starInterestUrl(page(), new Date()));
  const token = link.searchParams.get("t")!;
  const at = (path: string) => new URL(`http://x${path}`);
  const none = async () => Buffer.from("");
  assert.equal(await handle("GET", at("/interactions"), none), null);
  assert.equal((await handle("GET", at("/stars?t=bad"), none))?.status, 401);
  assert.equal((await handle("GET", at("/stars/data"), none))?.status, 401);
  // A token is one person's: it opens nobody else's page.
  assert.equal(
    (await handle("GET", at(`/stars?u=43000&t=${token}`), none))?.status,
    401,
  );
  assert.equal(
    (await handle("GET", at(`/stars?u=x&t=${token}`), none))?.status,
    401,
  );
  // A link from before links named their owner opens the configured owner's page.
  assert.equal(
    (await handle("GET", at(`/stars?t=${token}`), none))?.status,
    200,
  );
  const html = await handle("GET", at(`/stars?u=42&t=${token}`), none);
  assert.equal(html?.type, "text/html");
  assert.match(html!.body, /스타 관심사/);
  const data = JSON.parse(
    (await handle("GET", at(`/stars/data?u=42&t=${token}`), none))!.body,
  ) as { stars: number; picked: unknown; catalog: Array<{ key: string }> };
  assert.equal(data.stars, 1);
  assert.deepEqual(data.picked, { "언어:Rust": 1 });
  assert.ok(data.catalog.some((entry) => entry.key === "분야:터미널·TUI"));
  const post = await handle(
    "POST",
    at(`/stars/interests?u=42&t=${token}`),
    async () => Buffer.from(JSON.stringify({ facets: { "topic:tui": 1 } })),
  );
  assert.equal(post?.status, 200);
  assert.deepEqual(saved, { "topic:tui": 1 });
  assert.equal(
    (
      await handle("POST", at(`/stars/interests?u=42&t=${token}`), async () =>
        Buffer.from("not json"),
      )
    )?.status,
    400,
  );
});

test("a vote counts only from someone connected, for them, with the repository's facets", async () => {
  const votes: unknown[] = [];
  const site = siteOf({
    "42": {
      starRepo: async (name) =>
        name === "a/ratatui-thing"
          ? { ...tui, starredAt: tui.starredAt.toISOString(), pushedAt: null }
          : null,
      saveStarVote: async (...args) => {
        votes.push(args);
      },
    },
  });
  const content = (reply: unknown) =>
    (reply as { data: { content: string } }).data.content;
  assert.match(
    content(
      await starVoteButton(
        site,
        { userId: "70000" },
        "star_vote:1:a/ratatui-thing",
        now,
      ),
    ),
    /받는 사람만/,
  );
  assert.match(
    content(
      await starVoteButton(
        site,
        { userId: "42" },
        "star_vote:-1:a/ratatui-thing",
        now,
      ),
    ),
    /다시 보내지 않고/,
  );
  assert.equal(votes.length, 1);
  const [name, vote, facets] = votes[0] as [string, number, string[]];
  assert.deepEqual([name, vote], ["a/ratatui-thing", -1]);
  assert.ok(facets.includes("분야:터미널·TUI"));
  assert.match(
    content(
      await starVoteButton(site, { userId: "42" }, "star_vote:1:no/such", now),
    ),
    /찾지 못했습니다/,
  );
  assert.match(
    content(
      await starVoteButton(site, { userId: "42" }, "star_vote:x:a/b", now),
    ),
    /알 수 없는/,
  );
});

test("with interests the DM brings the best forgotten star and one new repository", async () => {
  const stored = new Map<string, StoredStar>([
    [tui.fullName, tui],
    [
      "p/ml",
      repo("p/ml", { description: "deep learning", language: "Python" }),
    ],
    ["down/tui", { ...tui, fullName: "down/tui" }],
  ]);
  const suggested: string[] = [];
  const claimed: string[][] = [];
  const queries: string[][] = [];
  let payload: { discord?: { embeds?: unknown[]; components?: unknown[] } } =
    {};
  const found: GitHubStar = {
    ...tui,
    fullName: "new/tui-kit",
    url: "https://github.com/new/tui-kit",
    starredAt: now.toISOString(),
    pushedAt: daysAgo(2).toISOString(),
    createdAt: daysAgo(100).toISOString(),
  };
  const failures = await remindStars({
    now,
    random: () => 0,
    ownerId: "42",
    reads: {},
    readStars: async () => ({ stars: [], complete: false }),
    searchRepos: async (q) => {
      queries.push(q);
      return [{ ...found, fullName: "a/ratatui-thing" }, found];
    },
    interestUrl: () => "https://rapi.example/stars?t=x",
    delivery: {
      async send(_target, sent) {
        payload = sent as typeof payload;
        return { providerId: "m1" };
      },
    },
    store: {
      saveStars: async () => {},
      currentStars: async () => [...stored.values()],
      starReminderClaimed: async () => false,
      claimStarReminder: async (_day, stars) => {
        claimed.push(stars.map((star) => star.fullName));
        return true;
      },
      releaseStarReminder: async () => {},
      saveStarReminderMessage: async () => {},
      starInterests: async () => ({
        picked: { "분야:터미널·TUI": 1 },
        votes: [{ fullName: "down/tui", vote: -1, facets: [] }],
      }),
      seenStarRepos: async () =>
        new Set([...stored.keys()].map((name) => name.toLowerCase())),
      saveStarSuggestion: async (repo) => {
        suggested.push(repo.fullName);
      },
    },
  });
  assert.deepEqual(failures, []);
  assert.deepEqual(claimed, [["a/ratatui-thing", "new/tui-kit"]]);
  assert.deepEqual(suggested, ["new/tui-kit"]);
  assert.match(queries[0]![0]!, /^topic:tui /);
  const embeds = payload.discord!.embeds as Array<{
    author?: { name: string };
    description: string;
  }>;
  assert.equal(embeds[0]!.author?.name, "잊고 있던 스타");
  assert.equal(embeds[1]!.author?.name, "새로 찾은 저장소");
  assert.match(embeds[0]!.description, /관심사.*터미널·TUI/);
  const rows = payload.discord!.components as Array<{
    components: Array<{ label: string; url?: string }>;
  }>;
  assert.equal(rows.length, 3);
  assert.equal(rows[2]!.components[0]!.label, "관심사 고르기");
});
