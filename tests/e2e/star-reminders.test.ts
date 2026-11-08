import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GitHubStar } from "@rapi/domain";
import { PostgresDatabase, postgresStores } from "@rapi/adapters";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).pathname !== "/rapi_test")
  throw new Error("Star reminder E2E requires rapi_test");

const star = (fullName: string, fields: Partial<GitHubStar> = {}) => ({
  fullName,
  url: `https://github.com/${fullName}`,
  description: "words",
  language: null,
  stars: 5,
  archived: false,
  starredAt: "2024-01-01T00:00:00.000Z",
  ...fields,
});
const names = (rows: Array<{ fullName: string }>) =>
  rows.map((row) => row.fullName).sort();

describe("star reminders", () => {
  it("keeps stars on a partial list and drops the removed on a whole one", async () => {
    const store = new PostgresDatabase(databaseUrl);
    const stores = postgresStores(store);
    const mine = stores.stars.starsOf("42");
    try {
      await store.resetForTests();
      await mine.saveStars([star("a/one"), star("a/two")], true);
      await mine.saveStars([star("a/one", { stars: 9 })], false);
      assert.deepEqual(names(await mine.currentStars()), ["a/one", "a/two"]);
      await mine.saveStars([star("a/one", { stars: 9 })], true);
      const current = await mine.currentStars();
      assert.deepEqual(names(current), ["a/one"]);
      assert.equal(current[0]!.stars, 9);
      assert.ok(current[0]!.starredAt instanceof Date);
      // Starring it again brings the row back.
      await mine.saveStars([star("a/one"), star("a/two")], true);
      assert.deepEqual(names(await mine.currentStars()), ["a/one", "a/two"]);
    } finally {
      await store.close();
    }
  });

  it("claims a day once, marks the stars, and a release restores them", async () => {
    const store = new PostgresDatabase(databaseUrl);
    const stores = postgresStores(store);
    const mine = stores.stars.starsOf("42");
    try {
      await store.resetForTests();
      await mine.saveStars([star("a/one")], true);
      const stars = await mine.currentStars();
      const count = async () =>
        (
          await store.pool.query<{ reminded_count: number }>(
            "SELECT reminded_count FROM github_stars WHERE user_id = '42'",
          )
        ).rows[0]!.reminded_count;

      assert.equal(await mine.starReminderClaimed("2026-11-05"), false);
      assert.equal(await mine.claimStarReminder("2026-11-05", stars), true);
      assert.equal(await mine.starReminderClaimed("2026-11-05"), true);
      assert.equal(await mine.claimStarReminder("2026-11-05", stars), false);
      assert.equal(await count(), 1);
      assert.ok((await mine.currentStars())[0]!.lastRemindedAt);

      await mine.releaseStarReminder("2026-11-05", stars);
      assert.equal(await mine.starReminderClaimed("2026-11-05"), false);
      assert.equal(await count(), 0);
      assert.equal((await mine.currentStars())[0]!.lastRemindedAt, null);

      assert.equal(await mine.claimStarReminder("2026-11-05", stars), true);
      await mine.saveStarReminderMessage("2026-11-05", "m1");
      // Sent is sent: a late release cannot free the day.
      await mine.releaseStarReminder("2026-11-05", stars);
      assert.equal(await mine.starReminderClaimed("2026-11-05"), true);
      assert.equal(await count(), 1);
    } finally {
      await store.close();
    }
  });
  it("keeps interests, votes and suggestions, and finds a shown repository again", async () => {
    const store = new PostgresDatabase(databaseUrl);
    const stores = postgresStores(store);
    const mine = stores.stars.starsOf("42");
    try {
      await store.resetForTests();
      await mine.saveStars(
        [
          star("a/one", {
            topics: ["tui", "rust"],
            pushedAt: "2026-11-01T00:00:00.000Z",
            createdAt: "2023-01-01T00:00:00.000Z",
            ownerType: "Organization",
            license: "MIT",
          }),
          star("a/two"),
        ],
        true,
      );
      const one = (await mine.currentStars()).find(
        (row) => row.fullName === "a/one",
      )!;
      assert.deepEqual(one.topics, ["tui", "rust"]);
      assert.equal(one.ownerType, "Organization");
      assert.equal(one.license, "MIT");
      assert.ok(one.pushedAt instanceof Date);
      const two = (await mine.currentStars()).find(
        (row) => row.fullName === "a/two",
      )!;
      assert.deepEqual(two.topics, []);

      assert.deepEqual(await mine.starInterests(), {
        picked: {},
        votes: [],
      });
      await mine.saveStarInterests({ "언어:Rust": 1 });
      await mine.saveStarInterests({ "topic:tui": 1, "분야:게임": -1 });
      await mine.saveStarVote("a/one", 1, ["topic:tui"]);
      await mine.saveStarVote("a/one", -1, ["topic:tui"]);
      const saved = await mine.starInterests();
      assert.deepEqual(saved.picked, { "topic:tui": 1, "분야:게임": -1 });
      assert.deepEqual(
        saved.votes.map(({ votedAt, ...vote }) => {
          assert.ok(votedAt instanceof Date);
          return vote;
        }),
        [{ fullName: "a/one", vote: -1, facets: ["topic:tui"] }],
      );

      await mine.saveStarSuggestion(
        star("New/Found", { topics: ["mcp"], license: null }),
      );
      await mine.saveStarSuggestion(star("New/Found", { stars: 999 }));
      const found = await mine.starRepo("New/Found");
      assert.equal(found?.stars, 5);
      assert.deepEqual(found!.topics, ["mcp"]);
      assert.deepEqual((await mine.starRepo("a/one"))?.topics, ["tui", "rust"]);
      assert.equal(await mine.starRepo("no/such"), null);
      assert.deepEqual([...(await mine.seenStarRepos())].sort(), [
        "a/one",
        "a/two",
        "new/found",
      ]);
    } finally {
      await store.close();
    }
  });

  it("remembers how each find came, the thumbs on it, and the neighbors to follow", async () => {
    const store = new PostgresDatabase(databaseUrl);
    const stores = postgresStores(store);
    const mine = stores.stars.starsOf("42");
    try {
      await store.resetForTests();
      await mine.saveStarSuggestion(star("dug/one"), {
        kind: "people",
        seed: "me/seed",
      });
      await mine.saveStarSuggestion(star("searched/two"));
      await mine.saveStarVote("dug/one", -1, []);
      await stores.stars.starsOf("7").saveStarVote("searched/two", 1, []);
      const history = await mine.starDigHistory();
      assert.deepEqual(
        history.map(({ fullName, kind, seed, vote }) => ({
          fullName,
          kind,
          seed,
          vote,
        })),
        [
          { fullName: "dug/one", kind: "people", seed: "me/seed", vote: -1 },
          // Another owner's thumb is not this owner's.
          { fullName: "searched/two", kind: null, seed: null, vote: null },
        ],
      );
      assert.ok(history[0]!.suggestedAt instanceof Date);
      assert.ok(history[0]!.votedAt instanceof Date);

      await mine.saveStarNeighbors([
        { login: "close", shared: 9, from: "me/seed" },
        { login: "near", shared: 4, from: "me/seed" },
        { login: "nearer", shared: 6, from: "me/seed" },
      ]);
      // Seen again with fewer shared stars, it keeps the most it ever shared.
      await mine.saveStarNeighbors([
        { login: "close", shared: 3, from: "x/y" },
      ]);
      assert.deepEqual(await mine.starNeighbors(2), [
        { login: "close", shared: 9 },
        { login: "nearer", shared: 6 },
      ]);
      await mine.markStarNeighborsFollowed(["close", "nearer"]);
      await mine.markStarNeighborsFollowed([]);
      assert.deepEqual(await mine.starNeighbors(3), [
        { login: "near", shared: 4 },
        { login: "close", shared: 9 },
        { login: "nearer", shared: 6 },
      ]);
    } finally {
      await store.close();
    }
  });

  it("keeps each person's stars apart and lets them connect, pause and leave", async () => {
    const store = new PostgresDatabase(databaseUrl);
    const stores = postgresStores(store);
    try {
      await store.resetForTests();
      // Rows from before stars had owners.
      await store.pool.query(
        `INSERT INTO github_stars (full_name, url, starred_at)
         VALUES ('old/star', 'https://github.com/old/star', now())`,
      );
      await store.pool.query(
        "INSERT INTO star_reminder_days (day, repos) VALUES ('2026-11-01', '{}')",
      );
      assert.equal(await stores.stars.adoptOwnerlessStars("1"), 2);
      assert.equal(await stores.stars.adoptOwnerlessStars("1"), 0);
      assert.deepEqual(names(await stores.stars.starsOf("1").currentStars()), [
        "old/star",
      ]);

      const ann = stores.stars.starsOf("2");
      await ann.saveStars([star("a/one"), star("old/star")], true);
      await stores.stars.starsOf("1").saveStars([star("b/two")], false);
      // A whole list for one person leaves the other's stars alone.
      assert.deepEqual(names(await stores.stars.starsOf("1").currentStars()), [
        "b/two",
        "old/star",
      ]);
      assert.deepEqual(names(await ann.currentStars()), ["a/one", "old/star"]);
      assert.equal(await ann.claimStarReminder("2026-11-01", []), true);
      assert.equal(await ann.starReminderClaimed("2026-11-01"), true);
      await ann.saveStarSuggestion(star("x/dug"));
      assert.equal(await stores.stars.starsOf("1").starRepo("x/dug"), null);
      assert.ok((await ann.seenStarRepos()).has("x/dug"));
      assert.ok(
        !(await stores.stars.starsOf("1").seenStarRepos()).has("x/dug"),
      );

      await stores.stars.addStarSubscriber("1", "owner");
      await stores.stars.saveStarSubscriber("2", "ann");
      await stores.stars.saveStarSubscriber("1", "owner-new");
      await stores.stars.addStarSubscriber("1", "owner");
      assert.deepEqual(
        (await stores.stars.starSubscribers()).map((row) => [
          row.userId,
          row.githubLogin,
        ]),
        [
          ["1", "owner-new"],
          ["2", "ann"],
        ],
      );
      // A new login drops the stars read for the old one, not what was shown.
      assert.deepEqual(await stores.stars.starsOf("1").currentStars(), []);
      assert.equal(
        await stores.stars.starsOf("1").starReminderClaimed("2026-11-01"),
        true,
      );

      await stores.stars.pauseStarSubscriber("2", "DM을 받을 수 없음");
      assert.equal(
        (await stores.stars.starSubscriber("2"))?.pausedReason,
        "DM을 받을 수 없음",
      );
      await stores.stars.saveStarSubscriber("2", "ann");
      assert.equal((await stores.stars.starSubscriber("2"))?.pausedAt, null);

      await ann.saveStarInterests({ "언어:Rust": 1 });
      assert.equal(await stores.stars.removeStarSubscriber("2"), true);
      assert.equal(await stores.stars.removeStarSubscriber("2"), false);
      assert.equal(await stores.stars.starSubscriber("2"), null);
      assert.deepEqual(await ann.currentStars(), []);
      assert.deepEqual((await ann.starInterests()).picked, {});
      assert.equal(await ann.starReminderClaimed("2026-11-01"), false);
      assert.deepEqual(
        names(await stores.stars.starsOf("1").currentStars()),
        [],
      );
    } finally {
      await store.close();
    }
  });
  it("keeps one connection per person and service, sealed, apart from the features", async () => {
    const store = new PostgresDatabase(databaseUrl);
    const stores = postgresStores(store);
    const connections = stores.connections;
    try {
      await store.resetForTests();
      const github = {
        userId: "2",
        provider: "github" as const,
        accountId: "583231",
        accountName: "ann",
        sealedToken: "v1.sealed",
        scopes: "",
      };
      await connections.saveConnection(github);
      await connections.saveConnection({
        ...github,
        accountName: "ann-renamed",
        sealedToken: "v1.again",
      });
      assert.deepEqual(
        (await connections.connections("2")).map((row) => [
          row.provider,
          row.accountName,
          row.sealedToken,
        ]),
        [["github", "ann-renamed", "v1.again"]],
      );
      assert.equal(await connections.connection("3", "github"), null);
      // Turning star reminders off leaves the connection; cutting it leaves the reminders.
      await stores.stars.saveStarSubscriber("2", "ann-renamed");
      await stores.stars.removeStarSubscriber("2");
      assert.ok(await connections.connection("2", "github"));
      await stores.stars.saveStarSubscriber("2", "ann-renamed");
      assert.equal(await connections.removeConnection("2", "github"), true);
      assert.equal(await connections.removeConnection("2", "github"), false);
      assert.ok(await stores.stars.starSubscriber("2"));
    } finally {
      await store.close();
    }
  });
});
