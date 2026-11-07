import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DiscordCommandService,
  remindEveryone,
  starCommand,
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
  subscribedAt: Date;
  pausedAt: Date | null;
  pausedReason: string | null;
}

/** An in-memory service: each person's stars in their own scope. */
function fakeService(options: {
  subscribers?: Subscriber[];
  sendFails?: (userId: string) => Error | null;
  users?: string[];
}) {
  const subscribers = new Map(
    (options.subscribers ?? []).map((row) => [row.userId, { ...row }]),
  );
  const sent: Array<{ to: string; content?: string; embeds: number }> = [];
  const claimed = new Set<string>();
  const stars = new Map<string, StoredStar[]>();
  const read: string[] = [];
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
      saveStarSubscriber: async (userId, githubLogin) => {
        subscribers.set(userId, {
          userId,
          githubLogin,
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
      userExists: async (login) => (options.users ?? []).includes(login),
      readStars: async (login) => {
        read.push(login);
        return { stars: [star(`${login}/old`)], complete: true };
      },
    },
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
  return { service, subscribers, sent, read };
}

const subscriber = (
  userId: string,
  githubLogin: string,
  paused = false,
): Subscriber => ({
  userId,
  githubLogin,
  subscribedAt: new Date("2026-11-01T00:00:00Z"),
  pausedAt: paused ? new Date() : null,
  pausedReason: paused ? "DM을 받을 수 없음" : null,
});

test("connecting checks the login, sends a first DM and gives the page link", async () => {
  const { service, subscribers, sent } = fakeService({ users: ["octocat"] });
  const me = { userId: "100", guildId: "g" };
  assert.match(
    await starCommand(service, me, { action: "연결", login: "bad login!" }),
    /아이디를 확인/,
  );
  assert.match(
    await starCommand(service, me, { action: "연결", login: "ghost" }),
    /찾지 못했습니다/,
  );
  const reply = await starCommand(
    service,
    me,
    { action: "연결", login: "@octocat" },
    morning,
  );
  assert.match(reply, /octocat 연결했습니다/);
  assert.match(reply, /https:\/\/rapi\.example\/stars\?u=100&t=/);
  assert.equal(subscribers.get("100")?.githubLogin, "octocat");
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
  assert.match(await starCommand(service, me, { action: "끄기" }), /껐습니다/);
  assert.equal(subscribers.has("100"), false);
  assert.match(
    await starCommand(service, me, { action: "끄기" }),
    /받고 있지 않습니다/,
  );
  assert.match(await starCommand(service, me, { action: "관심사" }), /먼저/);
});

test("a closed DM pauses the person right when they connect", async () => {
  const { service, subscribers } = fakeService({
    users: ["octocat"],
    sendFails: () => new Error("Discord returned 403"),
  });
  const reply = await starCommand(
    service,
    { userId: "100", guildId: "g" },
    {
      action: "연결",
      login: "octocat",
    },
  );
  assert.match(reply, /DM을 보낼 수 없습니다/);
  assert.equal(subscribers.get("100")?.pausedReason, "DM을 받을 수 없음");
  assert.match(
    await starCommand(service, { userId: "100" }, { action: "보기" }),
    /멈춤: DM을 받을 수 없음/,
  );
});

test("every morning each connected person gets their own stars, a few digs a run", async () => {
  const { service, sent, read, subscribers } = fakeService({
    subscribers: [
      subscriber("1", "one"),
      subscriber("2", "two", true),
      subscriber("3", "three"),
      subscriber("4", "four"),
      subscriber("5", "five"),
      subscriber("6", "six"),
    ],
    sendFails: (userId) =>
      userId === "4" ? new Error("Discord returned 403") : null,
  });
  // Before nine nothing happens.
  assert.deepEqual(
    await remindEveryone(service, new Date("2026-11-07T23:00:00Z")),
    [],
  );
  const first = await remindEveryone(service, morning, () => 0);
  // The paused one is skipped; four are dug this run, the sixth waits.
  assert.deepEqual(read, ["one", "three", "four", "five"]);
  assert.deepEqual(
    sent.map((row) => row.to),
    ["1", "3", "5"],
  );
  assert.ok(sent.every((row) => row.embeds === 1));
  assert.deepEqual(first, ["4: send: Discord returned 403"]);
  assert.equal(subscribers.get("4")?.pausedReason, "DM을 받을 수 없음");
  await remindEveryone(service, morning, () => 0);
  assert.deepEqual(read.slice(4), ["six"]);
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
