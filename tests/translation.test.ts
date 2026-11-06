import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTranslations, translationPrompt } from "@rapi/adapters";

test("translations come back in order, and a missing one fails them all", () => {
  assert.match(translationPrompt(["注册送"]), /"id":"0","text":"注册送"/);
  assert.deepEqual(
    parseTranslations(
      JSON.stringify({
        items: [
          { id: "1", korean: "출석 25" },
          { id: "0", korean: " 가입 시 지급 " },
        ],
      }),
      ["注册送", "签到 25"],
    ),
    ["가입 시 지급", "출석 25"],
  );
  assert.throws(
    () =>
      parseTranslations(JSON.stringify({ items: [{ id: "0", korean: "a" }] }), [
        "a",
        "b",
      ]),
    /missing item 1/,
  );
});
