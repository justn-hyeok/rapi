import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const envExample = readFileSync(
  new URL("../.env.example", import.meta.url),
  "utf8",
);
const configSource = readFileSync(
  new URL("../packages/config/src/index.ts", import.meta.url),
  "utf8",
);

test(".env.example lists every key once", () => {
  const keys = [...envExample.matchAll(/^#? ?([A-Z][A-Z0-9_]+)=/gm)].map(
    (m) => m[1]!,
  );
  const duplicates = keys.filter((key, index) => keys.indexOf(key) !== index);
  assert.deepEqual([...new Set(duplicates)], []);
});

test("the config schema declares every key once", () => {
  const schema =
    /z\s*\.object\(\{([\s\S]*?)\n {2}\}\)/.exec(configSource)?.[1] ?? "";
  const keys = [...schema.matchAll(/^ {4}([A-Z][A-Z0-9_]+):/gm)].map(
    (m) => m[1]!,
  );
  assert.ok(keys.length > 20);
  const duplicates = keys.filter((key, index) => keys.indexOf(key) !== index);
  assert.deepEqual([...new Set(duplicates)], []);
});
