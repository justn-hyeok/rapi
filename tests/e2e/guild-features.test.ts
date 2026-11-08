import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PostgresDatabase, postgresStores } from "@rapi/adapters";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).pathname !== "/rapi_test")
  throw new Error("Guild feature E2E requires rapi_test");

describe("guild features", () => {
  it("keeps one setting per guild and feature, and the last one wins", async () => {
    const store = new PostgresDatabase(databaseUrl);
    const stores = postgresStores(store);
    try {
      await store.resetForTests();
      assert.deepEqual(await stores.guilds.guildFeatureSettings("g1"), []);
      await stores.guilds.setGuildFeature("g1", "report", true, "owner");
      await stores.guilds.setGuildFeature("g1", "report", false, "owner");
      await stores.guilds.setGuildFeature("g2", "report", true, "owner");
      assert.deepEqual(await stores.guilds.guildFeatureSettings("g1"), [
        { feature: "report", enabled: false },
      ]);
      assert.deepEqual(await stores.guilds.guildFeatureSettings("g2"), [
        { feature: "report", enabled: true },
      ]);
      await assert.rejects(
        stores.guilds.setGuildFeature("g1", "unknown", true, "owner"),
      );
    } finally {
      await store.close();
    }
  });
});
