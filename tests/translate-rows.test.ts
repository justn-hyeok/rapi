import assert from "node:assert/strict";
import { test } from "node:test";
import { discountCandidateJobs } from "@rapi/adapters";
import { collectDiscountCandidates, needsKorean } from "@rapi/agent";
import type { DiscountCandidate } from "@rapi/core";

const deal = { kind: "discount", route: "changelog" } as const;

test("English offers and any Chinese go into Korean; names and addresses stay", () => {
  assert.ok(needsKorean(deal, "GPT-6.1 Sol is 50% off on AI Gateway"));
  assert.ok(
    needsKorean({ kind: "new_service", route: "code_search" }, "注册送 $5"),
  );
  for (const text of [
    "MoonshotAI: Kimi K2.5 가격 인하",
    "https://api.relay.io/v1",
    "vercel.com",
    "Kimi K3",
  ])
    assert.ok(!needsKorean(deal, text), text);
  assert.ok(
    !needsKorean(
      { kind: "new_service", route: "pull_request" },
      "Add Infersia provider metadata",
    ),
  );
  assert.ok(
    !needsKorean({ kind: "discount", route: "report" }, "cheap llm api test"),
  );
});

test("a row seen before is not translated again", async () => {
  const rows = new Map<string, DiscountCandidate>();
  const asked: string[][] = [];
  const atom = `<feed><entry><id>a</id><title>Sol is now 50% off</title><link href="https://x.test/a"/><updated>2026-11-01T00:00:00Z</updated></entry></feed>`;
  const run = () =>
    collectDiscountCandidates({
      store: {
        knownCandidateKeys: async (keys: string[]) =>
          new Set(keys.filter((key) => rows.has(key))),
        createSource: async (kind: string, locator: string) =>
          `${kind}|${locator}`,
        sourceCursor: async () => null,
        saveDiscountCandidate: async (candidate: DiscountCandidate) => {
          if (rows.has(candidate.dedupeKey)) return false;
          rows.set(candidate.dedupeKey, candidate);
          return true;
        },
        saveCursor: async () => {},
        recordSourceFailure: async () => {},
      } as never,
      jobs: discountCandidateJobs({
        sources: {
          changelogs: [
            { url: "https://x.test/atom", format: "feed", maxAgeDays: 30 },
          ],
          pullRequests: { repository: "a/b" },
          codeSearch: { queries: [], denylist: [] },
          operators: [],
        },
        http: { fetch: (async () => new Response(atom)) as typeof fetch },
        now: () => new Date("2026-11-05T00:00:00Z"),
      }),
      translate: async (texts) => {
        asked.push(texts);
        return texts.map(() => "Sol 50% 할인");
      },
    });
  await run();
  await run();
  assert.deepEqual(asked, [["Sol is now 50% off", "Sol is now 50% off"]]);
  assert.equal([...rows.values()][0]!.title, "Sol 50% 할인");
});
