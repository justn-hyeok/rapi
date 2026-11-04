import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { registerAllowedGuildCommands } from "../apps/bot/src/discord-http.js";

describe("command registration", () => {
  /** Answers each guild's PUT from `statuses`; 204 when it is not listed. */
  function discord(t: TestContext, statuses: Record<string, number> = {}) {
    const urls: string[] = [];
    t.mock.method(
      globalThis,
      "fetch",
      async (input: string | URL | Request) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        urls.push(url);
        const guild = /guilds\/([^/]+)/.exec(url)?.[1] ?? "";
        return new Response(
          statuses[guild] ? JSON.stringify({ message: "Missing Access" }) : "",
          { status: statuses[guild] ?? 200 },
        );
      },
    );
    return urls;
  }
  const options = {
    applicationId: "app",
    botToken: "secret-token",
    envGuildIds: ["a", "b"],
    homeGuildId: "home",
    loadApproved: async () => ["c", "a"],
  };

  it("registers in every allowed guild, each once", async (t) => {
    const urls = discord(t);
    assert.deepEqual(await registerAllowedGuildCommands(options), []);
    assert.deepEqual(
      urls.map((url) => /guilds\/([^/]+)/.exec(url)?.[1]).sort(),
      ["a", "b", "c", "home"],
    );
  });

  it("keeps going after a guild refuses, and reports it", async (t) => {
    const urls = discord(t, { a: 403 });
    const failures = await registerAllowedGuildCommands(options);
    assert.equal(urls.length, 4);
    assert.deepEqual(failures, [
      "a: Discord command registration failed: 403 Missing Access",
    ]);
    assert.doesNotMatch(failures.join(), /secret-token/);
  });

  it("keeps going when a request throws", async (t) => {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      calls += 1;
      if (calls === 1) throw new Error("network down");
      return new Response("", { status: 200 });
    });
    const failures = await registerAllowedGuildCommands(options);
    assert.equal(calls, 4);
    assert.deepEqual(failures, ["a: network down"]);
  });

  it("still registers env guilds when the approved list cannot be read", async (t) => {
    const urls = discord(t);
    const failures = await registerAllowedGuildCommands({
      ...options,
      loadApproved: async () => {
        throw new Error("database down");
      },
    });
    assert.equal(urls.length, 3);
    assert.deepEqual(failures, ["approved guilds: database down"]);
  });

  it("registers globally when no guild is configured", async (t) => {
    const urls = discord(t);
    await registerAllowedGuildCommands({
      ...options,
      envGuildIds: undefined,
      homeGuildId: undefined,
      loadApproved: async () => [],
    });
    assert.deepEqual(urls, [
      "https://discord.com/api/v10/applications/app/commands",
    ]);
  });
});
