import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NewReport } from "@rapi/domain";
import { PostgresDatabase, postgresStores } from "@rapi/adapters";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).pathname !== "/rapi_test")
  throw new Error("Discount candidate E2E requires rapi_test");

describe("discount candidates", () => {
  it("keeps the first row when a candidate is seen again", async () => {
    const store = new PostgresDatabase(databaseUrl);
    const stores = postgresStores(store);
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
      assert.equal(
        await stores.discounts.saveDiscountCandidate(candidate),
        true,
      );
      assert.deepEqual(
        [
          ...(await stores.discounts.knownCandidateKeys([
            "changelog:a",
            "changelog:b",
          ])),
        ],
        ["changelog:a"],
      );
      assert.equal(
        await stores.discounts.saveDiscountCandidate({
          ...candidate,
          title: "Changed",
        }),
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

  it("counts board posts and list entries together toward their daily limit", async () => {
    const store = new PostgresDatabase(databaseUrl);
    const stores = postgresStores(store);
    try {
      await store.resetForTests();
      const row = (route: "community" | "relay_list" | "changelog") =>
        ({
          kind: "discount",
          route,
          dedupeKey: `${route}:a`,
          domain: null,
          title: "送 $5",
          url: "https://x.test/a",
          evidence: "",
          publishedAt: null,
        }) as const;
      for (const route of ["community", "relay_list", "changelog"] as const)
        await stores.discounts.saveDiscountCandidate(row(route));
      await store.pool.query(
        "UPDATE discount_candidates SET carded_at = now(), card_message_id = '1'",
      );
      assert.equal(await stores.discounts.unvettedCardsInLastDay(), 2);
    } finally {
      await store.close();
    }
  });

  it("tells a reported deal a route found first from one it missed", async () => {
    const store = new PostgresDatabase(databaseUrl);
    const stores = postgresStores(store);
    try {
      await store.resetForTests();
      const row = (
        route: "changelog" | "report",
        domain: string,
        key: string,
      ) =>
        ({
          kind: "discount",
          route,
          dedupeKey: key,
          domain,
          title: domain,
          url: `https://${domain}/deal`,
          evidence: "",
          publishedAt: null,
        }) as const;
      await stores.discounts.saveDiscountCandidate(
        row("changelog", "found.io", "c"),
      );
      await store.pool.query(
        "UPDATE discount_candidates SET first_seen_at = now() - interval '1 day'",
      );
      await stores.discounts.saveDiscountCandidate(
        row("report", "found.io", "r1"),
      );
      await stores.discounts.saveDiscountCandidate(
        row("report", "missed.io", "r2"),
      );
      const reports = await stores.discounts.reportedDeals(
        new Date(Date.now() - 3_600_000),
      );
      assert.deepEqual(
        reports.map((r) => [r.domain, r.foundBy]),
        [
          ["found.io", "changelog"],
          ["missed.io", null],
        ],
      );
    } finally {
      await store.close();
    }
  });

  it("records a verification once and never overwrites a red set by hand", async () => {
    const store = new PostgresDatabase(databaseUrl);
    const stores = postgresStores(store);
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
      await stores.discounts.saveDiscountCandidate({
        ...candidate,
        dedupeKey: "a",
      });
      await stores.discounts.saveDiscountCandidate({
        ...candidate,
        dedupeKey: "b",
      });
      const [first, second] =
        await stores.discounts.unverifiedDiscountCandidates(10);
      assert.equal(first!.route, "code_search");

      const verification = {
        band: "yellow",
        tags: ["#재판매"],
        operator: null,
        priceCheck: "unknown",
        termsUrl: null,
        termsNote: "확인 못 함",
      } as const;
      await stores.discounts.saveCandidateVerification(first!.id, verification);
      await store.pool.query(
        "UPDATE discount_candidates SET band = 'red' WHERE id = $1",
        [second!.id],
      );
      assert.deepEqual(
        await stores.discounts.unverifiedDiscountCandidates(10),
        [],
      );

      await stores.discounts.saveCandidateVerification(
        second!.id,
        verification,
      );
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
    const store = new PostgresDatabase(databaseUrl);
    const stores = postgresStores(store);
    try {
      await store.resetForTests();
      const day = 24 * 60 * 60_000;
      const ago = (days: number) => new Date(Date.now() - days * day);
      const add = async (
        dedupeKey: string,
        band: string | null,
        publishedAt: Date | null,
      ) => {
        await stores.discounts.saveDiscountCandidate({
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

      const rows = await stores.discounts.candidatesForCards(10);
      assert.deepEqual(
        rows.map((row) => row.title),
        ["undated", "newer", "older"],
      );
      assert.equal(rows[1]!.priceCheck, "below_list");
      assert.equal(rows[1]!.termsNote, null);
      const undated = rows[0]!;
      assert.equal(await stores.discounts.cardsInLastHour(), 0);

      assert.equal(await stores.discounts.claimCandidateCard(undated.id), true);
      assert.equal(
        await stores.discounts.claimCandidateCard(undated.id),
        false,
      );
      assert.equal(await stores.discounts.cardsInLastHour(), 1);
      assert.deepEqual(
        (await stores.discounts.candidatesForCards(10)).map((row) => row.title),
        ["newer", "older"],
      );

      await stores.discounts.releaseCandidateCard(undated.id);
      assert.equal(await stores.discounts.cardsInLastHour(), 0);
      assert.equal(await stores.discounts.claimCandidateCard(undated.id), true);
      await stores.discounts.saveCandidateCardMessage(undated.id, "123");
      await stores.discounts.releaseCandidateCard(undated.id);
      assert.equal(await stores.discounts.cardsInLastHour(), 1);

      const older = rows[2]!;
      await store.pool.query(
        "UPDATE discount_candidates SET band = 'red' WHERE id = $1",
        [older.id],
      );
      assert.equal(await stores.discounts.claimCandidateCard(older.id), false);
    } finally {
      await store.close();
    }
  });

  describe("the owner's decision", () => {
    const add = async (
      store: PostgresDatabase,
      key: string,
      band = "green",
    ) => {
      await postgresStores(store).discounts.saveDiscountCandidate({
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
    const state = async (store: PostgresDatabase, id: string) =>
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
      const store = new PostgresDatabase(databaseUrl);
      const stores = postgresStores(store);
      try {
        await store.resetForTests();
        const id = await add(store, "a");
        const claims = await Promise.all([
          stores.discounts.claimCandidatePublication(id, 5),
          stores.discounts.claimCandidatePublication(id, 5),
        ]);
        assert.equal(claims.filter((claim) => claim.claimed).length, 1);
        assert.equal(
          (await stores.discounts.candidateForDecision(id))!.status,
          "published",
        );
        assert.equal(await stores.discounts.discardCandidate(id), false);

        await stores.discounts.saveCandidatePublicMessage(id, "123");
        await stores.discounts.releaseCandidatePublication(id);
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
      const store = new PostgresDatabase(databaseUrl);
      const stores = postgresStores(store);
      try {
        await store.resetForTests();
        const refused = await add(store, "refused");
        await stores.discounts.claimCandidatePublication(refused, 5);
        await stores.discounts.releaseCandidatePublication(refused);
        assert.deepEqual(await state(store, refused), {
          status: "new",
          decided: false,
          public_message_id: null,
        });

        const discarded = await add(store, "discarded");
        assert.equal(await stores.discounts.discardCandidate(discarded), true);
        assert.equal(await stores.discounts.discardCandidate(discarded), false);
        assert.equal((await state(store, discarded)).decided, true);
        assert.deepEqual(
          await stores.discounts.claimCandidatePublication(discarded, 5),
          {
            claimed: false,
            retryAt: null,
          },
        );
        // A release must not reopen what the owner threw away.
        await stores.discounts.releaseCandidatePublication(discarded);
        assert.equal((await state(store, discarded)).status, "discarded");
      } finally {
        await store.close();
      }
    });

    it("never publishes a red row, even one turned red after its card", async () => {
      const store = new PostgresDatabase(databaseUrl);
      const stores = postgresStores(store);
      try {
        await store.resetForTests();
        const red = await add(store, "red", "red");
        assert.deepEqual(
          await stores.discounts.claimCandidatePublication(red, 5),
          {
            claimed: false,
            retryAt: null,
          },
        );
        assert.equal((await state(store, red)).status, "new");
        assert.equal(
          (await stores.discounts.candidateForDecision(red))!.band,
          "red",
        );
      } finally {
        await store.close();
      }
    });

    it("holds the sixth publication of the hour without changing the row", async () => {
      const store = new PostgresDatabase(databaseUrl);
      const stores = postgresStores(store);
      try {
        await store.resetForTests();
        assert.equal(await stores.discounts.publicationRetryAt(5), null);
        const ids = await Promise.all(
          ["a", "b", "c", "d", "e", "f", "g"].map((key) => add(store, key)),
        );
        // Two more than the limit at once still only fills the limit.
        const claims = await Promise.all(
          ids.map((id) => stores.discounts.claimCandidatePublication(id, 5)),
        );
        assert.equal(claims.filter((claim) => claim.claimed).length, 5);
        const held = claims.find((claim) => !claim.claimed)!;
        assert.ok(held.retryAt! > new Date());
        assert.ok((await stores.discounts.publicationRetryAt(5))! > new Date());

        // Discarding is not limited and does not count.
        const unclaimed = ids[claims.findIndex((claim) => !claim.claimed)]!;
        assert.equal((await state(store, unclaimed)).status, "new");
        assert.equal(await stores.discounts.discardCandidate(unclaimed), true);

        // An hour later the place is free again.
        await store.pool.query(
          `UPDATE discount_candidates SET decided_at = now() - interval '61 minutes'
           WHERE status = 'published'`,
        );
        assert.equal(await stores.discounts.publicationRetryAt(5), null);
      } finally {
        await store.close();
      }
    });
  });

  describe("reports", () => {
    const report = (
      url: string,
      fields: Partial<NewReport> = {},
    ): NewReport => ({
      kind: "discount",
      url,
      domain: new URL(url).hostname,
      reporterId: "7",
      memo: null,
      ...fields,
    });

    it("saves one candidate per link, verified and carded like any other", async () => {
      const store = new PostgresDatabase(databaseUrl);
      const stores = postgresStores(store);
      try {
        await store.resetForTests();
        const link = "https://new.ai/deal";
        assert.equal(
          await stores.reports.saveReport(report(link, { memo: "싸요" }), 5),
          "saved",
        );
        assert.equal(
          await stores.reports.saveReport(report(link, { reporterId: "8" }), 5),
          "duplicate",
        );
        const [unverified] =
          await stores.discounts.unverifiedDiscountCandidates(10, "report");
        assert.equal(unverified!.route, "report");
        assert.equal(unverified!.evidence, "");
        assert.deepEqual(
          await stores.discounts.unverifiedDiscountCandidates(10, "changelog"),
          [],
        );
        await stores.discounts.saveCandidateVerification(unverified!.id, {
          band: "yellow",
          tags: [],
          operator: null,
          priceCheck: "unknown",
          termsUrl: null,
          termsNote: "확인 못 함",
        });
        const [row] = await stores.discounts.candidatesForCards(10);
        assert.equal(row!.memo, "싸요");
        assert.equal(row!.url, link);
      } finally {
        await store.close();
      }
    });

    it("limits a reporter across both kinds, even when sent all at once", async () => {
      const store = new PostgresDatabase(databaseUrl);
      const stores = postgresStores(store);
      try {
        await store.resetForTests();
        const outcomes = await Promise.all(
          ["a", "b", "c", "d", "e", "f"].map((path, index) =>
            stores.reports.saveReport(
              report(`https://new.ai/${path}`, {
                kind: index % 2 ? "problem" : "new_service",
              }),
              5,
            ),
          ),
        );
        assert.equal(outcomes.filter((one) => one === "saved").length, 5);
        assert.equal(outcomes.filter((one) => one === "limited").length, 1);
        // Someone else is not held back, and an hour later neither is this reporter.
        assert.equal(
          await stores.reports.saveReport(
            report("https://new.ai/g", { reporterId: "8" }),
            5,
          ),
          "saved",
        );
        await store.pool.query(
          "UPDATE discount_candidates SET first_seen_at = now() - interval '61 minutes'",
        );
        await store.pool.query(
          "UPDATE problem_reports SET reported_at = now() - interval '61 minutes'",
        );
        assert.equal(
          await stores.reports.saveReport(report("https://new.ai/h"), 5),
          "saved",
        );
      } finally {
        await store.close();
      }
    });

    it("keeps a problem report off the candidates until the owner decides", async () => {
      const store = new PostgresDatabase(databaseUrl);
      const stores = postgresStores(store);
      try {
        await store.resetForTests();
        const link = "https://bad.ai/x";
        const problem = report(link, { kind: "problem", memo: "먹튀" });
        assert.equal(await stores.reports.saveReport(problem, 5), "saved");
        assert.equal(await stores.reports.saveReport(problem, 5), "duplicate");
        assert.deepEqual(
          await stores.discounts.unverifiedDiscountCandidates(10),
          [],
        );

        const [card] = await stores.discounts.problemReportsForCards(10);
        assert.deepEqual(
          { ...card!, id: "" },
          {
            id: "",
            url: link,
            domain: "bad.ai",
            reporterId: "7",
            memo: "먹튀",
          },
        );
        assert.equal(await stores.discounts.claimProblemCard(card!.id), true);
        assert.equal(await stores.discounts.claimProblemCard(card!.id), false);
        assert.equal(await stores.discounts.cardsInLastHour(), 1);
        assert.deepEqual(await stores.discounts.problemReportsForCards(10), []);

        assert.deepEqual(
          await stores.reports.decideProblemReport(card!.id, "no_problem", "1"),
          { url: link, domain: "bad.ai", turnedRed: 0, alreadyPublished: 0 },
        );
        assert.equal(
          await stores.reports.decideProblemReport(card!.id, "red", "1"),
          null,
        );
        // The question is closed, so the same link can be raised again.
        assert.equal(await stores.reports.saveReport(problem, 5), "saved");
      } finally {
        await store.close();
      }
    });

    it("turns the whole domain red, now and for rows found later", async () => {
      const store = new PostgresDatabase(databaseUrl);
      const stores = postgresStores(store);
      try {
        await store.resetForTests();
        const verification = {
          band: "yellow",
          tags: [],
          operator: null,
          priceCheck: "unknown",
          termsUrl: null,
          termsNote: null,
        } as const;
        for (const url of ["https://bad.ai/a", "https://bad.ai/b"])
          await stores.reports.saveReport(report(url), 5);
        await stores.reports.saveReport(report("https://fine.ai/a"), 5);
        const rows = await stores.discounts.unverifiedDiscountCandidates(10);
        const [published] = rows;
        await stores.discounts.saveCandidateVerification(
          published!.id,
          verification,
        );
        await stores.discounts.claimCandidatePublication(published!.id, 5);

        await stores.reports.saveReport(
          report("https://bad.ai/c", { kind: "problem", reporterId: "8" }),
          5,
        );
        const [card] = await stores.discounts.problemReportsForCards(10);
        assert.deepEqual(
          await stores.reports.decideProblemReport(card!.id, "red", "1"),
          {
            url: "https://bad.ai/c",
            domain: "bad.ai",
            turnedRed: 2,
            alreadyPublished: 1,
          },
        );
        const { rows: decided } = await store.pool.query(
          "SELECT decision, decided_by, reporter_id FROM problem_reports",
        );
        assert.deepEqual(decided, [
          { decision: "red", decided_by: "1", reporter_id: "8" },
        ]);
        assert.deepEqual(
          (await stores.discounts.candidatesForCards(10)).map(
            (row) => row.domain,
          ),
          [],
        );

        await stores.reports.saveReport(
          report("https://bad.ai/d", { reporterId: "9" }),
          5,
        );
        const found = (
          await stores.discounts.unverifiedDiscountCandidates(10)
        ).find((row) => row.domain === "bad.ai");
        await stores.discounts.saveCandidateVerification(
          found!.id,
          verification,
        );
        assert.equal(
          (await stores.discounts.candidateForDecision(found!.id))!.band,
          "red",
        );
      } finally {
        await store.close();
      }
    });
  });
});
