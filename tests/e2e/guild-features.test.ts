import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PostgresStore } from "@rapi/db";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).pathname !== "/rapi_test")
  throw new Error("Guild feature E2E requires rapi_test");

describe("guild features", () => {
  it("keeps one setting per guild and feature, and the last one wins", async () => {
    const store = new PostgresStore(databaseUrl);
    try {
      await store.resetForTests();
      assert.deepEqual(await store.guildFeatureSettings("g1"), []);
      await store.setGuildFeature("g1", "report", true, "owner");
      await store.setGuildFeature("g1", "report", false, "owner");
      await store.setGuildFeature("g2", "report", true, "owner");
      assert.deepEqual(await store.guildFeatureSettings("g1"), [
        { feature: "report", enabled: false },
      ]);
      assert.deepEqual(await store.guildFeatureSettings("g2"), [
        { feature: "report", enabled: true },
      ]);
      await assert.rejects(
        store.setGuildFeature("g1", "unknown", true, "owner"),
      );
    } finally {
      await store.close();
    }
  });
});
