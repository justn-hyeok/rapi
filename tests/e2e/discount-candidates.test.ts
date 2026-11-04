import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PostgresStore } from "@rapi/db";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).pathname !== "/rapi_test")
  throw new Error("Discount candidate E2E requires rapi_test");

describe("discount candidates", () => {
  it("keeps the first row when a candidate is seen again", async () => {
    const store = new PostgresStore(databaseUrl);
    try {
      await store.resetForTests();
      const candidate = {
        kind: "discount",
        route: "changelog",
        dedupeKey: "changelog:a",
        domain: "x.test",
        title: "50% off",
        url: "https://x.test/a",
        evidence: "50% off",
        publishedAt: "2026-11-01T00:00:00.000Z",
      } as const;
      assert.equal(await store.saveDiscountCandidate(candidate), true);
      assert.equal(
        await store.saveDiscountCandidate({ ...candidate, title: "Changed" }),
        false,
      );
      const { rows } = await store.pool.query<{
        title: string;
        status: string;
      }>("SELECT title, status FROM discount_candidates");
      assert.deepEqual(rows, [{ title: "50% off", status: "new" }]);
    } finally {
      await store.close();
    }
  });
});
