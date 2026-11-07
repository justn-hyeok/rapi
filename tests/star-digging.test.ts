import assert from "node:assert/strict";
import { test } from "node:test";
import { digTrails, followNeighbors } from "@rapi/adapters";
import { remindStars } from "@rapi/agent";
import {
  betaDraw,
  closeNeighbors,
  digSeeds,
  neighborTaste,
  notability,
  pickDug,
  rankDug,
  restingFromHistory,
  type DugRepo,
  type DigTrail,
  type GitHubStar,
  type StoredStar,
} from "@rapi/core";

const now = new Date("2026-11-08T00:30:00Z");
const daysAgo = (days: number) =>
  new Date(now.getTime() - days * 86_400_000).toISOString();
const repo = (
  fullName: string,
  fields: Partial<GitHubStar> = {},
): GitHubStar => ({
  fullName,
  url: `https://github.com/${fullName}`,
  description: `${fullName} does things`,
  language: null,
  stars: 500,
  archived: false,
  starredAt: daysAgo(5),
  pushedAt: daysAgo(10),
  ...fields,
});
const stored = (
  fullName: string,
  fields: Partial<GitHubStar> = {},
): StoredStar => {
  const base = repo(fullName, fields);
  return { ...base, starredAt: new Date(base.starredAt), lastRemindedAt: null };
};

// The owner's stars, which a neighbor with taste shares a few of.
const mine = ["me/a", "me/b", "me/c", "me/d"].map((name) => stored(name));
const tasteful = (login: string, extra: GitHubStar[]) => ({
  login,
  starred: [...mine.map((star) => repo(star.fullName)), ...extra],
});

test("a find is worth most between a hundred and three thousand stars", () => {
  assert.equal(notability(500), 1);
  assert.ok(notability(10) < notability(100));
  assert.ok(notability(50_000) < notability(3000));
  assert.ok(notability(30_000) > 0.4);
});

test("seeds favor liked repositories and skip giants and tiny ones", () => {
  const stars = [
    stored("big/giant", { stars: 200_000, starredAt: daysAgo(1) }),
    stored("tiny/one", { stars: 3, starredAt: daysAgo(1) }),
    stored("ok/recent", { starredAt: daysAgo(2) }),
  ];
  const seeds = digSeeds({
    stars,
    liked: [repo("loved/one")],
    interests: {},
    now,
    random: () => 0,
  });
  assert.deepEqual(seeds, ["loved/one", "ok/recent"]);
  assert.deepEqual(
    digSeeds({ stars, liked: [], interests: {}, now, count: 1 }),
    ["ok/recent"],
  );
});

test("a repository two neighbors with taste starred beats a famous one", () => {
  const gem = repo("x/gem", { stars: 800 });
  const famous = repo("x/famous", { stars: 45_000 });
  const trails: DigTrail[] = [
    {
      seed: "me/a",
      neighbors: [
        tasteful("n1", [gem, famous]),
        tasteful("n2", [gem, famous]),
        { login: "n3", starred: [repo("x/lonely")] },
      ],
      maker: [],
      contributors: [],
    },
  ];
  const ranked = rankDug({
    trails,
    ownStars: mine,
    seen: new Set(),
    interests: {},
    now,
  });
  assert.deepEqual(
    ranked.map((dug) => dug.repo.fullName),
    ["x/gem", "x/famous"],
  );
  assert.equal(
    ranked[0]!.trail,
    "a 쓰는 사람 2명이 스타 누름 (모두 내 스타와 많이 겹침)",
  );
});

test("a dig skips what the owner has seen, their own work and personal pages", () => {
  const people = (extra: GitHubStar[]) => [
    tasteful("n1", extra),
    tasteful("n2", extra),
  ];
  const ranked = rankDug({
    trails: [
      {
        seed: "me/a",
        neighbors: people([
          repo("x/seen"),
          repo("self/tool"),
          repo("x/portfolio"),
          repo("x/x.github.io"),
          repo("bob/bob.v2"),
          repo("x/nodesc", { description: " " }),
          repo("x/stale", { pushedAt: daysAgo(1000) }),
          repo("x/hated", { language: "PHP" }),
          repo("x/keep"),
        ]),
        maker: [],
        contributors: [],
      },
    ],
    ownStars: mine,
    seen: new Set(["x/seen"]),
    self: "Self",
    interests: { "언어:PHP": -1 },
    now,
  });
  assert.deepEqual(
    ranked.map((dug) => dug.repo.fullName),
    ["x/keep"],
  );
});

test("a maker's other work needs a voucher or the owner's interests", () => {
  const trails: DigTrail[] = [
    {
      seed: "me/a",
      neighbors: [],
      maker: [
        repo("me/a"),
        repo("me/plain"),
        repo("me/rusty", { language: "Rust" }),
      ],
      contributors: [{ login: "carol", repos: [repo("carol/lib")] }],
    },
  ];
  const ranked = rankDug({
    trails,
    ownStars: [],
    seen: new Set(),
    interests: { "언어:Rust": 1 },
    now,
  });
  assert.deepEqual(
    ranked.map((dug) => [dug.repo.fullName, dug.trail, dug.reason]),
    [["me/rusty", "a 만든 사람의 다른 저장소", "Rust"]],
  );
  const vouched = rankDug({
    trails: [
      {
        ...trails[0]!,
        neighbors: [tasteful("n1", [repo("carol/lib")])],
      },
    ],
    ownStars: mine,
    seen: new Set(),
    interests: {},
    now,
  });
  assert.deepEqual(
    vouched.map((dug) => [dug.repo.fullName, dug.trail, dug.kind]),
    [
      [
        "carol/lib",
        "a 쓰는 사람 1명이 스타 누름 (내 스타와 많이 겹치는 사람) · a 기여자 carol의 저장소",
        "people",
      ],
    ],
  );
  assert.equal(pickDug([], { random: () => 0 }), null);
});

test("a maker's other work that only matches on size or license is no find", () => {
  // The way a random exploit repository once came through: a liked size alone.
  const ranked = rankDug({
    trails: [
      {
        seed: "me/a",
        neighbors: [],
        maker: [repo("me/exploit", { stars: 500 })],
        contributors: [],
      },
    ],
    ownStars: [],
    seen: new Set(),
    interests: { "규모:★100–1천": 1, "활동:이번 달에도 고침": 1 },
    now,
  });
  assert.deepEqual(ranked, []);
});

test("a neighbor with few stars to judge by counts less, and a forker less again", () => {
  assert.ok(neighborTaste(1, 5) < neighborTaste(15, 100));
  assert.ok(neighborTaste(0, 100) < 0.4);
  assert.equal(neighborTaste(40, 100), 2);
  const score = (role: "issue" | "fork") =>
    rankDug({
      trails: [
        {
          seed: "me/a",
          neighbors: [
            { ...tasteful("n1", [repo("x/gem")]), role },
            { ...tasteful("n2", [repo("x/gem")]), role },
          ],
          maker: [],
          contributors: [],
        },
      ],
      ownStars: mine,
      seen: new Set(),
      interests: {},
      now,
    })[0]!.score;
  assert.ok(score("fork") < score("issue") * 0.7);
});

test("thumbs down weaken the neighbors who liked it and rest its maker", () => {
  const trails = (extra: GitHubStar[]): DigTrail[] => [
    {
      seed: "me/a",
      neighbors: [
        tasteful("n1", [repo("x/gem"), ...extra]),
        tasteful("n2", [repo("x/gem"), ...extra]),
      ],
      maker: [],
      contributors: [],
    },
  ];
  const base = { ownStars: mine, seen: new Set<string>(), interests: {}, now };
  const plain = rankDug({ ...base, trails: trails([]) })[0]!.score;
  const soured = rankDug({
    ...base,
    trails: trails([repo("bad/one"), repo("bad/two")]),
    disliked: new Set(["bad/one", "bad/two"]),
  }).find((dug) => dug.repo.fullName === "x/gem")!.score;
  assert.ok(soured < plain * 0.6);
  assert.deepEqual(
    rankDug({
      ...base,
      trails: trails([]),
      restingOwners: new Set(["x"]),
    }),
    [],
  );
});

test("a kept neighbor's stars count, alone only when they share many", () => {
  const kept = (shared: number) =>
    rankDug({
      trails: [],
      kept: [{ login: "pal", shared, starred: [repo("x/deep")] }],
      ownStars: mine,
      seen: new Set(),
      interests: {},
      now,
    });
  assert.deepEqual(kept(3), []);
  const [found] = kept(8);
  assert.equal(found!.trail, "취향 이웃 pal의 스타");
  assert.equal(found!.kind, "kept");
  assert.equal(found!.seed, "@pal");
  assert.deepEqual(
    closeNeighbors(
      [
        {
          seed: "me/a",
          neighbors: [
            tasteful("pal", []),
            { login: "far", starred: [repo("me/b"), repo("z/z")] },
          ],
          maker: [],
          contributors: [],
        },
      ],
      mine,
    ),
    // The seed itself is no shared star.
    [{ login: "pal", shared: 3, from: "me/a" }],
  );
});

test("history rests a maker shown lately and the seed of a thumbed-down find", () => {
  const resting = restingFromHistory(
    [
      {
        fullName: "Recent/one",
        kind: "people",
        seed: "me/a",
        suggestedAt: daysAgo(3),
        vote: null,
        votedAt: null,
      },
      {
        fullName: "old/two",
        kind: "maker",
        seed: "Me/B",
        suggestedAt: daysAgo(40),
        vote: -1,
        votedAt: daysAgo(10),
      },
      {
        fullName: "older/three",
        kind: "maker",
        seed: "me/c",
        suggestedAt: daysAgo(90),
        vote: -1,
        votedAt: daysAgo(60),
      },
    ],
    new Date(now),
  );
  assert.deepEqual([...resting.owners].sort(), ["old", "recent"]);
  assert.deepEqual([...resting.seeds], ["me/b"]);
  const seeds = digSeeds({
    stars: [
      stored("me/b", { starredAt: daysAgo(1) }),
      stored("me/c", { starredAt: daysAgo(2) }),
    ],
    liked: [],
    interests: {},
    now,
    random: () => 0.4,
    count: 1,
    resting: resting.seeds,
  });
  // me/b weighs half, so a roll that would land on it now lands on me/c.
  assert.deepEqual(seeds, ["me/c"]);
});

test("a beta draw stays in range and follows its counts", () => {
  let seed = 7;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const mean = (a: number, b: number) =>
    Array.from({ length: 400 }, () => betaDraw(a, b, random)).reduce(
      (sum, value) => sum + value,
      0,
    ) / 400;
  assert.ok(mean(9, 1) > 0.8);
  assert.ok(mean(1, 9) < 0.2);
  const draw = betaDraw(500, 3, random);
  assert.ok(draw >= 0 && draw <= 1);
});

test("the pick draws a way by its thumbs, one a seed, and skips ways far behind", () => {
  const dug = (
    name: string,
    kind: DugRepo["kind"],
    seed: string,
    score: number,
  ): DugRepo => ({
    repo: repo(name),
    reason: "",
    trail: "",
    kind,
    seed,
    score,
  });
  const ranked = [
    dug("p/one", "people", "me/a", 3),
    dug("p/two", "people", "me/a", 2.9),
    dug("p/three", "people", "me/b", 2.8),
    dug("m/one", "maker", "me/c", 2.5),
    dug("f/one", "followed", "me/d", 0.5),
  ];
  const outcome = (kind: string, vote: number) => ({
    fullName: "o/x",
    kind,
    seed: "s",
    suggestedAt: daysAgo(30),
    vote,
    votedAt: daysAgo(29),
  });
  const history = [
    ...Array.from({ length: 12 }, () => outcome("maker", 1)),
    ...Array.from({ length: 12 }, () => outcome("people", -1)),
    ...Array.from({ length: 12 }, () => outcome("followed", 1)),
  ];
  let calls = 0;
  const random = () => ((calls += 1), (calls * 0.37) % 1);
  const counts = new Map<string, number>();
  for (let day = 0; day < 30; day += 1) {
    const pick = pickDug(ranked, { random, history })!;
    counts.set(pick.kind, (counts.get(pick.kind) ?? 0) + 1);
  }
  // The maker way pleased and wins most days; the followed way is far behind.
  assert.ok((counts.get("maker") ?? 0) > 20);
  assert.equal(counts.get("followed"), undefined);
  // Without history, a people day offers one a seed: p/one or p/three.
  const seen = new Set<string>();
  for (let day = 0; day < 40; day += 1) {
    const pick = pickDug(ranked, { random })!;
    if (pick.kind === "people") seen.add(pick.repo.fullName);
  }
  assert.deepEqual([...seen].sort(), ["p/one", "p/three"]);
});

const json = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) => new Response(JSON.stringify(body), { status, headers });

test("digging reads the people around a seed, its maker and contributors", async () => {
  const requested: string[] = [];
  const user = (login: string) => ({ login, type: "User" });
  const trails = await digTrails(["owner/seed", "bad name", "owner/two"], "t", {
    fetch: (async (url: string) => {
      const path = url.replace("https://api.github.com/", "");
      requested.push(path);
      if (path.includes("/stargazers"))
        return json({ message: "Resource not accessible" }, 403);
      if (path.startsWith("repos/owner/seed/issues"))
        return json([
          { user: user("ann") },
          { user: { login: "dependabot[bot]", type: "Bot" } },
          { user: user("owner") },
        ]);
      if (path.startsWith("repos/owner/seed/forks"))
        return json([{ owner: user("ben") }, { owner: user("ann") }]);
      if (path.startsWith("repos/owner/seed/contributors"))
        return json([
          user("owner"),
          user("cid"),
          { login: "bot", type: "Bot" },
        ]);
      if (path.startsWith("users/ann/starred"))
        return json([
          {
            starred_at: daysAgo(1),
            repo: { full_name: "z/liked", stargazers_count: 40 },
          },
          {
            starred_at: daysAgo(1),
            repo: { full_name: "z/forked", fork: true },
          },
        ]);
      if (path.startsWith("users/ben/starred")) return json({}, 404);
      if (path.startsWith("users/owner/repos"))
        return json([{ full_name: "owner/other", stargazers_count: 9 }]);
      if (path.startsWith("users/cid/repos"))
        return json([{ full_name: "cid/tool" }]);
      return json([]);
    }) as typeof fetch,
  });
  assert.deepEqual(
    trails.map((trail) => trail.seed),
    ["owner/seed", "owner/two"],
  );
  const [first] = trails;
  assert.deepEqual(
    first!.neighbors.map((n) => [n.login, n.starred.map((r) => r.fullName)]),
    [
      ["ann", ["z/liked"]],
      ["ben", []],
    ],
  );
  assert.deepEqual(
    first!.maker.map((r) => r.fullName),
    ["owner/other"],
  );
  assert.deepEqual(
    first!.contributors.map((c) => [c.login, c.repos.map((r) => r.fullName)]),
    [["cid", ["cid/tool"]]],
  );
  // A token that may not list stargazers is not asked again for the next seed.
  assert.equal(
    requested.filter((path) => path.includes("/stargazers")).length,
    1,
  );
});

test("the day's new repository is dug first and says how it was found", async () => {
  const claimed: string[][] = [];
  let embeds: Array<{ description?: string }> = [];
  let searched = false;
  const seed = stored("me/a", { stars: 300 });
  const failures = await remindStars({
    now,
    random: () => 0,
    ownerId: "42",
    reads: {},
    readStars: async () => ({ stars: [], complete: false }),
    digTrails: async (seeds) => [
      {
        seed: seeds[0]!,
        neighbors: [
          tasteful("n1", [repo("x/gem")]),
          tasteful("n2", [repo("x/gem")]),
        ],
        maker: [],
        contributors: [],
      },
    ],
    searchRepos: async () => {
      searched = true;
      return [];
    },
    githubLogin: "me",
    delivery: {
      async send(_target, sent) {
        embeds = (sent.discord?.embeds ?? []) as typeof embeds;
        return { providerId: "m1" };
      },
    },
    store: {
      saveStars: async () => {},
      currentStars: async () => [
        { ...seed, starredAt: new Date(daysAgo(400)) },
        ...mine.slice(1),
      ],
      starReminderClaimed: async () => false,
      claimStarReminder: async (_day, stars) => {
        claimed.push(stars.map((star) => star.fullName));
        return true;
      },
      releaseStarReminder: async () => {},
      saveStarReminderMessage: async () => {},
      starInterests: async () => ({ picked: {}, votes: [] }),
      seenStarRepos: async () => new Set(mine.map((s) => s.fullName)),
      saveStarSuggestion: async () => {},
    },
  });
  assert.deepEqual(failures, []);
  assert.equal(searched, false);
  assert.equal(claimed[0]!.at(-1), "x/gem");
  assert.match(
    embeds.at(-1)!.description ?? "",
    /찾은 길.*쓰는 사람 2명이 스타 누름/,
  );
});

test("a thin seed borrows its maker's follows, and kept neighbors are read three pages deep", async () => {
  const requested: string[] = [];
  const fetch = (async (url: string) => {
    const path = url.replace("https://api.github.com/", "");
    requested.push(path);
    if (path.startsWith("users/lone/following"))
      return json([
        { login: "pal", type: "User" },
        { login: "org", type: "Organization" },
      ]);
    if (path.startsWith("users/pal/repos"))
      return json([{ full_name: "pal/tool", description: "a tool" }]);
    if (path.startsWith("users/kept/starred"))
      return json([
        {
          starred_at: daysAgo(1),
          repo: { full_name: `kept/p${/&page=(\d)/.exec(path)![1]}` },
        },
      ]);
    return json([]);
  }) as typeof globalThis.fetch;
  const [trail] = await digTrails(["lone/seed"], "t", { fetch });
  assert.deepEqual(
    trail!.followed?.map((f) => [f.login, f.repos.map((r) => r.fullName)]),
    [["pal", ["pal/tool"]]],
  );
  const kept = await followNeighbors(["kept", "bad name"], "t", { fetch });
  assert.deepEqual(
    kept.map((n) => [n.login, n.starred.map((r) => r.fullName)]),
    [["kept", ["kept/p1", "kept/p2", "kept/p3"]]],
  );
});

test("a day's dig keeps close neighbors, follows kept ones and records its way", async () => {
  const saved: Array<{ name: string; trail?: { kind: string; seed: string } }> =
    [];
  let keptSaved: Array<{ login: string; shared: number }> = [];
  let followedMarked: string[] = [];
  let followAsked: string[] = [];
  const failures = await remindStars({
    now,
    random: () => 0,
    ownerId: "42",
    reads: {},
    readStars: async () => ({ stars: [], complete: false }),
    digTrails: async (seeds) => [
      {
        seed: seeds[0]!,
        neighbors: [
          tasteful("n1", [repo("x/gem")]),
          tasteful("n2", [repo("x/gem")]),
        ],
        maker: [],
        contributors: [],
      },
    ],
    followNeighbors: async (logins) => {
      followAsked = logins;
      return logins.map((login) => ({ login, starred: [] }));
    },
    delivery: { send: async () => ({ providerId: "m1" }) },
    store: {
      saveStars: async () => {},
      currentStars: async () => [
        stored("me/old", { starredAt: daysAgo(400) }),
        ...mine,
      ],
      starReminderClaimed: async () => false,
      claimStarReminder: async () => true,
      releaseStarReminder: async () => {},
      saveStarReminderMessage: async () => {},
      starInterests: async () => ({
        picked: {},
        votes: [
          {
            fullName: "bad/one",
            vote: -1,
            facets: [],
            votedAt: new Date(daysAgo(2)),
          },
        ],
      }),
      seenStarRepos: async () => new Set(mine.map((s) => s.fullName)),
      saveStarSuggestion: async (found, trail) => {
        saved.push({ name: found.fullName, ...(trail && { trail }) });
      },
      starDigHistory: async () => [
        {
          fullName: "rested/thing",
          kind: "people",
          seed: "@gone",
          suggestedAt: new Date(daysAgo(20)),
          vote: -1,
          votedAt: new Date(daysAgo(5)),
        },
      ],
      saveStarNeighbors: async (neighbors) => {
        keptSaved = [...neighbors];
      },
      starNeighbors: async () => [
        { login: "gone", shared: 9 },
        { login: "pal", shared: 7 },
      ],
      markStarNeighborsFollowed: async (logins) => {
        followedMarked = [...logins];
      },
    },
  });
  assert.deepEqual(failures, []);
  // "gone" led to a thumbed-down find lately, so it rests.
  assert.deepEqual(followAsked, ["pal"]);
  assert.deepEqual(followedMarked, ["pal"]);
  assert.deepEqual(
    keptSaved.map((n) => n.login),
    ["n1", "n2"],
  );
  assert.deepEqual(saved, [
    { name: "x/gem", trail: { kind: "people", seed: "me/a" } },
  ]);
});
