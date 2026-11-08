import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parsePromoClock,
  PromoClockRoute,
  loadDiscountSources,
} from "@rapi/adapters";

const line = (slug: string, title: string, terms: string, source: string) =>
  `- **${title}** — ${terms} Details: https://promoclock.co/en/deals/${slug}/ · Source: ${source} (verified 2026-11-02)`;
const llms = (...deals: string[]) =>
  [
    "# PromoClock",
    "## Claude peak hours",
    line("not-a-deal", "Peak", "weekdays (ongoing).", "https://claude.com/x"),
    "## Latest Claude changes",
    line(
      "startups-2026",
      "Claude: free Team year (paused)",
      "1 year (2026-10-06 → 2026-10-09).",
      "https://claude.com/startups",
    ),
    "## Live AI deals (2)",
    ...deals,
    "## Blog: guides and comparisons (1)",
    line("blog", "A guide", "read it.", "https://promoclock.co/blog"),
  ].join("\n");
const ARGON = line(
  "gemini-argon-2026",
  "Google AI Studio: Gemini 4 Argon API at half price",
  "50% off API rates for Developers (2026-10-13 → 2026-11-30).",
  "https://ai.google.dev/gemini-api/docs/pricing",
);
const COPILOT = line(
  "copilot-fusion-2026",
  "GitHub Copilot: Copilot Fusion: 30% off model costs",
  "30% off model costs (2026-10-28 → 2026-12-01).",
  "https://docs.github.com/en/copilot/concepts/models/copilot-fusion",
);
const SOURCE = { url: "https://promoclock.co/llms.txt" };
const collect = (body: string, cursor: string | null) =>
  new PromoClockRoute({
    fetch: (async () => new Response(body)) as typeof fetch,
  }).collect(SOURCE, cursor);

test("only live deals are read, and their end dates read as ends", () => {
  assert.deepEqual(parsePromoClock(llms(ARGON)), [
    {
      slug: "gemini-argon-2026",
      title: "Google AI Studio: Gemini 4 Argon API at half price",
      terms: "50% off API rates for Developers (2026-10-13 ~ 2026-11-30).",
      source: "https://ai.google.dev/gemini-api/docs/pricing",
    },
  ]);
});

test("the first look records the list and later only new deals come out", async () => {
  const first = await collect(llms(ARGON), null);
  assert.deepEqual(first.candidates, []);
  const { candidates } = await collect(llms(ARGON, COPILOT), first.cursor!);
  assert.deepEqual(candidates, [
    {
      kind: "discount",
      route: "promoclock",
      dedupeKey: "promoclock:copilot-fusion-2026",
      domain: "docs.github.com",
      title: "GitHub Copilot: Copilot Fusion: 30% off model costs",
      url: "https://docs.github.com/en/copilot/concepts/models/copilot-fusion",
      evidence: "30% off model costs (2026-10-28 ~ 2026-12-01).",
      publishedAt: null,
    },
  ]);
});

test("a list with no deals fails and keeps the last record", async () => {
  await assert.rejects(collect(llms(), '{"slugs":[]}'), /lists no deals/);
});

test("the shipped sources read PromoClock's llms.txt", async () => {
  const sources = await loadDiscountSources(process.cwd());
  assert.deepEqual(sources.promoClock, SOURCE);
});
