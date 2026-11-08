import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PostgresDatabase, postgresStores } from "@rapi/adapters";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).pathname !== "/rapi_test")
  throw new Error("Community E2E requires rapi_test");

describe("community persistence", () => {
  it("stores one-use Discord layout plans and stable resource keys", async () => {
    const store = new PostgresDatabase(databaseUrl);
    const stores = postgresStores(store);
    try {
      await store.resetForTests();
      await stores.discordLayout.upsertManagedDiscordResource({
        guildId: "guild",
        resourceType: "channel",
        key: "operations_alerts",
        discordId: "123",
        layoutDigest: "layout",
      });
      assert.equal(
        await stores.discordLayout.managedDiscordResourceId(
          "guild",
          "channel",
          "operations_alerts",
        ),
        "123",
      );
      const planId = await stores.discordLayout.createDiscordLayoutPlan({
        guildId: "guild",
        createdBy: "owner",
        layoutDigest: "layout",
        snapshotDigest: "snapshot",
        payload: { actions: [], adopted: [] },
        expiresAt: new Date(Date.now() + 600_000),
      });
      assert.equal(
        (await stores.discordLayout.discordLayoutPlan("guild", planId))
          ?.createdBy,
        "owner",
      );
      assert.equal(
        await stores.discordLayout.markDiscordLayoutPlanApplied(
          "guild",
          planId,
        ),
        true,
      );
      assert.equal(
        await stores.discordLayout.markDiscordLayoutPlanApplied(
          "guild",
          planId,
        ),
        false,
      );
    } finally {
      await store.close();
    }
  });
});
