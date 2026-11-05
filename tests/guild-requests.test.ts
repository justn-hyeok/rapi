import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { once } from "node:events";
import { describe, it, type TestContext } from "node:test";
import {
  changeGuild,
  DiscordCommandService,
  guildRequestButton,
  receiveGuildRequest,
  sendGuildRequestCards,
  type GuildRequests,
  type RapiAgent,
} from "@rapi/agent";
import {
  canManageGuild,
  cleanGuildText,
  createGuildGate,
  GUILD_NOT_ALLOWED_MESSAGE,
  guildRequestCard,
  isGuildAllowed,
  type DeliveryPayload,
} from "@rapi/core";
import {
  createDiscordInteractionServer,
  fetchGuildName,
} from "../apps/bot/src/discord-http.js";

const MANAGE_SERVER = "32";
const ADMINISTRATOR = "8";
const STRANGER = "900";
const REQUESTER = {
  userId: "u1",
  guildId: STRANGER,
  guildPermissions: MANAGE_SERVER,
};
const OWNER = { userId: "owner", guildId: "801", channelId: "review" };

interface Row {
  status: string;
  name: string | null;
  requesterId: string | null;
  reason: string | null;
  carded: boolean;
  wait: boolean;
}

/** The store's rules over a Map; the SQL itself is covered by tests/e2e. */
function fakeStore() {
  const rows = new Map<string, Row>();
  let sentThisHour = 0;
  return {
    rows,
    addSent: (count: number) => {
      sentThisHour += count;
    },
    allowedDiscordGuilds: async () =>
      [...rows]
        .filter(([, row]) => row.status === "allowed")
        .map(([guildId]) => ({ guildId, allowedAt: null })),
    openGuildRequest: async (input: {
      guildId: string;
      requesterId: string;
      reason: string | null;
    }) => {
      const row = rows.get(input.guildId);
      if (!row || (row.status === "rejected" && !row.wait)) {
        rows.set(input.guildId, {
          status: "pending",
          name: null,
          requesterId: input.requesterId,
          reason: input.reason,
          carded: false,
          wait: false,
        });
        return { status: "opened" as const, retryAt: null };
      }
      if (row.status === "rejected")
        return { status: "waiting" as const, retryAt: new Date(86_400_000) };
      return {
        status: row.status as "pending" | "allowed" | "blocked",
        retryAt: null,
      };
    },
    decideGuildRequest: async (guildId: string, status: string) => {
      const row = rows.get(guildId);
      if (row?.status !== "pending") return false;
      row.status = status;
      return true;
    },
    setGuildStatus: async (guildId: string, status: string) => {
      const row = rows.get(guildId);
      if (row) row.status = status;
      else
        rows.set(guildId, {
          status,
          name: null,
          requesterId: null,
          reason: null,
          carded: false,
          wait: false,
        });
    },
    liftGuildBlock: async (guildId: string) => {
      const row = rows.get(guildId);
      if (row?.status !== "blocked") return false;
      row.status = "rejected";
      row.wait = true;
      return true;
    },
    cardsInLastHour: async () => sentThisHour,
    guildRequestsForCards: async (limit: number) =>
      [...rows]
        .filter(([, row]) => row.status === "pending" && !row.carded)
        .slice(0, limit)
        .map(([guildId, row]) => ({
          guildId,
          name: row.name,
          requesterId: row.requesterId,
          reason: row.reason,
        })),
    claimGuildCard: async (guildId: string) => {
      const row = rows.get(guildId);
      if (!row || row.carded || row.status !== "pending") return false;
      row.carded = true;
      return true;
    },
    releaseGuildCard: async (guildId: string) => {
      rows.get(guildId)!.carded = false;
    },
    saveGuildCardMessage: async (
      guildId: string,
      _messageId: string,
      name: string | null,
    ) => {
      rows.get(guildId)!.name = name;
    },
  };
}

function setup(t: TestContext, reviewChannelId: string | undefined = "review") {
  const store = fakeStore();
  const gate = createGuildGate({
    envIds: ["800"],
    homeGuildId: "801",
    load: async () =>
      (await store.allowedDiscordGuilds()).map((guild) => guild.guildId),
    ttlMs: 60_000,
  });
  const commands = {
    register: t.mock.fn<(guildId: string) => Promise<void>>(async () => {}),
    clear: t.mock.fn<(guildId: string) => Promise<void>>(async () => {}),
  };
  const onOpened = t.mock.fn(() => {});
  const input = {
    store,
    gate,
    ownerIds: ["owner"],
    reviewChannelId: async () => reviewChannelId,
    reviewChannelIds: async () => (reviewChannelId ? [reviewChannelId] : []),
    configuredGuildIds: ["800", "801"],
    commands,
    onOpened,
  } as unknown as GuildRequests;
  const allowedNow = async () => isGuildAllowed(STRANGER, await gate.allowed());
  return { store, gate, commands, onOpened, input, allowedNow };
}

describe("/서버신청", () => {
  it("takes Manage Server or Administrator from the signed request", () => {
    assert.equal(canManageGuild(MANAGE_SERVER), true);
    assert.equal(canManageGuild(ADMINISTRATOR), true);
    assert.equal(canManageGuild(String(1n << 40n)), false);
    assert.equal(canManageGuild("0"), false);
    assert.equal(canManageGuild(undefined), false);
    assert.equal(canManageGuild("not a number"), false);
  });

  it("refuses a member without the permission and stores nothing", async (t) => {
    const { input, store, onOpened } = setup(t);
    for (const guildPermissions of ["0", undefined]) {
      const reply = await receiveGuildRequest(
        input,
        {
          userId: "u1",
          guildId: STRANGER,
          ...(guildPermissions ? { guildPermissions } : {}),
        },
        "r",
      );
      assert.match(reply, /서버 관리 권한/);
    }
    assert.equal(store.rows.size, 0);
    assert.equal(onOpened.mock.callCount(), 0);
  });

  it("does not make a request from a DM", async (t) => {
    const { input, store } = setup(t);
    assert.match(
      await receiveGuildRequest(
        input,
        { userId: "u1", guildPermissions: ADMINISTRATOR },
        undefined,
      ),
      /서버에서만/,
    );
    assert.equal(store.rows.size, 0);
  });

  it("stores the request once, clipped, and repeats nothing typed", async (t) => {
    const { input, store, onOpened } = setup(t);
    const long = `https://evil.example/${"가".repeat(300)}\n@everyone`;
    const reply = await receiveGuildRequest(input, REQUESTER, long);
    assert.match(reply, /승인 요청을 보냈습니다/);
    assert.doesNotMatch(reply, /evil/);
    const row = store.rows.get(STRANGER)!;
    assert.equal(row.requesterId, "u1");
    assert.equal(row.reason?.length, 100);
    assert.doesNotMatch(row.reason!, /https:\/\/|\n/);
    assert.equal(onOpened.mock.callCount(), 1);

    assert.match(
      await receiveGuildRequest(
        input,
        { ...REQUESTER, userId: "u2" },
        "다른 사유",
      ),
      /이미 승인 요청을 보냈습니다/,
    );
    assert.equal(onOpened.mock.callCount(), 1);
    assert.equal(store.rows.get(STRANGER)!.requesterId, "u1");
  });

  it("says so when the request has nowhere to go yet", async (t) => {
    const { input } = setup(t, undefined);
    Object.assign(input, {
      reviewChannelId: async () => undefined,
      reviewChannelIds: async () => [],
    });
    assert.match(
      await receiveGuildRequest(input, REQUESTER, undefined),
      /아직 라피 운영자에게 전달되지 않았습니다/,
    );
  });

  it("refuses a blocked guild and makes a lifted one wait", async (t) => {
    const { input, store, onOpened } = setup(t);
    await store.setGuildStatus(STRANGER, "blocked");
    assert.match(
      await receiveGuildRequest(input, REQUESTER, undefined),
      /차단/,
    );
    await changeGuild(input, "owner", "해제", STRANGER);
    assert.match(
      await receiveGuildRequest(input, REQUESTER, undefined),
      /<t:86400:D> 이후/,
    );
    assert.equal(onOpened.mock.callCount(), 0);
  });

  it("tells an allowed guild it needs nothing, without a row", async (t) => {
    const { input, store } = setup(t);
    assert.match(
      await receiveGuildRequest(
        input,
        { ...REQUESTER, guildId: "800" },
        undefined,
      ),
      /이미 승인된/,
    );
    assert.equal(store.rows.size, 0);
  });

  it("answers in Korean when the database fails", async (t) => {
    const { input, store } = setup(t);
    t.mock.method(process.stderr, "write", () => true);
    store.openGuildRequest = async () => {
      throw new Error("connection string leaked");
    };
    const reply = await receiveGuildRequest(input, REQUESTER, undefined);
    assert.match(reply, /처리하지 못했습니다/);
    assert.doesNotMatch(reply, /leaked/);
  });
});

describe("the owner's card", () => {
  const hostile = {
    guildId: STRANGER,
    name: "**굵게** @everyone <@1> [눌러](https://evil.example) discord.gg/abc",
    requesterId: "u1",
    reason: "`코드` ||가림|| https://evil.example <#1> # 제목",
  };

  it("cannot format, link or mention", () => {
    const card = guildRequestCard(hostile);
    const shown = card.fields!.map((field) => field.value);
    for (const value of [shown[0]!, shown[3]!]) {
      assert.doesNotMatch(value, /:\/\//);
      // Every character that means something to Discord is escaped.
      assert.doesNotMatch(value, /(?<!\\)[*`|<>@[\]()#]/);
      assert.doesNotMatch(value, /(?<!\\)\./);
    }
    assert.equal(shown[1], STRANGER);
    assert.equal(shown[2], "<@u1>");
  });

  it("says when the name could not be read, and keeps old rows readable", () => {
    const [name, id, ...rest] = guildRequestCard({
      guildId: STRANGER,
      name: null,
      requesterId: null,
      reason: null,
    }).fields!;
    assert.match(name!.value, /이름을 확인하지 못했습니다/);
    assert.equal(id!.value, STRANGER);
    assert.deepEqual(rest, []);
    assert.equal(cleanGuildText("  \n ", 10), null);
  });

  function delivery(t: TestContext) {
    const sent: DeliveryPayload[] = [];
    return {
      sent,
      send: t.mock.fn(
        async (...[, payload]: [unknown, DeliveryPayload, string?]) => {
          sent.push(payload);
          return { providerId: `m${sent.length}` };
        },
      ),
    };
  }

  it("sends one card with both buttons, mentions off and the name saved", async (t) => {
    const { store, input } = setup(t);
    await receiveGuildRequest(input, REQUESTER, hostile.reason);
    const out = delivery(t);
    const send = () =>
      sendGuildRequestCards({
        store: store as never,
        delivery: out,
        channelId: "review",
        guildName: async () => "테스트 서버",
      });
    assert.deepEqual(await send(), []);
    assert.deepEqual(await send(), []);
    assert.equal(out.sent.length, 1);
    const discord = out.sent[0]!.discord as {
      allowed_mentions: unknown;
      components: Array<{ components: Array<{ custom_id: string }> }>;
    };
    assert.deepEqual(discord.allowed_mentions, { parse: [] });
    assert.deepEqual(
      discord.components[0]!.components.map((button) => button.custom_id),
      [`guild_approve:${STRANGER}`, `guild_block:${STRANGER}`],
    );
    assert.equal(store.rows.get(STRANGER)!.name, "테스트 서버");
  });

  it("still sends when the name cannot be read", async (t) => {
    const { store, input } = setup(t);
    await receiveGuildRequest(input, REQUESTER, undefined);
    const out = delivery(t);
    await sendGuildRequestCards({
      store: store as never,
      delivery: out,
      channelId: "review",
      guildName: async () => null,
    });
    assert.equal(out.send.mock.callCount(), 1);
  });

  it("holds back what is over the channel's hourly limit", async (t) => {
    const { store, input } = setup(t);
    for (let guild = 1; guild <= 7; guild += 1)
      await receiveGuildRequest(
        input,
        { ...REQUESTER, guildId: String(guild) },
        undefined,
      );
    store.addSent(3);
    const out = delivery(t);
    await sendGuildRequestCards({
      store: store as never,
      delivery: out,
      channelId: "review",
      guildName: async () => null,
    });
    assert.equal(out.sent.length, 2);
    store.addSent(2);
    await sendGuildRequestCards({
      store: store as never,
      delivery: out,
      channelId: "review",
      guildName: async () => null,
    });
    assert.equal(out.sent.length, 2);
  });

  it("gives a refused send back for the next run", async (t) => {
    const { store, input } = setup(t);
    await receiveGuildRequest(input, REQUESTER, undefined);
    const failures = await sendGuildRequestCards({
      store: store as never,
      delivery: {
        send: async () => {
          throw new Error("Discord returned 403");
        },
      },
      channelId: "review",
      guildName: async () => null,
    });
    assert.equal(failures.length, 1);
    assert.equal(store.rows.get(STRANGER)!.carded, false);
  });
});

describe("the buttons", () => {
  const approve = `guild_approve:${STRANGER}`;
  const block = `guild_block:${STRANGER}`;

  it("let the guild in at once, after the gate has cached it out", async (t) => {
    const { input, store, commands, allowedNow } = setup(t);
    await receiveGuildRequest(input, REQUESTER, undefined);
    assert.equal(await allowedNow(), false);
    const result = await guildRequestButton(input, OWNER, approve);
    assert.match(result.edit!.content, /승인했습니다/);
    assert.deepEqual(result.edit!.components, []);
    assert.equal(store.rows.get(STRANGER)!.status, "allowed");
    assert.equal(await allowedNow(), true);
    assert.deepEqual(commands.register.mock.calls[0]!.arguments, [STRANGER]);
  });

  it("change nothing on a second click or a stale card", async (t) => {
    const { input, store, commands } = setup(t);
    await receiveGuildRequest(input, REQUESTER, undefined);
    await guildRequestButton(input, OWNER, approve);
    for (const customId of [approve, block]) {
      const again = await guildRequestButton(input, OWNER, customId);
      assert.match(again.notice!, /이미 처리한 요청/);
      assert.equal(again.edit, undefined);
    }
    assert.equal(store.rows.get(STRANGER)!.status, "allowed");
    assert.equal(commands.register.mock.callCount(), 1);
  });

  it("are checked on every click: who, and in which channel", async (t) => {
    const { input, store, commands } = setup(t);
    await receiveGuildRequest(input, REQUESTER, undefined);
    for (const [identity, refusal] of [
      [{ ...OWNER, userId: "someone" }, /소유자만/],
      [{ ...OWNER, channelId: "elsewhere" }, /검토 채널/],
      [{ userId: "owner" }, /검토 채널/],
    ] as const) {
      const result = await guildRequestButton(input, identity, approve);
      assert.match(result.notice!, refusal);
    }
    assert.match(
      (await guildRequestButton(input, OWNER, "guild_approve:../x")).notice!,
      /찾지 못했습니다/,
    );
    assert.equal(store.rows.get(STRANGER)!.status, "pending");
    assert.equal(commands.register.mock.callCount(), 0);
  });

  it("block keeps it out and registers nothing", async (t) => {
    const { input, store, commands, allowedNow } = setup(t);
    await receiveGuildRequest(input, REQUESTER, undefined);
    assert.match(
      (await guildRequestButton(input, OWNER, block)).edit!.content,
      /차단했습니다/,
    );
    assert.equal(store.rows.get(STRANGER)!.status, "blocked");
    assert.equal(await allowedNow(), false);
    assert.equal(commands.register.mock.callCount(), 0);
  });

  it("stay approved and say so when registering fails", async (t) => {
    const { input, commands, allowedNow } = setup(t);
    t.mock.method(process.stderr, "write", () => true);
    await receiveGuildRequest(input, REQUESTER, undefined);
    commands.register.mock.mockImplementation(async () => {
      throw new Error("Discord command registration failed: 403");
    });
    const result = await guildRequestButton(input, OWNER, approve);
    assert.match(result.edit!.content, /applications\.commands/);
    assert.equal(await allowedNow(), true);
  });
});

describe("/서버", () => {
  it("blocks an approved guild, drops it from the gate and clears its commands", async (t) => {
    const { input, store, commands, allowedNow } = setup(t);
    await store.setGuildStatus(STRANGER, "allowed");
    assert.equal(await allowedNow(), true);
    assert.match(
      await changeGuild(input, "owner", "차단", STRANGER),
      /차단했습니다/,
    );
    assert.equal(await allowedNow(), false);
    assert.deepEqual(commands.clear.mock.calls[0]!.arguments, [STRANGER]);
  });

  it("still blocks when the commands cannot be cleared", async (t) => {
    const { input, commands, allowedNow } = setup(t);
    t.mock.method(process.stderr, "write", () => true);
    commands.clear.mock.mockImplementation(async () => {
      throw new Error("Missing Access");
    });
    assert.match(
      await changeGuild(input, "owner", "차단", STRANGER),
      /명령은 지우지 못했지만/,
    );
    assert.equal(await allowedNow(), false);
  });

  it("approves without a request, and again to retry registering", async (t) => {
    const { input, commands, allowedNow } = setup(t);
    await changeGuild(input, "owner", "승인", STRANGER);
    await changeGuild(input, "owner", "승인", STRANGER);
    assert.equal(await allowedNow(), true);
    assert.equal(commands.register.mock.callCount(), 2);
  });

  it("lifting a block does not approve", async (t) => {
    const { input, store, allowedNow } = setup(t);
    assert.match(
      await changeGuild(input, "owner", "해제", STRANGER),
      /차단된 서버가 아닙니다/,
    );
    await store.setGuildStatus(STRANGER, "blocked");
    assert.match(
      await changeGuild(input, "owner", "해제", STRANGER),
      /차단을 풀었습니다/,
    );
    assert.equal(await allowedNow(), false);
  });

  it("cannot block what configuration allows, or take a bad id", async (t) => {
    const { input, store } = setup(t);
    for (const guild of ["801", "800"])
      assert.match(
        await changeGuild(input, "owner", "차단", guild),
        /설정 파일로 허용한 서버/,
      );
    assert.match(await changeGuild(input, "owner", "차단", "../evil"), /숫자/);
    assert.equal(store.rows.size, 0);
  });

  it("is for the owner only, whatever permission someone has", async (t) => {
    const changed = t.mock.fn(async () => "완료");
    const service = new DiscordCommandService(
      {} as RapiAgent,
      { userIds: ["owner"], homeGuildId: "801" },
      { status: async () => "ok", changeGuild: changed },
    );
    const command = {
      name: "guilds" as const,
      options: { action: "차단", target: STRANGER },
    };
    await assert.rejects(
      service.execute(
        { userId: "admin", guildId: "801", guildPermissions: ADMINISTRATOR },
        command,
      ),
      /소유자만/,
    );
    assert.equal(changed.mock.callCount(), 0);
    assert.deepEqual(
      (await service.execute({ userId: "owner", guildId: "801" }, command))
        .messages,
      ["완료"],
    );
  });
});

describe("through the interaction server", () => {
  async function server(t: TestContext) {
    const flow = setup(t);
    const keys = generateKeyPairSync("ed25519");
    const execute = t.mock.fn(async () => ({ messages: ["실행"] }));
    const http = createDiscordInteractionServer(
      { execute } as unknown as DiscordCommandService,
      (keys.publicKey.export({ type: "spki", format: "der" }) as Buffer)
        .subarray(-32)
        .toString("hex"),
      {
        guildGate: flow.gate,
        guildRequests: {
          request: (identity, reason) =>
            receiveGuildRequest(flow.input, identity, reason),
          button: (identity, customId) =>
            guildRequestButton(flow.input, identity, customId),
        },
      },
    );
    http.listen(0, "127.0.0.1");
    await once(http, "listening");
    t.after(() => new Promise<void>((resolve) => http.close(() => resolve())));
    const address = http.address();
    assert(address && typeof address === "object");
    const local = `http://127.0.0.1:${address.port}/interactions`;
    const realFetch = globalThis.fetch;
    const webhooks: Array<{ url: string; body: { content?: string } }> = [];
    let onWebhook = () => {};
    t.mock.method(
      globalThis,
      "fetch",
      async (url: string, init?: RequestInit) => {
        if (url === local) return realFetch(url, init);
        webhooks.push({
          url,
          body: JSON.parse(init!.body as string) as { content?: string },
        });
        onWebhook();
        return new Response(null, { status: 204 });
      },
    );
    return {
      ...flow,
      execute,
      webhooks,
      webhook: (count: number) =>
        new Promise<void>((resolve) => {
          const check = () => {
            if (webhooks.length >= count) resolve();
          };
          onWebhook = check;
          check();
        }),
      post: async (interaction: object) => {
        const body = Buffer.from(
          JSON.stringify({
            application_id: "app",
            token: "tok",
            channel_id: "review",
            ...interaction,
          }),
        );
        const timestamp = String(Math.floor(Date.now() / 1000));
        const response = await globalThis.fetch(local, {
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
        });
        return response.json() as Promise<{
          type: number;
          data?: { content?: string; flags?: number };
        }>;
      },
    };
  }

  const member = (permissions: string) => ({
    guild_id: STRANGER,
    member: { user: { id: "u1" }, permissions, roles: [] },
  });
  const request = {
    type: 2,
    data: {
      name: "서버신청",
      options: [{ name: "사유", type: 3, value: "써 보고 싶어요" }],
    },
  };
  const status = { type: 2, data: { name: "상태" } };
  const owner = {
    guild_id: "801",
    member: { user: { id: "owner" }, roles: [] },
  };

  it("requests, is refused, gets approved, then works; then gets blocked", async (t) => {
    const app = await server(t);

    assert.equal(
      (await app.post({ ...member(MANAGE_SERVER), ...status })).data?.content,
      GUILD_NOT_ALLOWED_MESSAGE,
    );
    const reply = await app.post({ ...member(MANAGE_SERVER), ...request });
    assert.equal(reply.type, 4);
    assert.equal(reply.data?.flags, 64);
    assert.match(reply.data!.content!, /승인 요청을 보냈습니다/);
    assert.equal(app.store.rows.get(STRANGER)!.reason, "써 보고 싶어요");
    assert.equal(
      (await app.post({ ...member(MANAGE_SERVER), ...status })).data?.content,
      GUILD_NOT_ALLOWED_MESSAGE,
    );

    // A stranger's server cannot press its way in, even with the real custom_id.
    const forged = await app.post({
      ...member(ADMINISTRATOR),
      type: 3,
      data: { custom_id: `guild_approve:${STRANGER}` },
    });
    assert.equal(forged.data?.content, GUILD_NOT_ALLOWED_MESSAGE);
    assert.equal(app.store.rows.get(STRANGER)!.status, "pending");

    assert.deepEqual(
      await app.post({
        ...owner,
        type: 3,
        data: { custom_id: `guild_approve:${STRANGER}` },
      }),
      { type: 6 },
    );
    await app.webhook(1);
    assert.match(
      app.webhooks[0]!.url,
      /webhooks\/app\/tok\/messages\/@original/,
    );
    assert.match(app.webhooks[0]!.body.content!, /승인했습니다/);

    await app.post({ ...member("0"), ...status });
    assert.equal(app.execute.mock.callCount(), 1);

    await changeGuild(app.input, "owner", "차단", STRANGER);
    assert.equal(
      (await app.post({ ...member(MANAGE_SERVER), ...status })).data?.content,
      GUILD_NOT_ALLOWED_MESSAGE,
    );
    assert.equal(app.execute.mock.callCount(), 1);
    assert.match(
      (await app.post({ ...member(MANAGE_SERVER), ...request })).data!.content!,
      /차단/,
    );
  });

  it("answers a refused click privately after the acknowledgement", async (t) => {
    const app = await server(t);
    await receiveGuildRequest(app.input, REQUESTER, undefined);
    await app.post({
      guild_id: "801",
      member: { user: { id: "someone" }, roles: [] },
      type: 3,
      data: { custom_id: `guild_block:${STRANGER}` },
    });
    await app.webhook(1);
    assert.deepEqual(app.webhooks[0]!.body, {
      content: "소유자만 쓸 수 있는 버튼입니다.",
      flags: 64,
      allowed_mentions: { parse: [] },
    });
    assert.equal(app.store.rows.get(STRANGER)!.status, "pending");
  });

  it("defers /서버, since registering can outlast Discord's wait", async (t) => {
    const app = await server(t);
    const reply = await app.post({
      ...owner,
      type: 2,
      data: {
        name: "서버",
        options: [
          {
            type: 1,
            name: "차단",
            options: [{ name: "서버", type: 3, value: STRANGER }],
          },
        ],
      },
    });
    assert.deepEqual(reply, { type: 5, data: { flags: 64 } });
    await app.webhook(1);
    assert.equal(app.webhooks[0]!.body.content, "실행");
    const [, command] = app.execute.mock.calls[0]!.arguments as unknown as [
      unknown,
      { name: string; options: { action: string; target: string } },
    ];
    assert.equal(command.name, "guilds");
    assert.equal(command.options.action, "차단");
    assert.equal(command.options.target, STRANGER);
  });

  it("does not store a request sent from a DM", async (t) => {
    const app = await server(t);
    const reply = await app.post({ user: { id: "u1" }, ...request });
    assert.match(reply.data!.content!, /서버에서만/);
    assert.equal(app.store.rows.size, 0);
  });
});

describe("the guild's name", () => {
  it("comes from Discord, and nothing when the bot is not there", async (t) => {
    const statuses = [200, 403];
    t.mock.method(globalThis, "fetch", async () => {
      const status = statuses.shift()!;
      return new Response(
        status === 200 ? JSON.stringify({ name: "시험" }) : "{}",
        { status },
      );
    });
    assert.equal(await fetchGuildName("token", STRANGER), "시험");
    assert.equal(await fetchGuildName("token", STRANGER), null);
  });

  it("is nothing when Discord cannot be reached", async (t) => {
    t.mock.method(globalThis, "fetch", async () => {
      throw new Error("network down");
    });
    assert.equal(await fetchGuildName("token", STRANGER), null);
  });
});
