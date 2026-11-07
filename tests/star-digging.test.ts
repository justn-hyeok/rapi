import assert from "node:assert/strict";
import { test } from "node:test";
import { digTrails } from "@rapi/adapters";
import { remindStars } from "@rapi/agent";
import {
  digSeeds,
  notability,
  pickDug,
  rankDug,
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
        neighbors: [{ login: "n1", starred: [repo("carol/lib")] }],
      },
    ],
    ownStars: [],
    seen: new Set(),
    interests: {},
    now,
  });
  assert.deepEqual(
    vouched.map((dug) => [dug.repo.fullName, dug.trail]),
    [["carol/lib", "a 쓰는 사람 1명이 스타 누름 · a 기여자 carol의 저장소"]],
  );
  assert.equal(
    pickDug([], () => 0),
    null,
  );
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
