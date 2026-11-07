import assert from "node:assert/strict";
import { test } from "node:test";
import {
  finishGitHubOAuth,
  githubAuthorizeUrl,
  revokeGitHubGrant,
} from "@rapi/adapters";
import {
  connectState,
  DiscordCommandService,
  finishStarConnect,
  remindEveryone,
  starCommand,
  stateOwner,
  type StarService,
} from "@rapi/agent";
import type { GitHubStar, StoredStar } from "@rapi/core";

const morning = new Date("2026-11-08T00:30:00Z");
const star = (fullName: string): GitHubStar => ({
  fullName,
  url: `https://github.com/${fullName}`,
  description: "words",
  language: null,
  stars: 10,
  archived: false,
  starredAt: "2024-01-01T00:00:00.000Z",
});

interface Subscriber {
  userId: string;
  githubLogin: string;
  githubToken: string | null;
  subscribedAt: Date;
  pausedAt: Date | null;
  pausedReason: string | null;
}

/** An in-memory service: each person's stars in their own scope. */
function fakeService(options: {
  subscribers?: Subscriber[];
  sendFails?: (userId: string) => Error | null;
  // Who GitHub says a code belongs to; a code not here is refused.
  codes?: Record<string, string>;
  readFails?: (login: string) => Error | null;
  owner?: string;
}) {
  const subscribers = new Map(
    (options.subscribers ?? []).map((row) => [row.userId, { ...row }]),
  );
  const sent: Array<{ to: string; content?: string; embeds: number }> = [];
  const claimed = new Set<string>();
  const stars = new Map<string, StoredStar[]>();
  const read: Array<[string, string | undefined]> = [];
  const revoked: string[] = [];
  const scope = (owner: string) => ({
    saveStars: async (list: readonly GitHubStar[]) => {
      stars.set(
        owner,
        list.map((row) => ({
          ...row,
          starredAt: new Date(row.starredAt),
          lastRemindedAt: null,
        })),
      );
    },
    currentStars: async () => stars.get(owner) ?? [],
    starReminderClaimed: async (day: string) => claimed.has(`${owner}:${day}`),
    claimStarReminder: async (day: string) => {
      if (claimed.has(`${owner}:${day}`)) return false;
      claimed.add(`${owner}:${day}`);
      return true;
    },
    releaseStarReminder: async (day: string) => {
      claimed.delete(`${owner}:${day}`);
    },
    saveStarReminderMessage: async () => {},
  });
  const service: StarService = {
    store: {
      starsOf: ((owner: string) => scope(owner)) as never,
      starSubscribers: async () => [...subscribers.values()],
      starSubscriber: async (userId) => subscribers.get(userId) ?? null,
      saveStarSubscriber: async (userId, githubLogin, githubToken) => {
        subscribers.set(userId, {
          userId,
          githubLogin,
          githubToken,
          subscribedAt: new Date(),
          pausedAt: null,
          pausedReason: null,
        });
      },
      pauseStarSubscriber: async (userId, reason) => {
        const row = subscribers.get(userId);
        if (row)
          Object.assign(row, { pausedAt: new Date(), pausedReason: reason });
      },
      removeStarSubscriber: async (userId) => subscribers.delete(userId),
    },
    delivery: {
      async send(target, payload) {
        const failure = options.sendFails?.(target.recipientId);
        if (failure) throw failure;
        sent.push({
          to: target.recipientId,
          ...(payload.discord?.content && { content: payload.discord.content }),
          embeds: payload.discord?.embeds.length ?? 0,
        });
        return { providerId: `m${sent.length}` };
      },
    },
    github: {
      readStars: async (login, token) => {
        read.push([login, token]);
        const failure = options.readFails?.(login);
        if (failure) throw failure;
        return { stars: [star(`${login}/old`)], complete: true };
      },
    },
    oauth: {
      authorizeUrl: (state) =>
        `https://github.com/login/oauth/authorize?state=${state}`,
      finish: async (code) => {
        const login = options.codes?.[code];
        if (!login) throw new Error("bad_verification_code");
        return { token: `gho_${login}`, login };
      },
      revoke: async (token) => {
        revoked.push(token);
      },
      encrypt: (token) => `sealed:${token}`,
      decrypt: (value) => value.replace(/^sealed:/, ""),
      secret: "s",
    },
    ...(options.owner && { owner: { userId: options.owner, token: "deploy" } }),
    site: {
      store: {
        starsOf: ((owner: string) => scope(owner)) as never,
        starSubscriber: async (userId) => subscribers.get(userId) ?? null,
      },
      secret: "s",
      baseUrl: "https://rapi.example",
    },
    reads: new Map(),
  };
  return { service, subscribers, sent, read, revoked };
}

const subscriber = (
  userId: string,
  githubLogin: string,
  paused = false,
  githubToken: string | null = `sealed:gho_${githubLogin}`,
): Subscriber => ({
  userId,
  githubLogin,
  githubToken,
  subscribedAt: new Date("2026-11-01T00:00:00Z"),
  pausedAt: paused ? new Date() : null,
  pausedReason: paused ? "DM을 받을 수 없음" : null,
});

const back = (fields: Record<string, string>) => new URLSearchParams(fields);

test("connecting goes through GitHub, which says whose account it is", async () => {
  const { service, subscribers, sent } = fakeService({
    codes: { good: "octocat" },
  });
  const me = { userId: "100", guildId: "g" };
  const reply = await starCommand(service, me, { action: "연결" }, morning);
  assert.match(reply, /공개 정보만 읽는 권한/);
  const state = new URL(/https:\/\/\S+/.exec(reply)![0]).searchParams.get(
    "state",
  )!;
  assert.equal(stateOwner(service.oauth!, state, morning), "100");
  // Someone else's id cannot be slipped into the state.
  const forged = state.replace(/^100\./, "200.");
  assert.equal(stateOwner(service.oauth!, forged, morning), null);
  assert.equal(
    stateOwner(
      service.oauth!,
      state,
      new Date(morning.getTime() + 16 * 60_000),
    ),
    null,
  );
  assert.deepEqual(
    await finishStarConnect(
      service,
      back({ state: forged, code: "good" }),
      morning,
    ),
    {
      ok: false,
      message:
        "연결 링크가 만료됐습니다. Discord에서 /스타 연결을 다시 해 주세요.",
    },
  );
  assert.equal(
    (
      await finishStarConnect(
        service,
        back({ state, error: "access_denied" }),
        morning,
      )
    ).message,
    "GitHub 연결을 취소했습니다.",
  );
  assert.equal(
    (await finishStarConnect(service, back({ state, code: "bad" }), morning))
      .ok,
    false,
  );
  assert.equal(subscribers.size, 0);
  const done = await finishStarConnect(
    service,
    back({ state, code: "good" }),
    morning,
  );
  assert.equal(done.ok, true);
  assert.match(done.message, /octocat 연결했습니다/);
  // The token is kept only sealed.
  assert.equal(subscribers.get("100")?.githubToken, "sealed:gho_octocat");
  assert.equal(sent[0]!.to, "100");
  assert.match(sent[0]!.content!, /octocat/);
  assert.match(
    await starCommand(service, me, {}),
    /octocat\*\* 스타 알림을 받고/,
  );
  assert.match(
    await starCommand(service, me, { action: "관심사" }),
    /stars\?u=100/,
  );
});

test("stopping takes the grant back from GitHub and forgets the person", async () => {
  const { service, subscribers, revoked } = fakeService({
    subscribers: [subscriber("100", "octocat")],
  });
  const me = { userId: "100", guildId: "g" };
  assert.match(
    await starCommand(service, me, { action: "끄기" }),
    /GitHub 토큰을 모두 지웠습니다/,
  );
  assert.deepEqual(revoked, ["gho_octocat"]);
  assert.equal(subscribers.has("100"), false);
  assert.match(
    await starCommand(service, me, { action: "끄기" }),
    /받고 있지 않습니다/,
  );
  assert.match(await starCommand(service, me, { action: "관심사" }), /먼저/);
});

test("without an OAuth app nobody can connect", async () => {
  const { service } = fakeService({});
  delete service.oauth;
  assert.match(
    await starCommand(
      service,
      { userId: "100", guildId: "g" },
      { action: "연결" },
    ),
    /설정되지 않았습니다/,
  );
  assert.equal(
    (await finishStarConnect(service, back({ state: "x", code: "y" }))).ok,
    false,
  );
});

test("a closed DM pauses the person right when they connect", async () => {
  const { service, subscribers } = fakeService({
    codes: { good: "octocat" },
    sendFails: () => new Error("Discord returned 403"),
  });
  const state = connectState(service.oauth!, "100", morning);
  const done = await finishStarConnect(
    service,
    back({ state, code: "good" }),
    morning,
  );
  assert.match(done.message, /DM을 보낼 수 없습니다/);
  assert.equal(subscribers.get("100")?.pausedReason, "DM을 받을 수 없음");
  assert.match(
    await starCommand(service, { userId: "100" }, { action: "보기" }),
    /멈춤: DM을 받을 수 없음/,
  );
});

test("every morning each connected person gets their own stars, a few digs a run", async () => {
  const { service, sent, read, subscribers } = fakeService({
    subscribers: [
      subscriber("1", "one", false, null),
      subscriber("2", "two", true),
      subscriber("3", "three"),
      subscriber("4", "four"),
      subscriber("5", "five"),
      subscriber("6", "six"),
      // No token and not the configured owner: never read with anyone else's.
      subscriber("7", "seven", false, null),
    ],
    owner: "1",
    sendFails: (userId) =>
      userId === "4" ? new Error("Discord returned 403") : null,
  });
  // Before nine nothing happens.
  assert.deepEqual(
    await remindEveryone(service, new Date("2026-11-07T23:00:00Z")),
    [],
  );
  const first = await remindEveryone(service, morning, () => 0);
  // The paused one is skipped; four are dug this run, the sixth waits. Each is
  // read with their own token, the owner with the deployment's.
  assert.deepEqual(read, [
    ["one", "deploy"],
    ["three", "gho_three"],
    ["four", "gho_four"],
    ["five", "gho_five"],
  ]);
  assert.deepEqual(
    sent.map((row) => row.to),
    ["1", "3", "5"],
  );
  assert.ok(sent.every((row) => row.embeds === 1));
  assert.deepEqual(first, [
    "4: send: Discord returned 403",
    "7: no GitHub token",
  ]);
  assert.equal(subscribers.get("4")?.pausedReason, "DM을 받을 수 없음");
  await remindEveryone(service, morning, () => 0);
  assert.deepEqual(read.slice(4), [["six", "gho_six"]]);
  assert.deepEqual(
    sent.map((row) => row.to),
    ["1", "3", "5", "6"],
  );
});

test("/스타 is any member's, in a server only", async () => {
  let got: unknown;
  const service = new DiscordCommandService(
    {} as never,
    { userIds: ["owner"], guildIds: ["g"] },
    {
      status: async () => "",
      stars: async (identity, options) => {
        got = [identity.userId, options.action];
        return "ok";
      },
    },
  );
  assert.deepEqual(
    (
      await service.execute(
        { userId: "100", guildId: "g", channelId: "c", roleIds: [] },
        { name: "stars", options: { action: "보기" } },
      )
    ).messages,
    ["ok"],
  );
  assert.deepEqual(got, ["100", "보기"]);
  await assert.rejects(
    service.execute(
      { userId: "100" },
      { name: "stars", options: { action: "보기" } },
    ),
    /서버에서 연결/,
  );
});

test("a token GitHub no longer takes pauses that person", async () => {
  const { service, subscribers } = fakeService({
    subscribers: [subscriber("3", "three")],
    readFails: () => new Error("Source returned 401"),
  });
  const failures = await remindEveryone(service, morning, () => 0);
  assert.ok(failures.some((failure) => /401/.test(failure)));
  assert.equal(subscribers.get("3")?.pausedReason, "GitHub 연결이 끊김");
});

test("the OAuth app asks GitHub for a token, whose it is, and takes it back", async () => {
  const app = {
    clientId: "Iv1.abcdef12",
    clientSecret: "x".repeat(40),
    redirectUri: "https://rapi.example/github/callback",
  };
  const url = new URL(githubAuthorizeUrl(app, "100.1.sig"));
  assert.equal(url.searchParams.get("client_id"), "Iv1.abcdef12");
  assert.equal(url.searchParams.get("state"), "100.1.sig");
  // No scope: public data only.
  assert.equal(url.searchParams.get("scope"), null);
  const calls: Array<{ url: string; method?: string; auth?: string }> = [];
  const fetch = (async (input: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url: input,
      ...(init?.method && { method: init.method }),
      ...(headers.Authorization && { auth: headers.Authorization }),
    });
    if (input.endsWith("/login/oauth/access_token"))
      return new Response(
        JSON.stringify(
          (JSON.parse(init?.body as string) as { code: string }).code === "good"
            ? { access_token: "gho_t" }
            : { error: "bad_verification_code" },
        ),
      );
    if (input.endsWith("/user"))
      return new Response(JSON.stringify({ login: "octocat" }));
    return new Response(null, { status: 204 });
  }) as typeof globalThis.fetch;
  assert.deepEqual(await finishGitHubOAuth(app, "good", { fetch }), {
    token: "gho_t",
    login: "octocat",
  });
  assert.equal(calls[1]!.auth, "Bearer gho_t");
  await assert.rejects(
    finishGitHubOAuth(app, "bad", { fetch }),
    /bad_verification_code/,
  );
  await revokeGitHubGrant(app, "gho_t", { fetch });
  const revoke = calls.at(-1)!;
  assert.equal(revoke.method, "DELETE");
  assert.match(revoke.url, /applications\/Iv1\.abcdef12\/grant$/);
  assert.match(revoke.auth!, /^Basic /);
});
