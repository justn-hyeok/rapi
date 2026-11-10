import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DiscordCommands,
  helpCards,
  helpPageUrl,
  helpText,
  interestPageOf,
  requiredCommandAccess,
  sendSuggestion,
  starInterestUrl,
  validHelpToken,
  type HelpSite,
  type SourceCollection,
} from "@rapi/application";
import { helpPages } from "../apps/bot/src/help-page.js";
import { sitePages } from "../apps/bot/src/site-page.js";

const url = (path: string) => new URL(path, "http://rapi.local");
const pages = sitePages("123456789");
const USER = "111222333444555666";
const NOW = new Date("2026-11-10T00:00:00Z");

function site(channel: string | undefined = "review") {
  const sent: Array<{ channelId: string; text: string }> = [];
  let failing = false;
  const value: HelpSite = {
    secret: "secret",
    baseUrl: "https://rapi.example/",
    reviewChannelId: async () => channel,
    delivery: {
      send: async (target, payload) => {
        if (failing) throw new Error("discord down");
        sent.push({ channelId: target.recipientId, text: payload.text });
        return { providerId: "m" };
      },
    },
    recent: new Map(),
  };
  return { value, sent, fail: (on: boolean) => (failing = on) };
}

function linkOf(value: HelpSite, userId = USER, now = NOW) {
  return new URL(helpPageUrl(value, userId, now));
}

const noBody = async () => Buffer.from("");
const bodyOf = (text: unknown) => async () =>
  Buffer.from(JSON.stringify({ text }));

test("the intro page invites with only the permissions cards need", () => {
  const page = pages("GET", url("/"))!;
  assert.equal(page.status, 200);
  assert.ok(
    page.body.includes(
      "https://discord.com/oauth2/authorize?client_id=123456789&amp;scope=bot+applications.commands&amp;permissions=19456",
    ),
  );
  assert.match(page.body, /href="\/help"/);
  assert.match(page.body, /href="\/privacy"/);
  assert.match(page.body, /비공식 팬 봇/);
});

test("the privacy page says what is kept, including suggestions", () => {
  const page = pages("GET", url("/privacy"))!;
  for (const text of [
    "암호화한 액세스 토큰",
    "서버의 일반 메시지를 읽지 않습니다",
    "/연결 끊기",
    "최대 30일",
    "건의: 보낸 사람의 Discord ID와 건의 내용",
  ])
    assert.ok(page.body.includes(text), text);
});

test("the site pages answer GET and HEAD and nothing else", () => {
  for (const method of ["GET", "HEAD"])
    for (const path of ["/", "/privacy"])
      assert.equal(pages(method, url(path))?.status, 200, `${method} ${path}`);
  for (const path of ["/privacy/x", "/Privacy", "/stars"])
    assert.equal(pages("GET", url(path)), null, path);
  for (const method of ["POST", "PUT"])
    assert.equal(pages(method, url("/")), null, method);
});

test("/도움말 is short and carries the one link", () => {
  const withLink = helpText("https://rapi.example/help?u=1&t=2");
  assert.match(
    withLink,
    /전체 명령어와 건의: <https:\/\/rapi\.example\/help\?u=1&t=2>/,
  );
  assert.ok(withLink.length < 400);
  assert.doesNotMatch(helpText(), /undefined|전체 명령어/);
});

test("the pinned card explains discount alerts and keeps star reminders", () => {
  const names = helpCards()[0]!.fields!.map((field) => field.name);
  assert.equal(names[names.indexOf("스타 알림") + 1], "AI 할인 알림");
});

test("any member of an approved server gets their own link", async () => {
  assert.equal(requiredCommandAccess("help"), "user");
  const { value } = site();
  const commands = new DiscordCommands(
    {} as SourceCollection,
    { userIds: [], guildMembersAreUsers: true },
    {
      status: async () => "",
      guildAllowlist: async () => ["guild"],
      guildFeatures: {
        enabled: async () => new Set(),
        set: async () => {},
      } as never,
      helpLink: (userId) => helpPageUrl(value, userId, NOW),
    },
  );
  const identity = { userId: USER, channelId: "c", roleIds: [] };
  const result = await commands.execute(
    { ...identity, guildId: "guild" },
    { name: "help", options: {} },
  );
  assert.ok(result.messages.join("\n").includes(`/help?u=${USER}&t=`));
  await assert.rejects(
    commands.execute(
      { ...identity, guildId: "elsewhere" },
      { name: "help", options: {} },
    ),
    /승인되지 않은 서버/,
  );
});

test("a link is only good for its person, until it expires", () => {
  const { value } = site();
  const link = linkOf(value);
  const token = link.searchParams.get("t");
  assert.ok(validHelpToken(value, USER, token, NOW));
  assert.equal(validHelpToken(value, "999", token, NOW), false);
  assert.equal(validHelpToken(value, USER, `${token}x`, NOW), false);
  assert.equal(validHelpToken(value, null, token, NOW), false);
  assert.equal(validHelpToken(value, USER, null, NOW), false);
  assert.equal(validHelpToken({ secret: "other" }, USER, token, NOW), false);
  const later = new Date(NOW.getTime() + 8 * 86_400_000);
  assert.equal(validHelpToken(value, USER, token, later), false);
});

test("a star link's token does not open the suggestion form", () => {
  const { value } = site();
  const star = interestPageOf(
    {
      store: { starsOf: () => ({}) },
      secret: value.secret,
      baseUrl: value.baseUrl,
    } as never,
    USER,
  )!;
  const token = new URL(starInterestUrl(star, NOW)).searchParams.get("t");
  assert.equal(validHelpToken(value, USER, token, NOW), false);
});

test("the page shows the commands to anyone and the form only with a valid link", async () => {
  const { value } = site();
  const open = await helpPages(value)("GET", url("/help"), noBody);
  assert.equal(open?.status, 200);
  assert.match(open!.body, /\/ai-할인-알림/);
  assert.match(open!.body, /\/스타 관심사/);
  assert.doesNotMatch(open!.body, /<textarea|<script/);

  const link = linkOf(value);
  const mine = await helpPages(value)(
    "GET",
    url(link.pathname + link.search),
    noBody,
  );
  assert.match(mine!.body, /<textarea/);
  assert.equal(mine!.body.includes(link.searchParams.get("t")!), false);

  const none = await helpPages(undefined)("GET", link, noBody);
  assert.doesNotMatch(none!.body, /<textarea/);
  assert.equal(
    await helpPages(undefined)("POST", url("/help/suggestions"), noBody),
    null,
  );
  assert.equal(await helpPages(value)("GET", url("/other"), noBody), null);
});

test("a suggestion reaches the review channel with its sender, escaped", async () => {
  const { value, sent } = site();
  const link = linkOf(value);
  const response = await helpPages(value)(
    "POST",
    url(`/help/suggestions${link.search}`),
    bodyOf("  @everyone <@123> **굵게**  "),
  );
  assert.equal(response?.status, 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.channelId, "review");
  assert.ok(sent[0]!.text.startsWith(`**건의** <@${USER}>\n`));
  assert.ok(sent[0]!.text.includes("\\@everyone"));
  assert.ok(sent[0]!.text.includes("\\<\\@123\\>"));
  assert.ok(sent[0]!.text.includes("\\*\\*굵게\\*\\*"));
});

test("bad requests are refused and nothing is sent", async () => {
  const { value, sent } = site();
  const link = linkOf(value);
  const post = (search: string, body: () => Promise<Buffer>) =>
    helpPages(value)("POST", url(`/help/suggestions${search}`), body);
  assert.equal((await post("", bodyOf("x")))?.status, 401);
  assert.equal(
    (await post(`?u=999&t=${link.searchParams.get("t")}`, bodyOf("x")))?.status,
    401,
  );
  assert.equal((await post(link.search, bodyOf("   ")))?.status, 400);
  assert.equal((await post(link.search, bodyOf(5)))?.status, 400);
  assert.equal(
    (await post(link.search, bodyOf("가".repeat(1001))))?.status,
    400,
  );
  assert.equal(
    (await post(link.search, async () => Buffer.from("{not json")))?.status,
    400,
  );
  assert.equal(sent.length, 0);
});

test("the hourly limit holds, also for concurrent sends", async () => {
  const { value, sent } = site();
  const results = await Promise.all(
    Array.from({ length: 8 }, () => sendSuggestion(value, USER, "건의", NOW)),
  );
  assert.equal(results.filter((r) => r === "sent").length, 5);
  assert.equal(results.filter((r) => r === "limited").length, 3);
  assert.equal(sent.length, 5);
  const later = new Date(NOW.getTime() + 3_600_001);
  assert.equal(await sendSuggestion(value, USER, "건의", later), "sent");
});

test("a failed send says so and does not use up the limit", async () => {
  const { value, sent, fail } = site();
  fail(true);
  for (let i = 0; i < 6; i++)
    assert.equal(await sendSuggestion(value, USER, "건의", NOW), "failed");
  fail(false);
  assert.equal(await sendSuggestion(value, USER, "건의", NOW), "sent");
  assert.equal(sent.length, 1);
});

test("without a review channel the person is told it could not go", async () => {
  const { value } = site("");
  assert.equal(await sendSuggestion(value, USER, "건의", NOW), "no_channel");
  const broken = {
    ...value,
    reviewChannelId: async () => {
      throw new Error("db down");
    },
  };
  assert.equal(await sendSuggestion(broken, USER, "건의", NOW), "failed");
});
