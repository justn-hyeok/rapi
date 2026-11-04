import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  DiscordCommandService,
  receiveReport,
  reportableLink,
  type RapiAgent,
} from "@rapi/agent";
import type { NewReport, ReportOutcome } from "@rapi/core";
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
  await receiveReport({ store, reviewChannelId: "100" }, MEMBER, {
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
  const input = { store, reviewChannelId: "100" };
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
    { store: memoryStore(), reviewChannelId: "100" },
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
        { store: memoryStore(outcome), reviewChannelId: channel },
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
    { store, reviewChannelId: undefined },
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
      reviewChannelId: "100",
    },
    MEMBER,
    { link: "https://new.ai/" },
  );
  assert.match(answer, /저장하지 못했습니다/);
});

function service(
  t: TestContext,
  allowed: string[] | undefined = ["g"],
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
  await assert.rejects(commands.execute(MEMBER, command), /허용되지 않은 서버/);
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
