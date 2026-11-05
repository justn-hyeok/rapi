import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  DiscordCommandService,
  problemCardButton,
  receiveReport,
  reportableLink,
  sendProblemCards,
  type RapiAgent,
} from "@rapi/agent";
import { DiscordDeliveryAdapter } from "@rapi/adapters";
import type {
  NewReport,
  ProblemReportForCard,
  ReportOutcome,
} from "@rapi/core";
import { slashCommandDefinitions } from "../apps/bot/src/discord-http.js";

const MEMBER = { userId: "7", guildId: "g", channelId: "c", roleIds: [] };

function memoryStore(outcome: ReportOutcome = "saved") {
  const saved: NewReport[] = [];
  return {
    saved,
    async saveReport(report: NewReport) {
      saved.push(report);
      return outcome;
    },
  };
}

test("a link is cleaned to one form for the same page", () => {
  assert.deepEqual(
    reportableLink(
      " https://User:Pw@New.AI/deal/?b=2&utm_source=x&ref=me&a=1#top ",
    ),
    { url: "https://new.ai/deal?a=1&b=2", domain: "new.ai" },
  );
});

test("only a public https address is accepted", () => {
  for (const raw of [
    "not a link",
    "http://new.ai/",
    "ftp://new.ai/",
    "javascript:alert(1)",
    "https://localhost/",
    "https://127.0.0.1/",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/",
    "https://2130706433/",
    "https://new.ai:8443/",
    "https://svc.internal/",
    "https://rapi.tailnet.ts.net/",
    // The name after the @ is the host; stripping must not hide that.
    "https://new.ai@127.0.0.1/",
    `https://new.ai/${"x".repeat(600)}`,
  ])
    assert.equal(reportableLink(raw), null, raw);
});

test("a report keeps only the address, domain, reporter and clipped memo", async () => {
  const store = memoryStore();
  await receiveReport({ store, reviewChannelId: async () => "100" }, MEMBER, {
    link: "https://new.ai/deal",
    kind: "new_service",
    memo: ` 싸요\n${"가".repeat(300)} `,
  });
  const [report] = store.saved;
  assert.equal(report!.memo!.length, 200);
  assert.doesNotMatch(report!.memo!, /\n/);
  assert.deepEqual(
    { ...report!, memo: null },
    {
      kind: "new_service",
      url: "https://new.ai/deal",
      domain: "new.ai",
      reporterId: "7",
      memo: null,
    },
  );
});

test("the kind defaults to a discount and an unknown one is not trusted", async () => {
  const store = memoryStore();
  const input = { store, reviewChannelId: async () => "100" };
  const link = "https://new.ai/";
  await receiveReport(input, MEMBER, { link });
  await receiveReport(input, MEMBER, { link, kind: "red" });
  assert.deepEqual(
    store.saved.map((report) => [report.kind, report.memo]),
    [
      ["discount", null],
      ["discount", null],
    ],
  );
});

test("the link is never opened while answering", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => new Response());
  await receiveReport(
    { store: memoryStore(), reviewChannelId: async () => "100" },
    MEMBER,
    { link: "https://new.ai/" },
  );
  assert.equal(fetch.mock.callCount(), 0);
});

test("each answer is Korean and repeats nothing the reporter typed", async () => {
  const typed = { link: "https://new.ai/@everyone", memo: "@everyone 비밀" };
  const answers = await Promise.all(
    (
      [
        ["saved", "100", "받았습니다"],
        ["duplicate", "100", "이미 받은"],
        ["limited", "100", "시간당 5건"],
        ["saved", undefined, "검토 채널이 설정되지"],
      ] as const
    ).map(async ([outcome, channel, expected]) => {
      const answer = await receiveReport(
        { store: memoryStore(outcome), reviewChannelId: async () => channel },
        MEMBER,
        typed,
      );
      assert.match(answer, new RegExp(expected));
      return answer;
    }),
  );
  for (const answer of answers)
    assert.doesNotMatch(answer, /everyone|new\.ai|비밀/);
});

test("a problem report without a review channel is still stored", async () => {
  const store = memoryStore();
  const answer = await receiveReport(
    { store, reviewChannelId: async () => undefined },
    MEMBER,
    { link: "https://bad.ai/", kind: "problem" },
  );
  assert.equal(store.saved[0]!.kind, "problem");
  assert.match(answer, /저장했습니다/);
});

test("a database failure gets an answer, not an exception", async (t) => {
  t.mock.method(process.stderr, "write", () => true);
  const answer = await receiveReport(
    {
      store: {
        saveReport: async () => {
          throw new Error("database gone");
        },
      },
      reviewChannelId: async () => "100",
    },
    MEMBER,
    { link: "https://new.ai/" },
  );
  assert.match(answer, /저장하지 못했습니다/);
});

function service(
  t: TestContext,
  allowed: string[] = ["g"],
  allowlists: { userIds: string[]; channelIds?: string[] } = { userIds: ["1"] },
) {
  const report = t.mock.fn(async () => "받았습니다");
  return {
    report,
    commands: new DiscordCommandService({} as RapiAgent, allowlists, {
      status: async () => "ok",
      report,
      guildAllowlist: async () => allowed,
    }),
  };
}
const command = {
  name: "report",
  options: { link: "https://new.ai/", kind: "problem", memo: "m" },
} as const;

test("anyone in an allowed server can report, without any Rapi role", async (t) => {
  const { commands, report } = service(t);
  assert.deepEqual((await commands.execute(MEMBER, command)).messages, [
    "받았습니다",
  ]);
  assert.deepEqual(report.mock.calls[0]!.arguments, [
    MEMBER,
    { link: "https://new.ai/", kind: "problem", memo: "m" },
  ]);
  // The same person still cannot run the owner's commands.
  await assert.rejects(
    commands.execute(MEMBER, { name: "status", options: {} }),
    /not allowed/,
  );
});

test("a server that is not allowed, a DM or a closed channel cannot report", async (t) => {
  const { commands, report } = service(t, ["other"]);
  await assert.rejects(commands.execute(MEMBER, command), /승인되지 않은 서버/);
  const dm = service(t);
  await assert.rejects(
    dm.commands.execute({ userId: "7", channelId: "c" }, command),
    /서버에서만/,
  );
  const closed = service(t, ["g"], { userIds: ["1"], channelIds: ["open"] });
  await assert.rejects(closed.commands.execute(MEMBER, command), /channel/);
  assert.equal(report.mock.callCount(), 0);
  assert.equal(dm.report.mock.callCount(), 0);
  assert.equal(closed.report.mock.callCount(), 0);
});

test("the command takes a required link and two optional fields", () => {
  const definition = slashCommandDefinitions.find(
    (entry) => entry.name === "제보",
  )!;
  const options = (definition.options ?? []) as Array<{
    name: string;
    required: boolean;
    choices?: Array<{ name: string; value: string }>;
    max_length?: number;
  }>;
  assert.deepEqual(
    options.map((option) => [option.name, option.required]),
    [
      ["링크", true],
      ["종류", false],
      ["메모", false],
    ],
  );
  assert.deepEqual(
    options[1]!.choices!.map((choice) => [choice.name, choice.value]),
    [
      ["할인", "discount"],
      ["새 서비스", "new_service"],
      ["문제", "problem"],
    ],
  );
  assert.equal(options[2]!.max_length, 200);
});

const problem: ProblemReportForCard = {
  id: "11111111-1111-4111-8111-111111111111",
  url: "https://bad.ai/x",
  domain: "bad.ai",
  reporterId: "7",
  memo: "@everyone [여기](https://evil.ai) 먹튀",
};

function problemStore(rows: ProblemReportForCard[], cardedLastHour = 0) {
  const claimed: string[] = [];
  return {
    claimed,
    released: [] as string[],
    messages: [] as string[],
    async cardsInLastHour() {
      return cardedLastHour + claimed.length;
    },
    async problemReportsForCards() {
      return rows;
    },
    async claimProblemCard(id: string) {
      claimed.push(id);
      return true;
    },
    async releaseProblemCard(id: string) {
      this.released.push(id);
    },
    async saveProblemCardMessage(_id: string, messageId: string) {
      this.messages.push(messageId);
    },
  };
}

function discord(t: TestContext, answer = () => new Response('{"id":"900"}')) {
  const sent: Array<{
    url: string;
    embeds: Array<{
      title: string;
      url: string;
      description: string;
      color: number;
      author: { name: string };
    }>;
    components: Array<{
      components: Array<{ label: string; custom_id?: string; url?: string }>;
    }>;
    allowed_mentions: unknown;
  }> = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string, init?: RequestInit) => {
      sent.push({ ...JSON.parse(init!.body as string), url });
      return answer();
    },
  );
  return { sent, delivery: new DiscordDeliveryAdapter("token") };
}

test("a problem card names the domain, link and memo, safely, with two buttons", async (t) => {
  const store = problemStore([problem]);
  const { sent, delivery } = discord(t);
  assert.deepEqual(
    await sendProblemCards({ store, delivery, channelId: "100" }),
    [],
  );
  const [message] = sent;
  assert.equal(
    message!.url,
    "https://discord.com/api/v10/channels/100/messages",
  );
  assert.deepEqual(message!.allowed_mentions, { parse: [] });
  const [embed] = message!.embeds;
  assert.equal(embed!.author.name, "문제 제보");
  assert.equal(embed!.url, "https://bad.ai/x");
  assert.equal(embed!.title, "bad\\.ai");
  assert.match(embed!.description, /링크: bad\\\.ai\/x/);
  assert.match(embed!.description, /메모: \\@everyone \\\[여기\\\]/);
  assert.doesNotMatch(embed!.description, /https:\/\/|(?<!\\)@everyone/);
  assert.match(embed!.description, /<@7>/);
  assert.deepEqual(
    message!.components.flatMap((row) =>
      row.components.map((button) => [button.label, button.custom_id]),
    ),
    [
      ["원문 보기", undefined],
      ["빨강으로 정함", `problem_red:${problem.id}`],
      ["문제 없음", `problem_clear:${problem.id}`],
    ],
  );
  assert.deepEqual(store.messages, ["900"]);
});

test("problem cards share the channel's five an hour", async (t) => {
  const { sent, delivery } = discord(t);
  await sendProblemCards({
    store: problemStore([problem], 5),
    delivery,
    channelId: "100",
  });
  assert.equal(sent.length, 0);
  const second = { ...problem, id: "second" };
  await sendProblemCards({
    store: problemStore([problem, second], 4),
    delivery,
    channelId: "100",
  });
  assert.equal(sent.length, 1);
});

test("a refused problem card is released for the next run", async (t) => {
  const store = problemStore([problem]);
  const { delivery } = discord(t, () => new Response("", { status: 403 }));
  const failures = await sendProblemCards({
    store,
    delivery,
    channelId: "100",
  });
  assert.equal(failures.length, 1);
  assert.deepEqual(store.released, [problem.id]);
});

function reviewStore(
  decided: {
    turnedRed: number;
    alreadyPublished: number;
  } | null,
) {
  const calls: unknown[][] = [];
  return {
    calls,
    async decideProblemReport(...args: unknown[]) {
      calls.push(args);
      return (
        decided && { url: problem.url, domain: problem.domain, ...decided }
      );
    },
  };
}
const RED = `problem_red:${problem.id}`;
const CLEAR = `problem_clear:${problem.id}`;
const OWNER = { userId: "1", guildId: "g", channelId: "100" };

test("only the owner in the review channel can decide", async () => {
  const store = reviewStore({ turnedRed: 1, alreadyPublished: 0 });
  const input = {
    store,
    ownerIds: ["1"],
    reviewChannelIds: async () => ["100"],
  };
  const refused = async (
    review:
      | typeof input
      | {
          store: typeof store;
          ownerIds: string[];
          reviewChannelIds: () => Promise<string[]>;
        },
    identity: typeof OWNER,
    pattern: RegExp,
  ) => {
    const reply = (await problemCardButton(review, identity, RED)) as {
      type: number;
      data: { content: string; flags: number };
    };
    assert.equal(reply.type, 4);
    assert.equal(reply.data.flags, 64);
    assert.match(reply.data.content, pattern);
  };
  await refused(input, { ...OWNER, userId: "7" }, /소유자만/);
  await refused(input, { ...OWNER, channelId: "200" }, /검토 채널/);
  await refused(
    { ...input, reviewChannelIds: async () => [] },
    OWNER,
    /검토 채널/,
  );
  assert.deepEqual(store.calls, []);
});

test("[빨강으로 정함] records who decided and keeps only the link", async () => {
  const store = reviewStore({ turnedRed: 3, alreadyPublished: 1 });
  const reply = (await problemCardButton(
    { store, ownerIds: ["1"], reviewChannelIds: async () => ["100"] },
    OWNER,
    RED,
  )) as {
    type: number;
    data: {
      content: string;
      components: Array<{ components: Array<{ url?: string; label: string }> }>;
      allowed_mentions: unknown;
    };
  };
  assert.deepEqual(store.calls, [[problem.id, "red", "1"]]);
  assert.equal(reply.type, 7);
  assert.match(reply.data.content, /bad\.ai을 빨강으로/);
  assert.match(reply.data.content, /3건/);
  assert.match(reply.data.content, /이미 공개 채널에 나간 1건/);
  assert.deepEqual(reply.data.allowed_mentions, { parse: [] });
  assert.deepEqual(reply.data.components, [
    {
      type: 1,
      components: [{ type: 2, style: 5, label: "원문 보기", url: problem.url }],
    },
  ]);
});

test("[문제 없음] changes no band and a second press is refused", async () => {
  const store = reviewStore({ turnedRed: 0, alreadyPublished: 0 });
  const input = {
    store,
    ownerIds: ["1"],
    reviewChannelIds: async () => ["100"],
  };
  const reply = (await problemCardButton(input, OWNER, CLEAR)) as {
    data: { content: string };
  };
  assert.deepEqual(store.calls, [[problem.id, "no_problem", "1"]]);
  assert.match(reply.data.content, /문제 없음/);

  const again = (await problemCardButton(
    { ...input, store: reviewStore(null) },
    OWNER,
    CLEAR,
  )) as { type: number; data: { content: string } };
  assert.equal(again.type, 4);
  assert.match(again.data.content, /이미 처리한/);
});

test("a database failure on a press gets an answer", async (t) => {
  t.mock.method(process.stderr, "write", () => true);
  const reply = (await problemCardButton(
    {
      store: {
        decideProblemReport: async () => {
          throw new Error("database gone");
        },
      },
      ownerIds: ["1"],
      reviewChannelIds: async () => ["100"],
    },
    OWNER,
    RED,
  )) as { type: number; data: { content: string } };
  assert.equal(reply.type, 4);
  assert.match(reply.data.content, /다시 눌러/);
});
