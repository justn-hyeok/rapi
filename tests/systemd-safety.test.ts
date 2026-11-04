import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

async function unit(name: string): Promise<string> {
  return readFile(new URL(`../ops/systemd/${name}`, import.meta.url), "utf8");
}

test("Discord services cap persistent crash restart loops", async () => {
  for (const name of ["redhood-bot.service"]) {
    const contents = await unit(name);
    assert.match(contents, /^StartLimitIntervalSec=10min$/m, name);
    assert.match(contents, /^StartLimitBurst=10$/m, name);
    assert.match(contents, /^RestartSec=30$/m, name);
  }
});

test("HTTP bot startup does not require the optional runtime socket path", async () => {
  const bot = await unit("redhood-bot.service");

  assert.doesNotMatch(bot, /^ReadWritePaths=.*\/run\/redhood-public-agent/m);
});

test("auto deploy runs CI-verified main without production secrets", async () => {
  const service = await unit("redhood-auto-deploy.service");
  const timer = await unit("redhood-auto-deploy.timer");
  assert.doesNotMatch(service, /^EnvironmentFile=/m);
  assert.match(service, /^User=justn$/m);
  assert.match(
    service,
    /^ExecStart=\/bin\/bash \/home\/justn\/redhood-releases\/current\/scripts\/auto-deploy\.sh$/m,
  );
  assert.match(timer, /^OnUnitInactiveSec=5min$/m);
  const script = await readFile(
    new URL("../scripts/auto-deploy.sh", import.meta.url),
    "utf8",
  );
  assert.match(script, /deploy-revision\.sh <\/dev\/null/);
  assert.match(script, /switch-release\.mjs <\/dev\/null/);
  assert.match(script, /check-runs/);
});

test("Codex-backed services can write Codex state under a read-only home", async () => {
  for (const name of ["redhood-bot"]) {
    assert.match(await unit(`${name}.service`), /^ProtectHome=read-only$/m);
    assert.match(
      await unit(`${name}.service.d/30-codex.conf`),
      /^ReadWritePaths=\/home\/justn\/\.codex$/m,
    );
  }
});
