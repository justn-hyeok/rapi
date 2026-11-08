import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PostgresDatabase,
  postgresStores,
  type PostgresStores,
} from "@rapi/adapters";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).pathname !== "/rapi_test")
  throw new Error("Guild request E2E requires rapi_test");

const request = { guildId: "g1", requesterId: "u1", reason: "r" };
const allowed = async (stores: PostgresStores) =>
  (await stores.guilds.allowedDiscordGuilds()).map((guild) => guild.guildId);

async function withStore(
  work: (store: PostgresDatabase, stores: PostgresStores) => Promise<void>,
) {
  const store = new PostgresDatabase(databaseUrl!);
  const stores = postgresStores(store);
  try {
    await store.resetForTests();
    await work(store, stores);
  } finally {
    await store.close();
  }
}

describe("guild requests", () => {
  it("keeps one open request and decides it only once", () =>
    withStore(async (store, stores) => {
      assert.equal(
        (await stores.guilds.openGuildRequest(request, 7)).status,
        "opened",
      );
      assert.equal(
        (
          await stores.guilds.openGuildRequest(
            { ...request, requesterId: "u2" },
            7,
          )
        ).status,
        "pending",
      );
      assert.deepEqual(await stores.guilds.guildRequestsForCards(5), [
        { guildId: "g1", name: null, requesterId: "u1", reason: "r" },
      ]);
      assert.equal(
        await stores.guilds.decideGuildRequest("g1", "allowed", "o"),
        true,
      );
      assert.equal(
        await stores.guilds.decideGuildRequest("g1", "blocked", "o"),
        false,
      );
      assert.deepEqual(await allowed(stores), ["g1"]);
      assert.equal(
        (await stores.guilds.openGuildRequest(request, 7)).status,
        "allowed",
      );
      assert.deepEqual(await stores.guilds.guildRequestsForCards(5), []);
    }));

  it("claims a card once and counts it toward the channel's hour", () =>
    withStore(async (store, stores) => {
      await stores.guilds.openGuildRequest(request, 7);
      const before = await stores.discounts.cardsInLastHour();
      assert.equal(await stores.guilds.claimGuildCard("g1"), true);
      assert.equal(await stores.guilds.claimGuildCard("g1"), false);
      assert.equal(await stores.discounts.cardsInLastHour(), before + 1);
      await stores.guilds.releaseGuildCard("g1");
      assert.equal(await stores.guilds.claimGuildCard("g1"), true);
      await stores.guilds.saveGuildCardMessage("g1", "m1", "이름");
      await stores.guilds.saveGuildCardMessage("g1", "m1", null);
      await stores.guilds.decideGuildRequest("g1", "blocked", "o");
      assert.equal(await stores.guilds.claimGuildCard("g1"), false);
    }));

  it("refuses a blocked guild, and after lifting makes it wait", () =>
    withStore(async (store, stores) => {
      await stores.guilds.setGuildStatus("g1", "allowed", "o");
      assert.deepEqual(await allowed(stores), ["g1"]);
      await stores.guilds.setGuildStatus("g1", "blocked", "o");
      assert.deepEqual(await allowed(stores), []);
      assert.equal(
        (await stores.guilds.openGuildRequest(request, 7)).status,
        "blocked",
      );
      assert.equal(await stores.guilds.liftGuildBlock("g1", "o"), true);
      assert.equal(await stores.guilds.liftGuildBlock("g1", "o"), false);
      assert.deepEqual(await allowed(stores), []);
      const waiting = await stores.guilds.openGuildRequest(request, 7);
      assert.equal(waiting.status, "waiting");
      assert.ok(waiting.retryAt && waiting.retryAt > new Date());
      assert.equal(
        (await stores.guilds.openGuildRequest(request, 0)).status,
        "opened",
      );
    }));
});
