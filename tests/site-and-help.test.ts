import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DiscordCommands,
  helpCards,
  helpText,
  requiredCommandAccess,
  type SourceCollection,
} from "@rapi/application";
import { sitePages } from "../apps/bot/src/site-page.js";

const url = (path: string) => new URL(path, "http://rapi.local");
const pages = sitePages("123456789");

test("the intro page invites with only the permissions cards need", () => {
  const page = pages("GET", url("/"));
  assert.equal(page?.status, 200);
  assert.equal(page.type, "text/html");
  assert.ok(
    page.body.includes(
      "https://discord.com/oauth2/authorize?client_id=123456789&amp;scope=bot+applications.commands&amp;permissions=19456",
    ),
  );
  assert.match(page!.body, /href="\/privacy"/);
  assert.match(page!.body, /비공식 팬 봇/);
  assert.match(page!.body, /\/서버신청/);
});

test("the privacy page says what is kept and how it goes away", () => {
  const page = pages("GET", url("/privacy"));
  assert.equal(page?.status, 200);
  for (const text of [
    "암호화한 액세스 토큰",
    "서버의 일반 메시지를 읽지 않습니다",
    "/스타 끄기",
    "/연결 끊기",
    "최대 30일",
  ])
    assert.ok(page.body.includes(text), text);
});

test("the pages load nothing from elsewhere and run no script", () => {
  for (const path of ["/", "/privacy"]) {
    const { body } = pages("GET", url(path))!;
    assert.doesNotMatch(body, /<script|<img|<link|src=/i, path);
  }
});

test("other paths and methods are not the site's", () => {
  for (const path of ["/privacy/x", "/Privacy", "/stars", "/connect/github"])
    assert.equal(pages("GET", url(path)), null, path);
  for (const method of ["POST", "HEAD", "PUT"])
    for (const path of ["/", "/privacy"])
      assert.equal(pages(method, url(path)), null, `${method} ${path}`);
});

test("help lists the alert commands and links the site only when there is one", () => {
  const withSite = helpText("https://rapi.example");
  assert.match(withSite, /`\/ai-할인-알림 켜기`/);
  assert.ok(
    withSite.endsWith("\n\n소개와 개인정보 안내: https://rapi.example"),
  );
  assert.doesNotMatch(helpText(), /undefined|소개와 개인정보/);
});

test("the pinned card explains discount alerts and keeps star reminders", () => {
  const names = helpCards()[0]!.fields!.map((field) => field.name);
  assert.ok(names.includes("스타 알림"));
  assert.equal(names[names.indexOf("스타 알림") + 1], "AI 할인 알림");
});

test("any member of an approved server can read the help, whatever is switched off", async () => {
  assert.equal(requiredCommandAccess("help"), "user");
  const commands = new DiscordCommands(
    {} as SourceCollection,
    { userIds: [] },
    {
      status: async () => "",
      guildAllowlist: async () => ["guild"],
      guildFeatures: {
        enabled: async () => new Set(),
        set: async () => {},
      } as never,
      siteUrl: "https://rapi.example",
    },
  );
  const result = await commands.execute(
    { userId: "stranger", guildId: "guild", channelId: "c", roleIds: [] },
    { name: "help", options: {} },
  );
  assert.ok(result.messages.join("\n").includes("https://rapi.example"));
  await assert.rejects(
    commands.execute(
      { userId: "stranger", guildId: "elsewhere", channelId: "c", roleIds: [] },
      { name: "help", options: {} },
    ),
    /승인되지 않은 서버/,
  );
});
