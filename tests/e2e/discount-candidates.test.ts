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

  it("records a verification once and never overwrites a red set by hand", async () => {
    const store = new PostgresStore(databaseUrl);
    try {
      await store.resetForTests();
      const candidate = {
        kind: "new_service",
        route: "code_search",
        domain: "relay.io",
        title: "https://relay.io",
        url: "https://github.com/o/r/blob/a/c.ts",
        evidence: "https://github.com/o/r",
        publishedAt: null,
      } as const;
      await store.saveDiscountCandidate({ ...candidate, dedupeKey: "a" });
      await store.saveDiscountCandidate({ ...candidate, dedupeKey: "b" });
      const [first, second] = await store.unverifiedDiscountCandidates(10);
      assert.equal(first!.route, "code_search");

      const verification = {
        band: "yellow",
        tags: ["#재판매"],
        operator: null,
        priceCheck: "unknown",
        termsUrl: null,
        termsNote: "확인 못 함",
      } as const;
      await store.saveCandidateVerification(first!.id, verification);
      await store.pool.query(
        "UPDATE discount_candidates SET band = 'red' WHERE id = $1",
        [second!.id],
      );
      assert.deepEqual(await store.unverifiedDiscountCandidates(10), []);

      await store.saveCandidateVerification(second!.id, verification);
      const { rows } = await store.pool.query<{
        band: string;
        tags: string[];
        terms_note: string | null;
        verified_at: Date | null;
      }>(
        "SELECT band, tags, terms_note, verified_at FROM discount_candidates WHERE id = ANY($1::uuid[]) ORDER BY band DESC",
        [[first!.id, second!.id]],
      );
      assert.equal(rows[0]!.band, "yellow");
      assert.deepEqual(rows[0]!.tags, ["#재판매"]);
      assert.equal(rows[0]!.terms_note, "확인 못 함");
      assert.ok(rows[0]!.verified_at);
      assert.equal(rows[1]!.band, "red");
      assert.equal(rows[1]!.verified_at, null);
    } finally {
      await store.close();
    }
  });

  it("offers a recent checked row once, newest first, and keeps the claim", async () => {
    const store = new PostgresStore(databaseUrl);
    try {
      await store.resetForTests();
      const day = 24 * 60 * 60_000;
      const ago = (days: number) => new Date(Date.now() - days * day);
      const add = async (
        dedupeKey: string,
        band: string | null,
        publishedAt: Date | null,
      ) => {
        await store.saveDiscountCandidate({
          kind: "discount",
          route: "changelog",
          dedupeKey,
          domain: "x.test",
          title: dedupeKey,
          url: `https://x.test/${dedupeKey}`,
          evidence: "50% off",
          publishedAt: publishedAt?.toISOString() ?? null,
        });
        await store.pool.query(
          "UPDATE discount_candidates SET band = $2, price_check = 'below_list' WHERE dedupe_key = $1",
          [dedupeKey, band],
        );
      };
      await add("older", "green", ago(3));
      await add("newer", "yellow", ago(1));
      await add("undated", "green", null);
      await add("old-news", "green", ago(30));
      await add("red", "red", ago(1));
      await add("unchecked", null, ago(1));

      const rows = await store.candidatesForCards(10);
      assert.deepEqual(
        rows.map((row) => row.title),
        ["undated", "newer", "older"],
      );
      assert.equal(rows[1]!.priceCheck, "below_list");
      assert.equal(rows[1]!.termsNote, null);
      const undated = rows[0]!;
      assert.equal(await store.cardsInLastHour(), 0);

      assert.equal(await store.claimCandidateCard(undated.id), true);
      assert.equal(await store.claimCandidateCard(undated.id), false);
      assert.equal(await store.cardsInLastHour(), 1);
      assert.deepEqual(
        (await store.candidatesForCards(10)).map((row) => row.title),
        ["newer", "older"],
      );

      await store.releaseCandidateCard(undated.id);
      assert.equal(await store.cardsInLastHour(), 0);
      assert.equal(await store.claimCandidateCard(undated.id), true);
      await store.saveCandidateCardMessage(undated.id, "123");
      await store.releaseCandidateCard(undated.id);
      assert.equal(await store.cardsInLastHour(), 1);

      const older = rows[2]!;
      await store.pool.query(
        "UPDATE discount_candidates SET band = 'red' WHERE id = $1",
        [older.id],
      );
      assert.equal(await store.claimCandidateCard(older.id), false);
    } finally {
      await store.close();
    }
  });

  describe("the owner's decision", () => {
    const add = async (store: PostgresStore, key: string, band = "green") => {
      await store.saveDiscountCandidate({
        kind: "discount",
        route: "changelog",
        dedupeKey: key,
        domain: "x.test",
        title: key,
        url: `https://x.test/${key}`,
        evidence: "50% off",
        publishedAt: null,
      });
      const { rows } = await store.pool.query<{ id: string }>(
        "UPDATE discount_candidates SET band = $2 WHERE dedupe_key = $1 RETURNING id",
        [key, band],
      );
      return rows[0]!.id;
    };
    const state = async (store: PostgresStore, id: string) =>
      (
        await store.pool.query<{
          status: string;
          decided: boolean;
          public_message_id: string | null;
        }>(
          `SELECT status, decided_at IS NOT NULL AS decided, public_message_id
           FROM discount_candidates WHERE id = $1`,
          [id],
        )
      ).rows[0]!;

    it("publishes a row once, even when two tabs submit together", async () => {
      const store = new PostgresStore(databaseUrl);
      try {
        await store.resetForTests();
        const id = await add(store, "a");
        const claims = await Promise.all([
          store.claimCandidatePublication(id, 5),
          store.claimCandidatePublication(id, 5),
        ]);
        assert.equal(claims.filter((claim) => claim.claimed).length, 1);
        assert.equal(
          (await store.candidateForDecision(id))!.status,
          "published",
        );
        assert.equal(await store.discardCandidate(id), false);

        await store.saveCandidatePublicMessage(id, "123");
        await store.releaseCandidatePublication(id);
        assert.deepEqual(await state(store, id), {
          status: "published",
          decided: true,
          public_message_id: "123",
        });
      } finally {
        await store.close();
      }
    });

    it("gives a refused send back, and a discarded row cannot be published", async () => {
      const store = new PostgresStore(databaseUrl);
      try {
        await store.resetForTests();
        const refused = await add(store, "refused");
        await store.claimCandidatePublication(refused, 5);
        await store.releaseCandidatePublication(refused);
        assert.deepEqual(await state(store, refused), {
          status: "new",
          decided: false,
          public_message_id: null,
        });

        const discarded = await add(store, "discarded");
        assert.equal(await store.discardCandidate(discarded), true);
        assert.equal(await store.discardCandidate(discarded), false);
        assert.equal((await state(store, discarded)).decided, true);
        assert.deepEqual(await store.claimCandidatePublication(discarded, 5), {
          claimed: false,
          retryAt: null,
        });
        // A release must not reopen what the owner threw away.
        await store.releaseCandidatePublication(discarded);
        assert.equal((await state(store, discarded)).status, "discarded");
      } finally {
        await store.close();
      }
    });

    it("never publishes a red row, even one turned red after its card", async () => {
      const store = new PostgresStore(databaseUrl);
      try {
        await store.resetForTests();
        const red = await add(store, "red", "red");
        assert.deepEqual(await store.claimCandidatePublication(red, 5), {
          claimed: false,
          retryAt: null,
        });
        assert.equal((await state(store, red)).status, "new");
        assert.equal((await store.candidateForDecision(red))!.band, "red");
      } finally {
        await store.close();
      }
    });

    it("holds the sixth publication of the hour without changing the row", async () => {
      const store = new PostgresStore(databaseUrl);
      try {
        await store.resetForTests();
        assert.equal(await store.publicationRetryAt(5), null);
        const ids = await Promise.all(
          ["a", "b", "c", "d", "e", "f", "g"].map((key) => add(store, key)),
        );
        // Two more than the limit at once still only fills the limit.
        const claims = await Promise.all(
          ids.map((id) => store.claimCandidatePublication(id, 5)),
        );
        assert.equal(claims.filter((claim) => claim.claimed).length, 5);
        const held = claims.find((claim) => !claim.claimed)!;
        assert.ok(held.retryAt! > new Date());
        assert.ok((await store.publicationRetryAt(5))! > new Date());

        // Discarding is not limited and does not count.
        const unclaimed = ids[claims.findIndex((claim) => !claim.claimed)]!;
        assert.equal((await state(store, unclaimed)).status, "new");
        assert.equal(await store.discardCandidate(unclaimed), true);

        // An hour later the place is free again.
        await store.pool.query(
          `UPDATE discount_candidates SET decided_at = now() - interval '61 minutes'
           WHERE status = 'published'`,
        );
        assert.equal(await store.publicationRetryAt(5), null);
      } finally {
        await store.close();
      }
    });
  });
});
