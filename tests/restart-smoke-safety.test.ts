import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const script = fileURLToPath(
  new URL("../scripts/restart-smoke.sh", import.meta.url),
);

describe("restart smoke target safety", () => {
  it("requires disposable project and redhood_test before Docker can run", async () => {
    await assert.rejects(
      execFileAsync("bash", [script], {
        env: {
          PATH: "/usr/bin:/bin",
          RESTART_SMOKE_PROJECT: "redhood",
          RESTART_SMOKE_DATABASE: "redhood",
        },
      }),
      /RESTART_SMOKE_PROJECT/,
    );
  });

  it("rejects an artifact path outside the owned evidence directory before Docker", async () => {
    await assert.rejects(
      execFileAsync("bash", [script], {
        env: {
          PATH: "/usr/bin:/bin",
          RESTART_SMOKE_PROJECT: "redhood-restart-safe",
          RESTART_SMOKE_DATABASE: "redhood_test",
          RESTART_SMOKE_ARTIFACT: "/tmp/unsafe.json",
        },
      }),
      /RESTART_SMOKE_ARTIFACT/,
    );
  });

  it("uses an isolated project, test compose file, and seeded probe", async () => {
    const source = await readFile(script, "utf8");
    assert.match(source, /RESTART_SMOKE_PROJECT must be a disposable/);
    assert.match(source, /RESTART_SMOKE_DATABASE must be redhood_test/);
    assert.match(
      source,
      /docker compose -p "\$restart_project" -f compose\.test\.yaml/,
    );
    assert.match(source, /CREATE TABLE IF NOT EXISTS restart_smoke_probe/);
    assert.doesNotMatch(source, /-d redhood(?:\s|$)/);
  });
});
