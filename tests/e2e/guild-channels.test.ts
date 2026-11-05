import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PostgresStore } from "@rapi/db";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).pathname !== "/rapi_test")
  throw new Error("Guild channel E2E requires rapi_test");

describe("guild channels", () => {
  it("keeps one channel per guild and kind, and the last one wins", async () => {
    const store = new PostgresStore(databaseUrl);
    try {
      await store.resetForTests();
      assert.deepEqual(await store.guildChannels("g1"), []);
      await store.setGuildChannel("g1", "discount", "1", "owner");
      await store.setGuildChannel("g1", "discount", "2", "owner");
      await store.setGuildChannel("g2", "discount", "3", "admin");
      await store.setGuildChannel("g2", "new_service", "4", "admin");
      assert.deepEqual(await store.guildChannels("g1"), [
        { kind: "discount", channelId: "2" },
      ]);
      assert.deepEqual(await store.publicGuildChannels("discount"), [
        { guildId: "g1", channelId: "2" },
        { guildId: "g2", channelId: "3" },
      ]);
      await store.clearGuildChannel("g1", "discount");
      assert.deepEqual(await store.guildChannels("g1"), []);
      await assert.rejects(store.setGuildChannel("g1", "unknown", "1", "o"));
    } finally {
      await store.close();
    }
  });
});
