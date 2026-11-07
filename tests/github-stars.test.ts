import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GitHubStarRecommender,
  rankStarRecommendations,
  readOwnStars,
  type StarredRepository,
} from "@rapi/adapters";

const now = new Date("2026-10-07T00:00:00Z");
const recent = "2026-10-05T00:00:00Z";
const repo = (
  fullName: string,
  extra: Partial<StarredRepository> = {},
): StarredRepository => ({
  fullName,
  owner: fullName.split("/")[0]!,
  description: "",
  stars: 100,
  topics: [],
  starredAt: recent,
  fork: false,
  archived: false,
  ...extra,
});

test("ranks repositories that several taste neighbors recently starred", () => {
  const items = rankStarRecommendations({
    user: "me",
    mine: [repo("a/one", { topics: ["mcp", "codex"] })],
    neighbors: [
      { login: "n1", starred: [repo("x/shared"), repo("y/single")] },
      { login: "n2", starred: [repo("x/shared")] },
    ],
    topicCandidates: [],
    exclude: new Set(),
    now,
    limit: 5,
  });
  assert.deepEqual(
    items.map((item) => item.externalId),
    ["x/shared"],
  );
  assert.match(items[0]!.body, /최근 star: n1, n2/);
  assert.equal(items[0]!.url, "https://github.com/x/shared");
});

test("excludes starred, own, shown, stale, huge, fork and self-owned repos", () => {
  const both = (r: StarredRepository) => [
    { login: "n1", starred: [r] },
    { login: "n2", starred: [r] },
  ];
  const cases = [
    repo("a/one"),
    repo("me/mine"),
    repo("x/shown"),
    repo("x/stale", { starredAt: "2026-09-01T00:00:00Z" }),
    repo("x/huge", { stars: 300_000 }),
    repo("x/fork", { fork: true }),
  ];
  for (const candidate of cases)
    assert.deepEqual(
      rankStarRecommendations({
        user: "me",
        mine: [repo("a/one")],
        neighbors: both(candidate),
        topicCandidates: [],
        exclude: new Set(["x/shown"]),
        now,
        limit: 5,
      }),
      [],
      candidate.fullName,
    );
  assert.deepEqual(
    rankStarRecommendations({
      user: "me",
      mine: [],
      neighbors: [
        { login: "x", starred: [repo("x/own")] },
        { login: "n2", starred: [repo("x/own")] },
      ],
      topicCandidates: [],
      exclude: new Set(),
      now,
      limit: 5,
    }).map((item) => item.metadata.neighbors),
    [],
  );
});

test("topic candidates need two interest topics", () => {
  const items = rankStarRecommendations({
    user: "me",
    mine: [repo("a/one", { topics: ["mcp", "codex", "cli"] })],
    neighbors: [],
    topicCandidates: [
      repo("t/strong", { topics: ["mcp", "codex"] }),
      repo("t/weak", { topics: ["mcp"] }),
    ],
    exclude: new Set(),
    now,
    limit: 5,
  });
  assert.deepEqual(
    items.map((item) => item.externalId),
    ["t/strong"],
  );
  assert.match(items[0]!.body, /관심 topic: mcp, codex/);
});

test("recommender tolerates neighbor and search failures", async () => {
  const recommender = new GitHubStarRecommender(undefined, {}, async (path) => {
    if (path.startsWith("users/me/starred"))
      return [
        {
          starred_at: recent,
          repo: {
            full_name: "n1/a",
            owner: { login: "n1" },
            stargazers_count: 5,
            topics: [],
          },
        },
        {
          starred_at: recent,
          repo: {
            full_name: "n2/b",
            owner: { login: "n2" },
            stargazers_count: 5,
            topics: [],
          },
        },
        {
          starred_at: recent,
          repo: {
            full_name: "n3/c",
            owner: { login: "n3" },
            stargazers_count: 5,
            topics: [],
          },
        },
      ];
    if (path.startsWith("users/n3/")) throw new Error("private stars");
    if (path.startsWith("users/n"))
      return [
        {
          starred_at: recent,
          repo: {
            full_name: "z/hit",
            owner: { login: "z" },
            stargazers_count: 50,
            topics: [],
          },
        },
      ];
    throw new Error(`unexpected ${path}`);
  });
  const items = await recommender.recommend("me", new Set(), 5, now);
  assert.deepEqual(
    items.map((item) => item.externalId),
    ["z/hit"],
  );
});

const ownStar = (name: string, fields: Record<string, unknown> = {}) => ({
  starred_at: recent,
  repo: {
    full_name: name,
    description: "",
    language: "TypeScript",
    stargazers_count: 5,
    ...fields,
  },
});
const answered = (body: unknown, next = false, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: next
      ? { link: '<https://api.github.com/x?page=2>; rel="next"' }
      : {},
  });

test("reads own stars with the date header and stops at the last page", async () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const { stars, complete } = await readOwnStars("me", undefined, {
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers as Record<string, string> });
      return calls.length === 1
        ? answered([ownStar("a/one")], true)
        : answered([ownStar("b/two", { archived: true })]);
    }) as typeof fetch,
  });
  assert.equal(calls.length, 2);
  assert.match(calls[0]!.url, /users\/me\/starred\?direction=asc/);
  assert.match(calls[1]!.url, /page=2$/);
  assert.equal(calls[0]!.headers.Accept, "application/vnd.github.star+json");
  assert.equal(calls[0]!.headers.Authorization, undefined);
  assert.equal(complete, true);
  assert.deepEqual(stars[0], {
    fullName: "a/one",
    url: "https://github.com/a/one",
    description: "",
    language: "TypeScript",
    stars: 5,
    archived: false,
    starredAt: recent,
    topics: [],
    pushedAt: null,
    createdAt: null,
    ownerType: null,
    license: null,
  });
  assert.equal(stars[1]!.archived, true);
});

test("uses the token only when there is one", async () => {
  let header: string | undefined;
  await readOwnStars("me", "secret", {
    fetch: (async (_url: string, init: RequestInit) => {
      header = (init.headers as Record<string, string>).Authorization;
      return answered([ownStar("a/one")]);
    }) as typeof fetch,
  });
  assert.equal(header, "Bearer secret");
});

test("stops at the page bound and says the list is not complete", async () => {
  let calls = 0;
  const { stars, complete } = await readOwnStars("me", undefined, {
    fetch: (async () => {
      calls += 1;
      return answered([ownStar(`a/${calls}`)], true);
    }) as typeof fetch,
  });
  assert.equal(calls, 10);
  assert.equal(stars.length, 10);
  assert.equal(complete, false);
});

test("a repository seen on two pages counts once", async () => {
  let calls = 0;
  const { stars } = await readOwnStars("me", undefined, {
    fetch: (async () => {
      calls += 1;
      return answered([ownStar("a/one")], calls === 1);
    }) as typeof fetch,
  });
  assert.equal(stars.length, 1);
});

test("clips a description and strips what it cannot store", async () => {
  const { stars } = await readOwnStars("me", undefined, {
    fetch: (async () =>
      answered([
        ownStar("a/one", { description: `\u0000${"x".repeat(400)}` }),
      ])) as typeof fetch,
  });
  assert.equal(stars[0]!.description.length, 300);
  assert.ok(stars[0]!.description.startsWith("x"));
});

test("a failed page, an empty list or an odd answer is an error, not no stars", async () => {
  const read = (fetcher: () => Response) =>
    readOwnStars("me", undefined, {
      fetch: (async () => fetcher()) as typeof fetch,
    });
  await assert.rejects(read(() => answered({}, false, 403)));
  await assert.rejects(
    read(() => answered([])),
    /no stars/,
  );
  await assert.rejects(
    read(() => answered({ message: "x" })),
    /not a list/,
  );
  await assert.rejects(
    read(() => answered([{ repo: { full_name: "a/one" } }])),
    /starred_at/,
  );
  let calls = 0;
  await assert.rejects(
    read(() => {
      calls += 1;
      return calls === 1
        ? answered([ownStar("a/one")], true)
        : answered({}, false, 500);
    }),
  );
});
