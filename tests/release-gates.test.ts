import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  migrationsPath,
  releaseFileDigests,
  rollbacksPath,
  verifyRelease,
} from "../scripts/release-artifact.mjs";

async function release(gates: string[]): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), "rapi-gates-")));
  await mkdir(join(path, "packages/db/migrations"), { recursive: true });
  await writeFile(
    join(path, "packages/db/migrations/0001_a.sql"),
    "SELECT 1;\n",
  );
  const sha = "a".repeat(40);
  await writeFile(
    join(path, "release-manifest.json"),
    JSON.stringify({
      sha,
      tree: sha,
      stagedPath: path,
      verifiedAt: new Date().toISOString(),
      gates,
      switched: false,
      files: await releaseFileDigests(path),
      migrations: ["0001_a.sql"],
    }),
  );
  return path;
}

test("a release needs either the full host gates or the CI-verified set", async () => {
  await verifyRelease(
    await release([
      "npm ci",
      "check",
      "test:e2e",
      "restart:smoke",
      "restore:smoke",
      "audit:prod",
    ]),
  );
  await verifyRelease(
    await release(["npm ci", "build", "restore:smoke", "github-ci"]),
  );
  await assert.rejects(
    verifyRelease(await release(["npm ci", "build", "github-ci"])),
    /incomplete/,
  );
  await assert.rejects(
    verifyRelease(await release(["npm ci", "build", "restore:smoke"])),
    /incomplete/,
  );
});

test("a release's SQL is under adapters/postgres, or packages/db before the rename", async () => {
  const legacy = await realpath(await mkdtemp(join(tmpdir(), "rapi-sql-")));
  await mkdir(join(legacy, "packages/db/migrations"), { recursive: true });
  assert.equal(migrationsPath(legacy), join(legacy, "packages/db/migrations"));
  const current = await realpath(await mkdtemp(join(tmpdir(), "rapi-sql-")));
  await mkdir(join(current, "packages/adapters/postgres/rollbacks"), {
    recursive: true,
  });
  await mkdir(join(current, "packages/db/rollbacks"), { recursive: true });
  assert.equal(
    rollbacksPath(current),
    join(current, "packages/adapters/postgres/rollbacks"),
  );
});
