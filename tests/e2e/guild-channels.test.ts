import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PostgresDatabase, postgresStores } from "@rapi/adapters";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).pathname !== "/rapi_test")
  throw new Error("Guild channel E2E requires rapi_test");

describe("guild channels", () => {
  it("keeps one channel per guild and kind, and the last one wins", async () => {
    const store = new PostgresDatabase(databaseUrl);
    const stores = postgresStores(store);
    try {
      await store.resetForTests();
      assert.deepEqual(await stores.guilds.guildChannels("g1"), []);
      await stores.guilds.setGuildChannel("g1", "discount", "1", "owner");
      await stores.guilds.setGuildChannel("g1", "discount", "2", "owner");
      await stores.guilds.setGuildChannel("g2", "discount", "3", "admin");
      await stores.guilds.setGuildChannel("g2", "new_service", "4", "admin");
      assert.deepEqual(await stores.guilds.guildChannels("g1"), [
        { kind: "discount", channelId: "2" },
      ]);
      assert.deepEqual(await stores.guilds.publicGuildChannels("discount"), [
        { guildId: "g1", channelId: "2" },
        { guildId: "g2", channelId: "3" },
      ]);
      await stores.guilds.clearGuildChannel("g1", "discount");
      assert.deepEqual(await stores.guilds.guildChannels("g1"), []);
      await assert.rejects(
        stores.guilds.setGuildChannel("g1", "unknown", "1", "o"),
      );
      await stores.guilds.setGuildChannel("g1", "rapi_update", "5", "owner");
      assert.equal(await stores.rapiUpdates.rapiUpdateNoticed(), false);
      assert.equal(await stores.rapiUpdates.claimRapiUpdate("v1"), true);
      assert.equal(await stores.rapiUpdates.claimRapiUpdate("v1"), false);
      assert.equal(await stores.rapiUpdates.rapiUpdateNoticed(), true);
    } finally {
      await store.close();
    }
  });
});
