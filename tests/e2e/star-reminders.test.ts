import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GitHubStar } from "@rapi/core";
import { PostgresStore } from "@rapi/db";

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
    const store = new PostgresStore(databaseUrl);
    try {
      await store.resetForTests();
      await store.saveStars([star("a/one"), star("a/two")], true);
      await store.saveStars([star("a/one", { stars: 9 })], false);
      assert.deepEqual(names(await store.currentStars()), ["a/one", "a/two"]);
      await store.saveStars([star("a/one", { stars: 9 })], true);
      const current = await store.currentStars();
      assert.deepEqual(names(current), ["a/one"]);
      assert.equal(current[0]!.stars, 9);
      assert.ok(current[0]!.starredAt instanceof Date);
      // Starring it again brings the row back.
      await store.saveStars([star("a/one"), star("a/two")], true);
      assert.deepEqual(names(await store.currentStars()), ["a/one", "a/two"]);
    } finally {
      await store.close();
    }
  });

  it("claims a day once, marks the stars, and a release restores them", async () => {
    const store = new PostgresStore(databaseUrl);
    try {
      await store.resetForTests();
      await store.saveStars([star("a/one")], true);
      const stars = await store.currentStars();
      const count = async () =>
        (
          await store.pool.query<{ reminded_count: number }>(
            "SELECT reminded_count FROM github_stars",
          )
        ).rows[0]!.reminded_count;

      assert.equal(await store.starReminderClaimed("2026-11-05"), false);
      assert.equal(await store.claimStarReminder("2026-11-05", stars), true);
      assert.equal(await store.starReminderClaimed("2026-11-05"), true);
      assert.equal(await store.claimStarReminder("2026-11-05", stars), false);
      assert.equal(await count(), 1);
      assert.ok((await store.currentStars())[0]!.lastRemindedAt);

      await store.releaseStarReminder("2026-11-05", stars);
      assert.equal(await store.starReminderClaimed("2026-11-05"), false);
      assert.equal(await count(), 0);
      assert.equal((await store.currentStars())[0]!.lastRemindedAt, null);

      assert.equal(await store.claimStarReminder("2026-11-05", stars), true);
      await store.saveStarReminderMessage("2026-11-05", "m1");
      // Sent is sent: a late release cannot free the day.
      await store.releaseStarReminder("2026-11-05", stars);
      assert.equal(await store.starReminderClaimed("2026-11-05"), true);
      assert.equal(await count(), 1);
    } finally {
      await store.close();
    }
  });
  it("keeps interests, votes and suggestions, and finds a shown repository again", async () => {
    const store = new PostgresStore(databaseUrl);
    try {
      await store.resetForTests();
      await store.saveStars(
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
      const one = (await store.currentStars()).find(
        (row) => row.fullName === "a/one",
      )!;
      assert.deepEqual(one.topics, ["tui", "rust"]);
      assert.equal(one.ownerType, "Organization");
      assert.equal(one.license, "MIT");
      assert.ok(one.pushedAt instanceof Date);
      const two = (await store.currentStars()).find(
        (row) => row.fullName === "a/two",
      )!;
      assert.deepEqual(two.topics, []);

      assert.deepEqual(await store.starInterests("42"), {
        picked: {},
        votes: [],
      });
      await store.saveStarInterests("42", { "언어:Rust": 1 });
      await store.saveStarInterests("42", { "topic:tui": 1, "분야:게임": -1 });
      await store.saveStarVote("42", "a/one", 1, ["topic:tui"]);
      await store.saveStarVote("42", "a/one", -1, ["topic:tui"]);
      assert.deepEqual(await store.starInterests("42"), {
        picked: { "topic:tui": 1, "분야:게임": -1 },
        votes: [{ fullName: "a/one", vote: -1, facets: ["topic:tui"] }],
      });

      await store.saveStarSuggestion(
        star("New/Found", { topics: ["mcp"], license: null }),
      );
      await store.saveStarSuggestion(star("New/Found", { stars: 999 }));
      const found = await store.starRepo("New/Found");
      assert.equal(found?.stars, 5);
      assert.deepEqual(found!.topics, ["mcp"]);
      assert.deepEqual((await store.starRepo("a/one"))?.topics, [
        "tui",
        "rust",
      ]);
      assert.equal(await store.starRepo("no/such"), null);
      assert.deepEqual([...(await store.seenStarRepos())].sort(), [
        "a/one",
        "a/two",
        "new/found",
      ]);
    } finally {
      await store.close();
    }
  });
});
