import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { once } from "node:events";
import { describe, it, test, type TestContext } from "node:test";
import {
  createGuildFeatures,
  DiscordCommandService,
  type DiscordCommand,
  type RapiAgent,
} from "@rapi/agent";
import type { DiscordIdentity } from "@rapi/domain";
import { createDiscordInteractionServer } from "../apps/bot/src/discord-http.js";

const OWNER: DiscordIdentity = { userId: "owner", guildId: "other" };
const MEMBER: DiscordIdentity = {
  userId: "member",
  guildId: "other",
  roleIds: [],
};
const report: DiscordCommand = {
  name: "report",
  options: { link: "https://new.ai/" },
};
const turn = (action: "켜기" | "끄기", feature: string): DiscordCommand => ({
  name: "features",
  options: { action, feature },
});

/** The real switch over an in-memory table. */
function setup(t: TestContext, saved: Record<string, boolean> = {}) {
  const rows = new Map(Object.entries(saved));
  const store = {
    guildFeatureSettings: t.mock.fn(async () =>
      [...rows].map(([feature, enabled]) => ({ feature, enabled })),
    ),
    setGuildFeature: t.mock.fn(
      async (_guild: string, feature: string, enabled: boolean) => {
        rows.set(feature, enabled);
      },
    ),
  };
  const guildFeatures = createGuildFeatures({ store, homeGuildId: "home" });
  const reported = t.mock.fn(async () => "받았습니다");
  const apply = t.mock.fn(async () => "적용했습니다");
  const commands = new DiscordCommandService(
    {} as RapiAgent,
    {
      userIds: ["owner"],
      superadminUserIds: ["second-owner"],
      adminUserIds: ["listed-admin"],
      homeGuildId: "home",
    },
    {
      status: async () => "ok",
      report: reported,
      guildFeatures,
      serverConfig: {
        preview: async () => ({ summary: "s", planId: "p" }),
        apply,
        export: async () => "",
      },
    },
  );
  return { store, guildFeatures, reported, apply, commands };
}

describe("default features", () => {
  it("refuses a switched-off command in Korean and does nothing", async (t) => {
    const { commands, reported, apply } = setup(t);
    await assert.rejects(commands.execute(MEMBER, report), /제보 기능이 꺼져/);
    // The owner gets the same answer: the switch is about the server, not the person.
    await assert.rejects(commands.execute(OWNER, report), /제보 기능이 꺼져/);
    await assert.rejects(
      commands.execute(OWNER, {
        name: "server_config",
        options: { action: "미리보기" },
      }),
      /서버 구성 기능이 꺼져/,
    );
    assert.equal(reported.mock.callCount(), 0);
    assert.equal(apply.mock.callCount(), 0);
    assert.deepEqual(
      (await commands.execute(OWNER, { name: "status", options: {} })).messages,
      ["ok"],
    );
  });

  it("refuses a stale layout button once the feature is off", async (t) => {
    const { commands, apply } = setup(t);
    await assert.rejects(
      commands.execute(OWNER, {
        name: "server_config",
        options: { action: "적용", planId: "old" },
      }),
      /서버 구성 기능이 꺼져/,
    );
    assert.equal(apply.mock.callCount(), 0);
    await assert.rejects(
      commands.assertGuildFeature("other", "server_config"),
      /꺼져/,
    );
  });
});

describe("home guild", () => {
  const home = { userId: "member", guildId: "home", roleIds: [] };

  it("has everything on, whatever is saved, without reading the database", async (t) => {
    const { commands, store, guildFeatures, reported } = setup(t, {
      report: false,
    });
    assert.equal((await guildFeatures.enabled("home")).size, 5);
    assert.deepEqual((await commands.execute(home, report)).messages, [
      "받았습니다",
    ]);
    assert.equal(reported.mock.callCount(), 1);
    assert.equal(store.guildFeatureSettings.mock.callCount(), 0);
  });

  it("cannot be switched off", async (t) => {
    const { commands, store } = setup(t);
    await assert.rejects(
      commands.execute(
        { userId: "owner", guildId: "home" },
        turn("끄기", "report"),
      ),
      /홈 서버는 항상 모두 켜져/,
    );
    assert.equal(store.setGuildFeature.mock.callCount(), 0);
  });
});

describe("/기능", () => {
  it("switches a feature for one server, from the next interaction", async (t) => {
    const { commands, store, reported } = setup(t);
    const on = await commands.execute(OWNER, turn("켜기", "report"));
    assert.match(on.messages[0]!, /제보 기능을 켰습니다/);
    assert.match(on.messages[0]!, /켜짐 · 제보/);
    assert.deepEqual(store.setGuildFeature.mock.calls[0]!.arguments, [
      "other",
      "report",
      true,
      "owner",
    ]);
    assert.deepEqual((await commands.execute(MEMBER, report)).messages, [
      "받았습니다",
    ]);
    await commands.execute(OWNER, turn("끄기", "report"));
    await assert.rejects(commands.execute(MEMBER, report), /꺼져/);
    assert.equal(reported.mock.callCount(), 1);
  });

  it("shows what is on without changing anything", async (t) => {
    const { commands, store } = setup(t);
    const { messages } = await commands.execute(OWNER, {
      name: "features",
      options: { action: "보기" },
    });
    assert.match(messages[0]!, /켜짐 · 상태/);
    assert.match(messages[0]!, /꺼짐 · 제보/);
    assert.equal(store.setGuildFeature.mock.callCount(), 0);
  });

  it("takes both owner lists and nobody else, not even a server admin", async (t) => {
    const { commands, store } = setup(t);
    await commands.execute(
      { userId: "second-owner", guildId: "other" },
      turn("켜기", "report"),
    );
    assert.equal(store.setGuildFeature.mock.callCount(), 1);
    const refused: DiscordIdentity[] = [
      MEMBER,
      { userId: "server-admin", guildId: "other", guildPermissions: "8" },
      { userId: "server-admin", guildId: "home", guildPermissions: "8" },
      { userId: "listed-admin", guildId: "other" },
    ];
    for (const identity of refused) {
      await assert.rejects(
        commands.execute(identity, turn("켜기", "server_config")),
        /소유자만/,
      );
      await assert.rejects(
        commands.execute(identity, {
          name: "features",
          options: { action: "보기" },
        }),
        /소유자만/,
      );
    }
    assert.equal(store.setGuildFeature.mock.callCount(), 1);
  });

  it("rejects a feature not on the list and a DM", async (t) => {
    const { commands, store } = setup(t);
    await assert.rejects(
      commands.execute(OWNER, turn("켜기", "everything")),
      /알 수 없는 기능/,
    );
    await assert.rejects(
      commands.execute({ userId: "owner" }, turn("켜기", "report")),
      /서버에서만/,
    );
    assert.equal(store.setGuildFeature.mock.callCount(), 0);
  });

  it("still reaches the owner when another guild's channel list is set", async (t) => {
    const guildFeatures = setup(t).guildFeatures;
    const commands = new DiscordCommandService(
      {} as RapiAgent,
      { userIds: ["owner"], channelIds: ["home-channel"] },
      { status: async () => "ok", guildFeatures },
    );
    await commands.execute(
      { ...OWNER, channelId: "there" },
      turn("켜기", "report"),
    );
  });
});

test("a failed read refuses without showing the database error", async (t) => {
  t.mock.method(process.stderr, "write", () => true);
  const failing = createGuildFeatures({
    store: {
      guildFeatureSettings: async () => {
        throw new Error("connect ECONNREFUSED 10.0.0.1:5432");
      },
      setGuildFeature: async () => {
        throw new Error("connect ECONNREFUSED 10.0.0.1:5432");
      },
    },
    homeGuildId: "home",
  });
  const reported = t.mock.fn(async () => "받았습니다");
  const commands = new DiscordCommandService(
    {} as RapiAgent,
    { userIds: ["owner"] },
    { status: async () => "ok", report: reported, guildFeatures: failing },
  );
  await assert.rejects(commands.execute(MEMBER, report), (error: Error) => {
    assert.match(error.message, /확인하지 못했습니다/);
    assert.doesNotMatch(error.message, /ECONNREFUSED/);
    return true;
  });
  await assert.rejects(
    commands.execute(OWNER, turn("켜기", "report")),
    /저장하지 못했습니다/,
  );
  assert.equal(reported.mock.callCount(), 0);
});

describe("answers over HTTP", () => {
  async function post(
    t: TestContext,
    interaction: object,
    component?: (commands: DiscordCommandService) => () => Promise<string>,
  ) {
    const { commands } = setup(t);
    const keys = generateKeyPairSync("ed25519");
    const key = (
      keys.publicKey.export({ type: "spki", format: "der" }) as Buffer
    )
      .subarray(-32)
      .toString("hex");
    const server = createDiscordInteractionServer(commands, key, {
      ...(component ? { component: component(commands) } : {}),
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    const address = server.address();
    assert(address && typeof address === "object");
    const body = Buffer.from(JSON.stringify(interaction));
    const timestamp = String(Math.floor(Date.now() / 1000));
    const response = await fetch(
      `http://127.0.0.1:${address.port}/interactions`,
      {
        method: "POST",
        headers: {
          "x-signature-timestamp": timestamp,
          "x-signature-ed25519": sign(
            null,
            Buffer.concat([Buffer.from(timestamp), body]),
            keys.privateKey,
          ).toString("hex"),
        },
        body,
      },
    );
    return (await response.json()) as {
      type: number;
      data: { content: string; flags: number };
    };
  }
  const base = {
    id: "1",
    application_id: "app",
    token: "t",
    guild_id: "other",
    channel_id: "c",
  };

  it("refuses a registered command privately", async (t) => {
    const answer = await post(t, {
      ...base,
      type: 2,
      member: { user: { id: "member" }, roles: [] },
      data: {
        name: "제보",
        options: [{ name: "링크", value: "https://new.ai/" }],
      },
    });
    assert.equal(answer.type, 4);
    assert.equal(answer.data.flags, 64);
    assert.match(answer.data.content, /제보 기능이 꺼져/);
  });

  it("refuses a replayed button privately", async (t) => {
    const answer = await post(
      t,
      {
        ...base,
        type: 3,
        member: { user: { id: "member" }, roles: [] },
        data: { custom_id: "rapi_verify:v1" },
      },
      (commands) => async () => {
        await commands.assertGuildFeature("other", "server_config");
        return "인증했습니다";
      },
    );
    assert.equal(answer.type, 4);
    assert.equal(answer.data.flags, 64);
    assert.match(answer.data.content, /꺼져/);
  });

  it("carries the /기능 subcommand and its choice to the service", async (t) => {
    const answer = await post(t, {
      ...base,
      type: 2,
      member: { user: { id: "owner" }, roles: [] },
      data: {
        name: "기능",
        options: [
          {
            type: 1,
            name: "켜기",
            options: [{ name: "기능", value: "report" }],
          },
        ],
      },
    });
    assert.equal(answer.data.flags, 64);
    assert.match(answer.data.content, /제보 기능을 켰습니다/);
  });
});
