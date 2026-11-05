import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createNotificationChannels } from "@rapi/agent";

const OWNER = { userId: "1", guildId: "home" };
const ADMIN = { userId: "2", guildId: "other", guildPermissions: "32" };
const MEMBER = { userId: "3", guildId: "other", guildPermissions: "0" };

function setup(
  t: TestContext,
  fallback: { review?: string; public?: string } = {},
) {
  const rows: Array<{ guildId: string; kind: string; channelId: string }> = [];
  const sent: string[] = [];
  const delivery = {
    failing: false,
    async send(target: { recipientId: string }) {
      if (delivery.failing) throw new Error("403");
      sent.push(target.recipientId);
      return { providerId: "m" };
    },
  };
  const store = {
    guildChannels: async (guildId: string) =>
      rows.filter((row) => row.guildId === guildId),
    publicGuildChannels: async (kind: string) =>
      rows.filter((row) => row.kind === kind),
    setGuildChannel: t.mock.fn(
      async (guildId: string, kind: string, channelId: string) => {
        const at = rows.findIndex(
          (row) => row.guildId === guildId && row.kind === kind,
        );
        if (at >= 0) rows.splice(at, 1);
        rows.push({ guildId, kind, channelId });
      },
    ),
    clearGuildChannel: async (guildId: string, kind: string) => {
      const at = rows.findIndex(
        (row) => row.guildId === guildId && row.kind === kind,
      );
      if (at >= 0) rows.splice(at, 1);
    },
  };
  const channels = createNotificationChannels({
    store: store as never,
    delivery: delivery as never,
    ownerIds: ["1"],
    homeGuildId: "home",
    allowedGuilds: async () => ["home", "other"],
    reviewFallback: fallback.review,
    publicFallback: fallback.public,
  });
  return { channels, rows, sent, store, delivery };
}

const on = (kind: string, channel?: string) => ({
  action: "켜기",
  kind,
  ...(channel ? { channel } : {}),
});

test("another server's admin turns each alert on in its own channel", async (t) => {
  const { channels, sent } = setup(t);
  assert.match(
    await channels.change(ADMIN, on("discount", "20")),
    /AI 할인 알림을 <#20>/,
  );
  await channels.change(ADMIN, on("new_service", "21"));
  await channels.change(ADMIN, on("rapi_update", "22"));
  assert.deepEqual(sent, ["20", "21", "22"]);
  assert.deepEqual(await channels.publicChannels("discount"), ["20"]);
  assert.deepEqual(await channels.publicChannels("new_service"), ["21"]);
  assert.deepEqual(await channels.publicChannels("rapi_update"), ["22"]);
  assert.match(
    await channels.change(ADMIN, { action: "보기", kind: "discount" }),
    /<#20>/,
  );
  await channels.change(ADMIN, { action: "끄기", kind: "discount" });
  assert.deepEqual(await channels.publicChannels("discount"), []);
  assert.match(
    await channels.change(ADMIN, { action: "보기", kind: "discount" }),
    /채널이 없습니다/,
  );
});

test("without a channel it uses the one the command ran in", async (t) => {
  const { channels, rows } = setup(t);
  await channels.change({ ...ADMIN, channelId: "25" }, on("discount"));
  assert.equal(rows[0]!.channelId, "25");
});

test("a member without Manage Server changes nothing", async (t) => {
  const { channels, rows } = setup(t);
  await assert.rejects(
    channels.change(MEMBER, on("discount", "20")),
    /서버 관리 권한/,
  );
  assert.equal(rows.length, 0);
});

test("review alerts stay with the owner, at home", async (t) => {
  const { channels, rows } = setup(t);
  for (const identity of [ADMIN, { ...OWNER, guildId: "other" }])
    for (const action of [
      on("review_report", "20"),
      { action: "보기", kind: "review_report" },
    ])
      await assert.rejects(
        channels.change(identity, action),
        /소유자가 홈 서버/,
      );
  assert.equal(rows.length, 0);
  await channels.change(OWNER, on("review_report", "30"));
  assert.equal((await channels.review()).report, "30");
});

test("a channel the bot cannot post in is not saved", async (t) => {
  const { channels, delivery, rows } = setup(t);
  delivery.failing = true;
  assert.match(
    await channels.change(ADMIN, on("discount", "20")),
    /저장하지 않았습니다/,
  );
  assert.equal(rows.length, 0);
});

test("the environment values serve the home server until it sets its own, but never updates", async (t) => {
  const { channels } = setup(t, { review: "10", public: "11" });
  assert.deepEqual(await channels.review(), {
    discount: "10",
    newService: "10",
    report: "10",
    guildRequest: "10",
    ids: ["10"],
  });
  assert.deepEqual(await channels.publicChannels("discount"), ["11"]);
  assert.deepEqual(await channels.publicChannels("rapi_update"), []);

  await channels.change(OWNER, on("review_new_service", "30"));
  await channels.change(OWNER, on("discount", "31"));
  const review = await channels.review();
  assert.equal(review.newService, "30");
  assert.equal(review.discount, "10");
  // A card sent before the move can still be decided.
  assert.deepEqual(review.ids, ["10", "30"]);
  assert.deepEqual(await channels.publicChannels("discount"), ["31"]);
  assert.deepEqual(await channels.publicChannels("new_service"), ["11"]);
});

test("a server that is no longer allowed gets nothing, and its row cannot act as review", async (t) => {
  const { channels, rows } = setup(t);
  rows.push(
    { guildId: "blocked", kind: "discount", channelId: "40" },
    { guildId: "other", kind: "review_report", channelId: "41" },
  );
  assert.deepEqual(await channels.publicChannels("discount"), []);
  assert.equal((await channels.review()).report, undefined);
});
