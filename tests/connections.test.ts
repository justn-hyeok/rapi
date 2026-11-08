import assert from "node:assert/strict";
import { test } from "node:test";
import {
  connectCommand,
  connectionRefused,
  connectionToken,
  connectState,
  DiscordCommandService,
  disconnect,
  finishConnect,
  readConnectState,
  type ConnectionService,
} from "@rapi/agent";
import type { UserConnection } from "@rapi/domain";
import { connectPages } from "../apps/bot/src/connect-page.js";

const now = new Date("2026-11-08T00:30:00Z");
const back = (fields: Record<string, string>) => new URLSearchParams(fields);

function fakeConnections(
  options: { codes?: Record<string, string>; revokeFails?: boolean } = {},
) {
  const rows = new Map<string, UserConnection>();
  const revoked: string[] = [];
  const heard: string[] = [];
  const service: ConnectionService = {
    store: {
      connection: async (userId, provider) =>
        rows.get(`${userId}:${provider}`) ?? null,
      connections: async (userId) =>
        [...rows.values()].filter((row) => row.userId === userId),
      saveConnection: async (row) => {
        rows.set(`${row.userId}:${row.provider}`, { ...row, connectedAt: now });
      },
      removeConnection: async (userId, provider) =>
        rows.delete(`${userId}:${provider}`),
    },
    providers: {
      github: {
        authorizeUrl: (state) =>
          `https://github.com/login/oauth/authorize?state=${state}`,
        finish: async (code) => {
          const login = options.codes?.[code];
          if (!login) throw new Error("bad_verification_code");
          return {
            token: `gho_${login}`,
            accountId: `id-${login}`,
            accountName: login,
            scopes: "",
          };
        },
        revoke: async (token) => {
          if (options.revokeFails) throw new Error("GitHub returned 500");
          revoked.push(token);
        },
      },
    },
    box: {
      seal: (token) => `sealed:${token}`,
      open: (value) => {
        if (!value.startsWith("sealed:")) throw new Error("other key");
        return value.slice("sealed:".length);
      },
    },
    secret: "s",
    users: {
      github: {
        reader: {
          connected: async (connection, asked) => {
            heard.push(`connected ${connection.accountName} ${asked}`);
            return asked ? "읽기 시작합니다." : undefined;
          },
          disconnected: async (userId) => {
            heard.push(`disconnected ${userId}`);
          },
        },
      },
    },
  };
  return { service, rows, revoked, heard };
}

const stateOf = (reply: string) =>
  new URL(/https:\/\/\S+/.exec(reply)![0]).searchParams.get("state")!;

test("the state names one person, one service and one feature, signed, for fifteen minutes", () => {
  const state = connectState("s", "github", "100", "reader", now);
  assert.deepEqual(readConnectState("s", "github", state, now), {
    userId: "100",
    feature: "reader",
  });
  const [, , , expires, signature] = state.split(".");
  for (const forged of [
    `github.200.reader.${expires}.${signature}`,
    `github.100.other.${expires}.${signature}`,
    `github.100.reader.${Number(expires) + 600}.${signature}`,
    `${state}x`,
    "",
  ])
    assert.equal(readConnectState("s", "github", forged, now), null, forged);
  assert.equal(readConnectState("other", "github", state, now), null);
  assert.equal(
    readConnectState(
      "s",
      "github",
      state,
      new Date(now.getTime() + 16 * 60_000),
    ),
    null,
  );
});

test("/연결 추가 gives a link and coming back saves the token sealed", async () => {
  const { service, rows, heard } = fakeConnections({
    codes: { good: "octocat" },
  });
  const me = { userId: "100", guildId: "g" };
  const reply = await connectCommand(
    service,
    me,
    { action: "추가", 서비스: "github" },
    now,
  );
  assert.match(reply, /GitHub로 연결하기 \(15분 안에/);
  assert.match(reply, /공개 정보만 읽는 권한/);
  const state = stateOf(reply);
  assert.equal(
    (await finishConnect(service, "github", back({ state, code: "bad" }), now))
      .ok,
    false,
  );
  assert.equal(
    (
      await finishConnect(
        service,
        "github",
        back({ state, error: "access_denied" }),
        now,
      )
    ).message,
    "GitHub 연결을 취소했습니다.",
  );
  assert.equal(rows.size, 0);
  const done = await finishConnect(
    service,
    "github",
    back({ state, code: "good" }),
    now,
  );
  assert.equal(done.ok, true);
  assert.equal(
    done.message,
    "GitHub octocat 연결했습니다. 이 창은 닫아도 됩니다.",
  );
  assert.equal(rows.get("100:github")?.sealedToken, "sealed:gho_octocat");
  assert.deepEqual(heard, ["connected octocat false"]);
  assert.deepEqual(await connectionToken(service, "100", "github"), {
    token: "gho_octocat",
    accountName: "octocat",
  });
  assert.match(
    await connectCommand(service, me, { action: "보기" }),
    /GitHub \*\*octocat\*\* \(2026-11-08부터\)/,
  );
});

test("a link started from a feature tells that feature", async () => {
  const { service, heard } = fakeConnections({ codes: { good: "octocat" } });
  const state = connectState("s", "github", "100", "reader", now);
  const done = await finishConnect(
    service,
    "github",
    back({ state, code: "good" }),
    now,
  );
  assert.match(done.message, /읽기 시작합니다/);
  assert.deepEqual(heard, ["connected octocat true"]);
});

test("a state for another service, an unknown service or none configured is refused", async () => {
  const { service } = fakeConnections({ codes: { good: "octocat" } });
  const state = connectState("s", "github", "100", undefined, now);
  assert.equal(
    (await finishConnect(service, "gitlab", back({ state, code: "good" }), now))
      .ok,
    false,
  );
  assert.equal(
    (await finishConnect(undefined, "github", back({ state, code: "good" })))
      .ok,
    false,
  );
  assert.match(
    await connectCommand(
      { ...service, providers: {} },
      { userId: "100" },
      { action: "추가", 서비스: "github" },
    ),
    /설정되지 않았습니다/,
  );
  await assert.rejects(
    connectCommand(service, { userId: "100" }, { action: "추가", 서비스: "x" }),
    /지원하지 않는 서비스/,
  );
});

test("connecting another account takes the old grant back", async () => {
  const { service, rows, revoked } = fakeConnections({
    codes: { first: "octocat", second: "hubot" },
  });
  for (const code of ["first", "second"])
    await finishConnect(
      service,
      "github",
      back({
        state: connectState("s", "github", "100", undefined, now),
        code,
      }),
      now,
    );
  assert.deepEqual(revoked, ["gho_octocat"]);
  assert.equal(rows.get("100:github")?.accountName, "hubot");
});

test("/연결 끊기 takes the grant back, forgets the token and stops what used it", async () => {
  const { service, rows, revoked, heard } = fakeConnections({
    codes: { good: "octocat" },
  });
  await finishConnect(
    service,
    "github",
    back({
      state: connectState("s", "github", "100", undefined, now),
      code: "good",
    }),
    now,
  );
  assert.match(
    await connectCommand(
      service,
      { userId: "100" },
      { action: "끊기", 서비스: "github" },
    ),
    /octocat 연결을 끊고 토큰을 지웠습니다/,
  );
  assert.deepEqual(revoked, ["gho_octocat"]);
  assert.equal(rows.size, 0);
  assert.deepEqual(heard.at(-1), "disconnected 100");
  assert.match(
    await disconnect(service, "100", "github"),
    /연결돼 있지 않습니다/,
  );
  assert.match(
    await connectCommand(service, { userId: "100" }, { action: "보기" }),
    /연결한 서비스가 없습니다/,
  );
});

test("a grant that cannot be taken back is still forgotten here, and says so", async () => {
  const { service, rows } = fakeConnections({
    codes: { good: "octocat" },
    revokeFails: true,
  });
  await finishConnect(
    service,
    "github",
    back({
      state: connectState("s", "github", "100", undefined, now),
      code: "good",
    }),
    now,
  );
  assert.match(
    await disconnect(service, "100", "github"),
    /권한은 회수하지 못했습니다/,
  );
  assert.equal(rows.size, 0);
});

test("a token the provider refused is dropped, and one sealed under another key reads as none", async () => {
  const { service, rows, heard } = fakeConnections();
  await service.store.saveConnection({
    userId: "100",
    provider: "github",
    accountId: "1",
    accountName: "octocat",
    sealedToken: "v1.from-another-key",
    scopes: "",
  });
  assert.equal(await connectionToken(service, "100", "github"), null);
  await connectionRefused(service, "100", "github");
  assert.equal(rows.size, 0);
  assert.deepEqual(heard, ["disconnected 100"]);
});

test("/연결 is any member's, in a server only", async () => {
  let got: unknown;
  const commands = new DiscordCommandService(
    {} as never,
    { userIds: ["owner"], guildIds: ["g"] },
    {
      status: async () => "",
      connections: async (identity, options) => {
        got = [identity.userId, options.action];
        return "ok";
      },
    },
  );
  assert.deepEqual(
    (
      await commands.execute(
        { userId: "100", guildId: "g", channelId: "c", roleIds: [] },
        { name: "connections", options: { action: "보기" } },
      )
    ).messages,
    ["ok"],
  );
  assert.deepEqual(got, ["100", "보기"]);
  await assert.rejects(
    commands.execute(
      { userId: "100" },
      { name: "connections", options: { action: "보기" } },
    ),
    /서버에서 해 주세요/,
  );
});

test("the return page answers only GET /connect/<service>/callback", async () => {
  const { service } = fakeConnections({ codes: { good: "octocat" } });
  const pages = connectPages(service);
  const state = connectState("s", "github", "100", undefined, new Date());
  const url = new URL(
    `https://rapi.example/connect/github/callback?state=${state}&code=good`,
  );
  const ok = await pages("GET", url);
  assert.equal(ok?.status, 200);
  assert.match(ok!.body, /GitHub octocat 연결했습니다/);
  assert.equal((await pages("POST", url))?.status, 404);
  assert.equal(
    await pages("GET", new URL("https://rapi.example/github/callback")),
    null,
  );
  const missing = await pages(
    "GET",
    new URL("https://rapi.example/connect/gitlab/callback?state=x&code=y"),
  );
  assert.equal(missing?.status, 400);
  // What comes back from the provider is never put into the page unescaped.
  const odd = await pages(
    "GET",
    new URL(
      `https://rapi.example/connect/github/callback?state=${state}&error=<b>`,
    ),
  );
  assert.doesNotMatch(odd!.body, /<b>/);
});
