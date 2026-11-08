import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PostgresStore } from "@rapi/adapters";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).pathname !== "/rapi_test")
  throw new Error("Guild request E2E requires rapi_test");

const request = { guildId: "g1", requesterId: "u1", reason: "r" };
const allowed = async (store: PostgresStore) =>
  (await store.allowedDiscordGuilds()).map((guild) => guild.guildId);

async function withStore(work: (store: PostgresStore) => Promise<void>) {
  const store = new PostgresStore(databaseUrl!);
  try {
    await store.resetForTests();
    await work(store);
  } finally {
    await store.close();
  }
}

describe("guild requests", () => {
  it("keeps one open request and decides it only once", () =>
    withStore(async (store) => {
      assert.equal((await store.openGuildRequest(request, 7)).status, "opened");
      assert.equal(
        (await store.openGuildRequest({ ...request, requesterId: "u2" }, 7))
          .status,
        "pending",
      );
      assert.deepEqual(await store.guildRequestsForCards(5), [
        { guildId: "g1", name: null, requesterId: "u1", reason: "r" },
      ]);
      assert.equal(await store.decideGuildRequest("g1", "allowed", "o"), true);
      assert.equal(await store.decideGuildRequest("g1", "blocked", "o"), false);
      assert.deepEqual(await allowed(store), ["g1"]);
      assert.equal(
        (await store.openGuildRequest(request, 7)).status,
        "allowed",
      );
      assert.deepEqual(await store.guildRequestsForCards(5), []);
    }));

  it("claims a card once and counts it toward the channel's hour", () =>
    withStore(async (store) => {
      await store.openGuildRequest(request, 7);
      const before = await store.cardsInLastHour();
      assert.equal(await store.claimGuildCard("g1"), true);
      assert.equal(await store.claimGuildCard("g1"), false);
      assert.equal(await store.cardsInLastHour(), before + 1);
      await store.releaseGuildCard("g1");
      assert.equal(await store.claimGuildCard("g1"), true);
      await store.saveGuildCardMessage("g1", "m1", "이름");
      await store.saveGuildCardMessage("g1", "m1", null);
      await store.decideGuildRequest("g1", "blocked", "o");
      assert.equal(await store.claimGuildCard("g1"), false);
    }));

  it("refuses a blocked guild, and after lifting makes it wait", () =>
    withStore(async (store) => {
      await store.setGuildStatus("g1", "allowed", "o");
      assert.deepEqual(await allowed(store), ["g1"]);
      await store.setGuildStatus("g1", "blocked", "o");
      assert.deepEqual(await allowed(store), []);
      assert.equal(
        (await store.openGuildRequest(request, 7)).status,
        "blocked",
      );
      assert.equal(await store.liftGuildBlock("g1", "o"), true);
      assert.equal(await store.liftGuildBlock("g1", "o"), false);
      assert.deepEqual(await allowed(store), []);
      const waiting = await store.openGuildRequest(request, 7);
      assert.equal(waiting.status, "waiting");
      assert.ok(waiting.retryAt && waiting.retryAt > new Date());
      assert.equal((await store.openGuildRequest(request, 0)).status, "opened");
    }));
});
