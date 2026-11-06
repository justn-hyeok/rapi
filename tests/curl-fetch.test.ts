import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { curlFetch } from "@rapi/adapters";

// A stand-in for curl that prints its arguments and a status, as -w would.
function fakeCurl(status: number): string {
  const path = join(mkdtempSync(join(tmpdir(), "rapi-curl-")), "curl");
  writeFileSync(
    path,
    `#!/bin/sh\nprintf '%s\\n' "$@"\nprintf '\\n__rapi_status__:${status}'\n`,
  );
  chmodSync(path, 0o755);
  return path;
}

test("curl gets the URL as an argument and its status comes back", async () => {
  const response = await curlFetch(fakeCurl(200))(
    "https://board.test/36.rss?a=1;rm -rf",
    { headers: { "User-Agent": "rapi" } },
  );
  assert.equal(response.status, 200);
  const args = (await response.text()).split("\n");
  assert.deepEqual(args.slice(-3, -1), [
    "--",
    "https://board.test/36.rss?a=1;rm%20-rf",
  ]);
  assert.ok(args.includes("User-Agent: rapi"));
  assert.ok(args.includes("=https"));
});

test("a refused page keeps its status, so the route sees the failure", async () => {
  const response = await curlFetch(fakeCurl(403))("https://board.test/");
  assert.equal(response.status, 403);
  assert.equal(response.ok, false);
});

test("curl is never asked for anything but https", async () => {
  await assert.rejects(
    curlFetch(fakeCurl(200))("http://board.test/"),
    /https only/,
  );
});
