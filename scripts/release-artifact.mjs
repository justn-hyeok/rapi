import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir, lstat, realpath } from "node:fs/promises";
import { resolve, relative, join } from "node:path";

// Where a release keeps its SQL. Releases before 0.0.11's package rename kept
// it under packages/db, and a switch still reads the release it replaces.
const SQL_DIRECTORIES = ["packages/adapters/postgres", "packages/db"];

function sqlDirectory(root, kind) {
  for (const directory of SQL_DIRECTORIES) {
    const path = join(root, directory, kind);
    if (existsSync(path)) return path;
  }
  return join(root, SQL_DIRECTORIES[0], kind);
}

export const migrationsPath = (root) => sqlDirectory(root, "migrations");
export const rollbacksPath = (root) => sqlDirectory(root, "rollbacks");

export async function releaseFileDigests(root) {
  const files = {};
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (
        ["node_modules", ".git", "tests", "release-manifest.json"].includes(
          entry.name,
        )
      )
        continue;
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Release contains a symlink");
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile())
        files[relative(root, path)] = createHash("sha256")
          .update(await readFile(path))
          .digest("hex");
    }
  }
  await walk(root);
  return files;
}

export async function verifyRelease(root, expectedSha) {
  const path = resolve(root);
  if ((await lstat(path)).isSymbolicLink() || (await realpath(path)) !== path)
    throw new Error("Release path must be canonical and not a symlink");
  const manifest = JSON.parse(
    await readFile(join(path, "release-manifest.json"), "utf8"),
  );
  if (
    !/^[a-f0-9]{40}$/.test(manifest.sha) ||
    (expectedSha && manifest.sha !== expectedSha) ||
    manifest.stagedPath !== path ||
    manifest.switched !== false
  )
    throw new Error("Release identity mismatch");
  const required = [
    "npm ci",
    "check",
    "test:e2e",
    "restart:smoke",
    "restore:smoke",
    "audit:prod",
  ];
  // A CI-verified release relies on GitHub CI for check, E2E and audit of
  // the same SHA and proves only build and migration restore on the host.
  const ciVerified = ["npm ci", "build", "restore:smoke", "github-ci"];
  if (
    !(
      required.every((gate) => manifest.gates?.includes(gate)) ||
      ciVerified.every((gate) => manifest.gates?.includes(gate))
    ) ||
    !manifest.files ||
    !Array.isArray(manifest.migrations)
  )
    throw new Error("Release verification evidence is incomplete");
  const actual = await releaseFileDigests(path);
  const expected = manifest.files;
  if (
    Object.keys(actual).length !== Object.keys(expected).length ||
    Object.entries(actual).some(([name, digest]) => expected[name] !== digest)
  )
    throw new Error("Release file digest mismatch");
  const migrations = (await readdir(migrationsPath(path)))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  if (JSON.stringify(migrations) !== JSON.stringify(manifest.migrations))
    throw new Error("Release migration set mismatch");
  return manifest;
}
