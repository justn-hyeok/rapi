import assert from "node:assert/strict";
import { test } from "node:test";
import {
  discordEmbed,
  isForgottenStar,
  pickForgottenStars,
  starButton,
  starCard,
  type StoredStar,
} from "@rapi/domain";

const now = new Date("2026-11-05T00:00:00Z");
const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000);
const star = (
  fullName: string,
  fields: Partial<StoredStar> = {},
): StoredStar => ({
  fullName,
  url: `https://github.com/${fullName}`,
  description: "",
  language: null,
  stars: 10,
  archived: false,
  starredAt: daysAgo(400),
  lastRemindedAt: null,
  ...fields,
});

test("forgotten means starred over 30 days ago and not reminded for 180", () => {
  const forgotten = (fields: Partial<StoredStar>) =>
    isForgottenStar(star("a/b", fields), now);
  assert.equal(forgotten({ starredAt: daysAgo(31) }), true);
  assert.equal(forgotten({ starredAt: daysAgo(29) }), false);
  assert.equal(forgotten({ lastRemindedAt: daysAgo(181) }), true);
  assert.equal(forgotten({ lastRemindedAt: daysAgo(179) }), false);
  assert.equal(forgotten({ archived: true }), false);
});

test("picks one or two, and the coin decides which", () => {
  const stars = [star("a/1"), star("a/2"), star("a/3")];
  assert.equal(pickForgottenStars(stars, now, () => 0.1).length, 1);
  assert.equal(pickForgottenStars(stars, now, () => 0.9).length, 2);
  assert.equal(pickForgottenStars(stars.slice(0, 1), now, () => 0.9).length, 1);
  assert.deepEqual(pickForgottenStars([], now), []);
});

test("the pick never repeats a star within the day's message", () => {
  const stars = [star("a/1"), star("a/2")];
  const names = pickForgottenStars(stars, now, () => 0.99).map(
    (picked) => picked.fullName,
  );
  assert.deepEqual([...names].sort(), ["a/1", "a/2"]);
});

test("never reminded and longest since a reminder go first, oldest star breaking ties", () => {
  const filler = Array.from({ length: 20 }, (_, index) =>
    star(`waited/${index}`, { lastRemindedAt: daysAgo(200) }),
  );
  const stars = [
    star("reminded/recently", { lastRemindedAt: daysAgo(181) }),
    ...filler,
    star("never/newer", { starredAt: daysAgo(40) }),
    star("never/older", { starredAt: daysAgo(900) }),
  ];
  const first = pickForgottenStars(stars, now, () => 0);
  assert.deepEqual(
    first.map((picked) => picked.fullName),
    ["never/older"],
  );
  // The random draw only reaches the 20 that waited longest.
  const seen = new Set<string>();
  for (let draw = 0; draw < 1; draw += 0.01)
    for (const picked of pickForgottenStars(stars, now, () => draw))
      seen.add(picked.fullName);
  assert.equal(seen.has("reminded/recently"), false);
  assert.ok(seen.size > 2);
});

test("a repository's text cannot mention, link or format anything", () => {
  const card = discordEmbed(
    starCard(
      star("evil/[click](x)", {
        description:
          "@everyone **free** [prize](https://evil.test) <@1>\nsecond line",
        language: "C++",
        stars: 1234,
        starredAt: new Date("2024-03-01T20:00:00Z"),
      }),
    ),
  ) as { title: string; description: string };
  assert.ok(card.title.includes("\\[click\\]\\(x\\)"));
  assert.ok(!card.description.includes("https://"));
  assert.ok(card.description.includes("\\@everyone"));
  assert.ok(card.description.includes("\\*\\*free\\*\\*"));
  assert.ok(card.description.includes("\\<\\@1\\>"));
  assert.ok(card.description.includes("second line"));
  // Korean date, so a star pressed in the evening UTC reads as the next morning.
  assert.ok(card.description.endsWith("C++ · ★ 1,234 · 2024-03-02에 누름"));
});

test("the button goes to the repository and fits Discord's label limit", () => {
  const long = `owner/${"x".repeat(100)}`;
  const button = starButton(star(long));
  assert.ok(button);
  assert.equal(button.url, `https://github.com/${long}`);
  assert.equal(button.style, 5);
  assert.equal(button.label.length, 80);
  assert.equal(starButton(star("a/b", { url: "http://github.com/a/b" })), null);
});
