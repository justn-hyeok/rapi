import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  allowedGuildIds,
  assertDiscordAccess,
  assertDiscordScope,
  createGuildGate,
  enabledGuildFeatures,
  isGuildAllowed,
  resolveDiscordAccess,
  resolveHomeGuildId,
  selectFeedTargets,
} from "@rapi/domain";
import {
  DiscordCommands,
  CommunityFeeds,
  feedGuildTargets,
  type SourceCollection,
} from "@rapi/application";

const ADMINISTRATOR = "8";
const policy = {
  userIds: ["owner"],
  adminUserIds: ["listed-admin"],
  adminRoleIds: ["admin-role"],
  homeGuildId: "home",
};

describe("admin scope", () => {
  const cases: Array<{
    name: string;
    identity: Parameters<typeof resolveDiscordAccess>[0];
    scope: "global" | "guild";
  }> = [
    {
      name: "Administrator permission in the home guild",
      identity: {
        userId: "u",
        guildId: "home",
        guildPermissions: ADMINISTRATOR,
      },
      scope: "global",
    },
    {
      name: "Administrator permission in a DM-less home role",
      identity: { userId: "u", guildId: "home", roleIds: ["admin-role"] },
      scope: "global",
    },
    {
      name: "Administrator permission in another guild",
      identity: {
        userId: "u",
        guildId: "other",
        guildPermissions: ADMINISTRATOR,
      },
      scope: "guild",
    },
    {
      name: "admin role in another guild",
      identity: { userId: "u", guildId: "other", roleIds: ["admin-role"] },
      scope: "guild",
    },
    {
      name: "admin user ID in another guild",
      identity: { userId: "listed-admin", guildId: "other" },
      scope: "global",
    },
    {
      name: "admin user ID with Administrator permission in another guild",
      identity: {
        userId: "listed-admin",
        guildId: "other",
        guildPermissions: ADMINISTRATOR,
      },
      scope: "global",
    },
  ];
  for (const item of cases)
    it(`${item.name} is ${item.scope}`, () => {
      const access = resolveDiscordAccess(item.identity, policy);
      assert.equal(access.level, "admin");
      assert.equal(access.scope, item.scope);
    });

  it("keeps SUPERADMIN global everywhere and the old API unchanged", () => {
    const identity = { userId: "owner", guildId: "other" };
    assert.deepEqual(resolveDiscordAccess(identity, policy), {
      level: "superadmin",
      scope: "global",
    });
    assert.equal(assertDiscordAccess(identity, policy), "superadmin");
    assert.equal(
      assertDiscordAccess(
        { userId: "u", guildId: "other", guildPermissions: ADMINISTRATOR },
        policy,
      ),
      "admin",
    );
  });

  it("treats DMs as global and everything as global without a home guild", () => {
    assert.equal(
      resolveDiscordAccess({ userId: "listed-admin" }, policy).scope,
      "global",
    );
    assert.equal(
      resolveDiscordAccess(
        { userId: "u", guildId: "other", guildPermissions: ADMINISTRATOR },
        { userIds: ["owner"] },
      ).scope,
      "global",
    );
  });

  it("asserts the scope", () => {
    assert.throws(
      () => assertDiscordScope({ level: "admin", scope: "guild" }, "global"),
      /운영자 서버/,
    );
    assertDiscordScope({ level: "admin", scope: "guild" }, "guild");
    assertDiscordScope({ level: "admin", scope: "global" }, "global");
  });
});

describe("commands by scope", () => {
  const service = new DiscordCommands(
    {} as unknown as SourceCollection,
    policy,
    {
      status: async () => "ok",
      guildAllowlist: async () => ["home", "other"],
    },
  );

  it("answers an unapproved guild with a short notice", async () => {
    await assert.rejects(
      service.execute(
        { userId: "owner", guildId: "stranger" },
        { name: "status", options: {} },
      ),
      /승인되지 않은 서버입니다.*서버 관리 권한이 있는 분이 \/서버신청/,
    );
  });
});

describe("guild allowlist decisions", () => {
  it("resolves the home guild in order", () => {
    assert.equal(resolveHomeGuildId("1", "2", ["3"]), "1");
    assert.equal(resolveHomeGuildId(undefined, "2", ["3"]), "2");
    assert.equal(resolveHomeGuildId(undefined, undefined, ["3", "4"]), "3");
    assert.equal(
      resolveHomeGuildId(undefined, undefined, undefined),
      undefined,
    );
  });

  it("unions env, approved and home guilds", () => {
    assert.deepEqual(allowedGuildIds(["a"], ["b", "a"], "h").sort(), [
      "a",
      "b",
      "h",
    ]);
    assert.equal(isGuildAllowed("x", ["a"]), false);
    assert.equal(isGuildAllowed("a", ["a"]), true);
  });

  it("answers in no guild when nothing is configured", async () => {
    assert.deepEqual(allowedGuildIds(undefined, [], undefined), []);
    const gate = createGuildGate({
      envIds: undefined,
      homeGuildId: undefined,
      load: async () => [],
    });
    assert.equal(isGuildAllowed("x", await gate.allowed()), false);
  });

  it("caches the approved guilds until invalidated", async () => {
    let loads = 0;
    let at = 0;
    const gate = createGuildGate({
      envIds: ["a"],
      homeGuildId: undefined,
      load: async () => {
        loads += 1;
        return loads > 1 ? ["b"] : [];
      },
      ttlMs: 100,
      now: () => at,
    });
    assert.deepEqual(await gate.allowed(), ["a"]);
    assert.deepEqual(await gate.allowed(), ["a"]);
    assert.equal(loads, 1);
    gate.invalidate();
    assert.deepEqual(await gate.allowed(), ["a", "b"]);
    at = 500;
    await gate.allowed();
    assert.equal(loads, 3);
  });
});

describe("per-guild feeds", () => {
  const day = (n: number) => new Date(Date.UTC(2026, 0, n));

  it("skips guilds that already got the post and guilds approved later", () => {
    assert.deepEqual(
      selectFeedTargets(
        day(10),
        [
          { guildId: "a", allowedSince: null },
          { guildId: "b", allowedSince: day(5) },
          { guildId: "c", allowedSince: day(12) },
          { guildId: "d", allowedSince: null },
          { guildId: "a", allowedSince: null },
        ],
        new Set(["d"]),
      ),
      ["a", "b"],
    );
  });

  function setup(
    targets: Array<{ guildId: string; allowedSince: Date | null }>,
  ) {
    const posted: Array<{ channel: string }> = [];
    const sentKeys = new Set<string>();
    const channels: Record<string, string> = {
      "home|curation_ai_blogs": "home-ch",
      "g2|curation_ai_blogs": "g2-ch",
    };
    const store = {
      communityDraft: async (key: string) => ({
        key,
        feed: "ai-blogs",
        embeds: [{ title: "t" }],
        created: new Date(),
      }),
      settleCommunityDraft: async () => true,
      managedDiscordResourceId: async (
        guild: string,
        _type: string,
        key: string,
      ) => channels[`${guild}|${key}`] ?? null,
      communityGuildPostSent: async (guild: string, key: string) =>
        sentKeys.has(`${guild}|${key}`),
      recordCommunityGuildPost: async (input: {
        guildId: string;
        key: string;
      }) => {
        sentKeys.add(`${input.guildId}|${input.key}`);
      },
    } as never;
    const feeds = new CommunityFeeds(store, undefined, {
      guildId: "home",
      guildTargets: async () => targets,
      getText: async () => {
        throw new Error("no network in tests");
      },
      post: async (channel) => {
        posted.push({ channel });
        return "m";
      },
    });
    return { feeds, posted };
  }

  it("posts to each allowed guild with the channel, once", async () => {
    const { feeds, posted } = setup([
      { guildId: "g2", allowedSince: null },
      { guildId: "g3", allowedSince: null },
      { guildId: "future", allowedSince: new Date(Date.now() + 3_600_000) },
    ]);
    await feeds.sendDraft("k1");
    assert.deepEqual(
      posted.map((p) => p.channel),
      ["home-ch", "g2-ch"],
    );
    // The same key again must not reach g2 twice.
    await feeds.sendDraft("k1");
    assert.deepEqual(
      posted.map((p) => p.channel),
      ["home-ch", "g2-ch", "home-ch"],
    );
  });

  it("feed cards only go to allowed guilds with them switched on", async () => {
    const allowedAt = new Date("2026-01-01T00:00:00Z");
    const targets = await feedGuildTargets({
      store: {
        allowedDiscordGuilds: async () => [
          { guildId: "approved-on", allowedAt },
          { guildId: "approved-off", allowedAt },
        ],
      },
      extraGuildIds: ["env-on", "env-off"],
      guildFeatures: {
        enabled: async (guildId) =>
          enabledGuildFeatures(
            guildId.endsWith("-on")
              ? [{ feature: "curation", enabled: true }]
              : [],
          ),
      },
    });
    assert.deepEqual(targets, [
      { guildId: "env-on", allowedSince: null },
      { guildId: "approved-on", allowedSince: allowedAt },
    ]);
  });

  it("behaves as before when the community guild is the only guild", async () => {
    const { feeds, posted } = setup([{ guildId: "home", allowedSince: null }]);
    await feeds.sendDraft("k");
    assert.deepEqual(
      posted.map((p) => p.channel),
      ["home-ch"],
    );
  });
});
