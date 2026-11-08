import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sourceParsers } from "@rapi/adapters";
import { RapiAgent } from "@rapi/application";
import { PostgresStore } from "@rapi/adapters";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).pathname !== "/rapi_test")
  throw new Error("MVP E2E requires rapi_test");

describe("rapi MVP", () => {
  it("retains original malformed source payloads before normalization fails", async () => {
    const store = new PostgresStore(databaseUrl);
    const agent = new RapiAgent(store, sourceParsers);
    try {
      await store.resetForTests();
      const source = await agent.createSource(
        "rss",
        "https://example.invalid/feed",
        "private",
      );
      await assert.rejects(
        agent.ingestFeed(source, "not a feed"),
        /Unsupported/,
      );
      const raw = await store.pool.query<{ body: string }>(
        "SELECT payload->>'body' AS body FROM raw_events WHERE source_id=$1",
        [source],
      );
      assert.equal(raw.rows[0]?.body, "not a feed");
      const items = await store.pool.query<{ count: string }>(
        "SELECT count(*) FROM source_items",
      );
      assert.equal(items.rows[0]?.count, "0");
    } finally {
      await store.close();
    }
  });
});
