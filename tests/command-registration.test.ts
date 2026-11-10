import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import {
  clearGuildCommands,
  globalCommandDefinitions,
  registerAllowedGuildCommands,
  slashCommandDefinitions,
} from "../apps/bot/src/discord-http.js";

const GLOBAL = "https://discord.com/api/v10/applications/app/commands";

describe("command registration", () => {
  /** Answers each guild's PUT from `statuses`; 204 when it is not listed. */
  function discord(t: TestContext, statuses: Record<string, number> = {}) {
    const urls: string[] = [];
    const bodies = new Map<string, Array<{ name: string }>>();
    t.mock.method(
      globalThis,
      "fetch",
      async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        urls.push(url);
        bodies.set(
          url,
          JSON.parse(init!.body as string) as Array<{ name: string }>,
        );
        const guild = /guilds\/([^/]+)/.exec(url)?.[1] ?? "";
        return new Response(
          statuses[guild] ? JSON.stringify({ message: "Missing Access" }) : "",
          { status: statuses[guild] ?? 200 },
        );
      },
    );
    return { urls, bodies };
  }
  const options = {
    applicationId: "app",
    botToken: "secret-token",
    envGuildIds: ["a", "b"],
    homeGuildId: "home",
    loadApproved: async () => ["c", "a"],
  };

  it("registers in every allowed guild, each once, and globally", async (t) => {
    const { urls } = discord(t);
    assert.deepEqual(await registerAllowedGuildCommands(options), []);
    assert.equal(urls.filter((url) => url === GLOBAL).length, 1);
    assert.deepEqual(
      urls
        .filter((url) => url !== GLOBAL)
        .map((url) => /guilds\/([^/]+)/.exec(url)?.[1])
        .sort(),
      ["a", "b", "c", "home"],
    );
  });

  it("gives an unapproved server only the request command", async (t) => {
    const { bodies } = discord(t);
    await registerAllowedGuildCommands(options);
    assert.deepEqual(
      bodies.get(GLOBAL)?.map((command) => command.name),
      ["서버신청"],
    );
    const names = (guild: string) =>
      bodies
        .get(
          `https://discord.com/api/v10/applications/app/guilds/${guild}/commands`,
        )
        ?.map((command) => command.name);
    assert.deepEqual(
      names("home"),
      slashCommandDefinitions.map((command) => command.name),
    );
    // Only the owner uses these, at home, so nobody else is shown them.
    for (const guild of ["a", "b", "c"])
      assert.deepEqual(
        names(guild),
        slashCommandDefinitions
          .map((command) => command.name)
          .filter((name) => name !== "검토-알림" && name !== "대시보드"),
      );
    assert.ok(
      !slashCommandDefinitions.some((command) => command.name === "서버신청"),
    );
  });

  it("offers the request in servers only, to those who manage them", () => {
    const command = globalCommandDefinitions[0]!;
    assert.deepEqual(command.contexts, [0]);
    assert.deepEqual(command.integration_types, [0]);
    assert.equal(command.default_member_permissions, "32");
  });

  it("clears a guild's commands with an empty list", async (t) => {
    const { urls, bodies } = discord(t);
    await clearGuildCommands("app", "secret-token", "c");
    assert.deepEqual(bodies.get(urls[0]!), []);
    assert.match(urls[0]!, /guilds\/c\/commands$/);
  });

  it("keeps going after a guild refuses, and reports it", async (t) => {
    const { urls } = discord(t, { a: 403 });
    const failures = await registerAllowedGuildCommands(options);
    assert.equal(urls.length, 5);
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
    assert.equal(calls, 5);
    assert.deepEqual(failures, ["global: network down"]);
  });

  it("still registers env guilds when the approved list cannot be read", async (t) => {
    const { urls } = discord(t);
    const failures = await registerAllowedGuildCommands({
      ...options,
      loadApproved: async () => {
        throw new Error("database down");
      },
    });
    assert.equal(urls.length, 4);
    assert.deepEqual(failures, ["approved guilds: database down"]);
  });

  it("registers only the global command when no guild is configured", async (t) => {
    const { urls } = discord(t);
    await registerAllowedGuildCommands({
      ...options,
      envGuildIds: undefined,
      homeGuildId: undefined,
      loadApproved: async () => [],
    });
    assert.deepEqual(urls, [GLOBAL]);
  });
});
