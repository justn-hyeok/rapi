import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_CARD_TEMPLATES,
  discountCard,
  fillTemplate,
  useCardTemplates,
  type CandidateForCard,
  type CardTemplates,
} from "@rapi/domain";

test("an optional part goes when any value in it is empty, and an empty line goes", () => {
  assert.equal(fillTemplate("{a}[[ · {b}]]", { a: "x", b: "y" }), "x · y");
  assert.equal(fillTemplate("{a}[[ · {b}]]", { a: "x", b: "" }), "x");
  assert.equal(fillTemplate("[[마감: {마감}]]", {}), "");
  assert.equal(fillTemplate("{ 없는값 }", {}), "");
});

test("a value is put in as it is, never read as a template", () => {
  assert.equal(
    fillTemplate("메모: {메모}", { 메모: "{제목} [[x]]", 제목: "새어 나옴" }),
    "메모: {제목} [[x]]",
  );
});

test("every route has a name on the cards", () => {
  for (const route of [
    "code_search",
    "pull_request",
    "changelog",
    "report",
    "catalog",
    "hacker_news",
    "credit_feed",
    "community",
    "relay_list",
    "promoclock",
    "relay_site",
    "free_list",
    "commit_log",
  ] satisfies CandidateForCard["route"][])
    assert.ok(DEFAULT_CARD_TEMPLATES.routeLabels[route], route);
});

test("cards follow the templates in use, palette and all", () => {
  const edited: CardTemplates = structuredClone(DEFAULT_CARD_TEMPLATES);
  edited.colors.green = "#00ff00";
  edited.cards.discount.author = "🔥 {출처}";
  edited.cards.discount.lines = ["**{내용}**", "[[⏰ {마감}까지]]"];
  useCardTemplates(edited);
  try {
    const card = discountCard(
      {
        id: "1",
        kind: "discount",
        route: "changelog",
        domain: "vercel.com",
        title: "Sol",
        url: "https://vercel.com/a",
        evidence: "Sol 50% off",
        band: "green",
        tags: [],
        operator: null,
        priceCheck: "unknown",
        termsNote: null,
      },
      "2026-11-30",
    );
    assert.deepEqual(
      [card.author, card.description, card.color],
      ["🔥 공식 변경로그", "**50% off**\n⏰ 2026\\-11\\-30까지", 0x00ff00],
    );
  } finally {
    useCardTemplates(DEFAULT_CARD_TEMPLATES);
  }
});
