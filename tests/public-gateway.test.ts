import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import { createDiscordInteractionServer } from "../apps/bot/src/discord-http.js";
import { DiscordCommands, type SourceCollection } from "@rapi/application";
async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

test("public gateway denies private routes, forwards signed interactions and fails readiness with its upstream", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicHex = publicKey
    .export({ format: "der", type: "spki" })
    .subarray(-32)
    .toString("hex");
  const service = new DiscordCommands({} as SourceCollection, {
    userIds: [],
  });
  let ready = true;
  const bot = createDiscordInteractionServer(service, publicHex, {
    async readiness() {
      return { ready };
    },
    async pages(_method, url) {
      return url.pathname.startsWith("/stars") ||
        url.pathname === "/" ||
        url.pathname === "/privacy" ||
        url.pathname.startsWith("/help") ||
        url.pathname === "/connect/github/callback"
        ? { status: 200, type: "text/plain", body: "star page" }
        : null;
    },
  });
  bot.listen(0, "127.0.0.1");
  await once(bot, "listening");
  const address = bot.address();
  assert.ok(address && typeof address === "object");
  const port = await freePort();
  const health = await freePort();
  let child: ChildProcess | undefined;
  try {
    child = spawn(process.execPath, ["ops/gateway/run.mjs"], {
      env: {
        ...process.env,
        PORT: String(address.port),
        RAPI_GATEWAY_PORT: String(port),
        RAPI_GATEWAY_HEALTH_PORT: String(health),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await once(child.stdout!, "data");
    const base = `http://127.0.0.1:${port}`;
    for (const path of [
      "/health",
      "/ready",
      "/v1/answer",
      "/blog",
      "/b/00000000-0000-0000-0000-000000000000",
      "/github/webhook",
      "/interactions/extra",
      "/%69nteractions",
    ]) {
      assert.equal((await fetch(base + path, { method: "POST" })).status, 404);
    }
    assert.equal((await fetch(base + "/interactions")).status, 404);
    // The intro and privacy pages pass on GET and nothing else does.
    assert.equal((await fetch(base + "/")).status, 200);
    assert.equal((await fetch(base + "/privacy")).status, 200);
    assert.equal((await fetch(base + "/privacy/x")).status, 404);
    assert.equal((await fetch(base + "/", { method: "HEAD" })).status, 200);
    assert.equal(
      (await fetch(base + "/privacy", { method: "HEAD" })).status,
      200,
    );
    assert.equal((await fetch(base + "/help", { method: "HEAD" })).status, 404);
    assert.equal((await fetch(base + "/help")).status, 200);
    assert.equal(
      (await fetch(base + "/help/suggestions?t=x", { method: "POST" })).status,
      200,
    );
    assert.equal((await fetch(base + "/help/suggestions")).status, 404);
    assert.equal((await fetch(base + "/help/x")).status, 404);
    assert.equal((await fetch(base + "/", { method: "POST" })).status, 404);
    assert.equal(
      (await fetch(base + "/privacy", { method: "POST" })).status,
      404,
    );
    // The star page's three paths pass; anything else under /stars does not.
    assert.equal((await fetch(base + "/stars?t=x")).status, 200);
    assert.equal((await fetch(base + "/stars/data?t=x")).status, 200);
    assert.equal(
      (await fetch(base + "/connect/github/callback?code=x")).status,
      200,
    );
    // Only a service's callback passes, not anything else under /connect.
    for (const path of [
      "/github/callback",
      "/connect/github",
      "/connect/GitHub/callback",
      "/connect/github/callback/x",
    ])
      assert.equal((await fetch(base + path)).status, 404, path);
    assert.equal(
      (
        await fetch(base + "/stars/interests?t=x", {
          method: "POST",
          body: "{}",
        })
      ).status,
      200,
    );
    assert.equal((await fetch(base + "/stars/other")).status, 404);
    assert.equal(
      (await fetch(base + "/stars", { method: "POST" })).status,
      404,
    );
    assert.equal((await fetch(base + "/stars/interests")).status, 404);
    assert.equal(
      (await fetch(base + "/interactions", { method: "POST", body: "{}" }))
        .status,
      401,
    );
    const body = '{"type":1}';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = sign(
      null,
      Buffer.from(timestamp + body),
      privateKey,
    ).toString("hex");
    const interaction = await fetch(base + "/interactions", {
      method: "POST",
      body,
      headers: {
        "x-signature-ed25519": signature,
        "x-signature-timestamp": timestamp,
      },
    });
    assert.equal(interaction.status, 200);
    assert.deepEqual(await interaction.json(), { type: 1 });
    assert.equal((await fetch(`http://127.0.0.1:${health}/ready`)).status, 200);
    ready = false;
    assert.equal((await fetch(`http://127.0.0.1:${health}/ready`)).status, 503);
  } finally {
    if (child) {
      const closed = once(child, "close");
      child.kill("SIGTERM");
      await closed;
    }
    bot.closeAllConnections();
    await new Promise<void>((resolve) => bot.close(() => resolve()));
  }
});
