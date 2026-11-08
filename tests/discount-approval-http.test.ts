import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { once } from "node:events";
import { test, type TestContext } from "node:test";
import type {
  DiscordCommandService,
  DiscountPublishResult,
} from "@rapi/application";
import { createDiscordInteractionServer } from "../apps/bot/src/discord-http.js";

const PUBLISH = "discount_publish:row";
const MODAL = "discount_publish_modal:row";

/** The server with signed requests, and everything it sends back to Discord. */
async function setup(
  t: TestContext,
  publish: () => Promise<DiscountPublishResult>,
  answer: () => Response = () => new Response(null, { status: 204 }),
) {
  const keys = generateKeyPairSync("ed25519");
  const key = (keys.publicKey.export({ type: "spki", format: "der" }) as Buffer)
    .subarray(-32)
    .toString("hex");
  const calls: Array<{
    identity: unknown;
    customId: string;
    deadline?: string;
  }> = [];
  const server = createDiscordInteractionServer(
    {} as unknown as DiscordCommandService,
    key,
    {
      discountCards: {
        button: async (identity, customId) => {
          calls.push({ identity, customId });
          return { type: 9, data: { custom_id: MODAL } };
        },
        publish: async (identity, customId, deadline) => {
          calls.push({ identity, customId, deadline });
          return publish();
        },
      },
      problemCards: {
        button: async (identity, customId) => {
          calls.push({ identity, customId });
          return { type: 7, data: { content: "decided" } };
        },
      },
      component: async () => "other",
    },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert(address && typeof address === "object");
  const local = `http://127.0.0.1:${address.port}/interactions`;

  const realFetch = globalThis.fetch;
  const delivered: Array<{ url: string; method: string; body: unknown }> = [];
  let onDelivered = () => {};
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string, init?: RequestInit) => {
      if (url === local) return realFetch(url, init);
      delivered.push({
        url,
        method: init!.method!,
        body: JSON.parse(init!.body as string) as unknown,
      });
      onDelivered();
      return answer();
    },
  );

  return {
    calls,
    delivered,
    deliveries: (count: number) =>
      new Promise<void>((resolve) => {
        const check = () => {
          if (delivered.length >= count) resolve();
        };
        onDelivered = check;
        check();
      }),
    post: async (interaction: object) => {
      const body = Buffer.from(
        JSON.stringify({
          application_id: "app",
          token: "tok",
          guild_id: "g",
          channel_id: "100",
          member: { user: { id: "1" }, roles: [] },
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
      return {
        status: response.status,
        body: (await response.json()) as unknown,
      };
    },
  };
}

const modalSubmit = (value: string) => ({
  type: 5,
  data: {
    custom_id: MODAL,
    components: [
      { type: 1, components: [{ type: 4, custom_id: "deadline", value }] },
    ],
  },
});

test("a button's reply goes straight back, with the signed user and channel", async (t) => {
  const app = await setup(t, async () => ({}));
  const reply = await app.post({ type: 3, data: { custom_id: PUBLISH } });
  assert.deepEqual(reply, {
    status: 200,
    body: { type: 9, data: { custom_id: MODAL } },
  });
  assert.deepEqual(app.calls, [
    {
      identity: { userId: "1", guildId: "g", channelId: "100", roleIds: [] },
      customId: PUBLISH,
    },
  ]);
});

test("a DM click carries the user id too", async (t) => {
  const app = await setup(t, async () => ({}));
  await app.post({
    type: 3,
    member: undefined,
    guild_id: undefined,
    user: { id: "2" },
    data: { custom_id: PUBLISH },
  });
  assert.deepEqual(app.calls[0]!.identity, { userId: "2", channelId: "100" });
});

test("a modal is acknowledged before the slow send, then edits the card", async (t) => {
  let finish!: (result: DiscountPublishResult) => void;
  const app = await setup(
    t,
    () => new Promise((resolve) => (finish = resolve)),
  );
  const reply = await app.post(modalSubmit("2026-12-31"));
  assert.deepEqual(reply, { status: 200, body: { type: 6 } });
  assert.equal(app.delivered.length, 0);
  assert.equal(app.calls[0]!.deadline, "2026-12-31");

  finish({ edit: { content: "게시했습니다.", components: [] } });
  await app.deliveries(1);
  assert.deepEqual(app.delivered, [
    {
      url: "https://discord.com/api/v10/webhooks/app/tok/messages/@original",
      method: "PATCH",
      body: {
        content: "게시했습니다.",
        components: [],
        allowed_mentions: { parse: [] },
      },
    },
  ]);
});

test("a refusal after the acknowledgement is ephemeral and leaves the card alone", async (t) => {
  const app = await setup(t, async () => ({ notice: "소유자만" }));
  await app.post(modalSubmit(""));
  await app.deliveries(1);
  assert.deepEqual(app.delivered, [
    {
      url: "https://discord.com/api/v10/webhooks/app/tok",
      method: "POST",
      body: {
        content: "소유자만",
        flags: 64,
        allowed_mentions: { parse: [] },
      },
    },
  ]);
});

test("an uncertain send both edits the card and tells the owner", async (t) => {
  const app = await setup(t, async () => ({
    edit: { content: "알 수 없음", components: [] },
    notice: "확인해 주세요",
  }));
  await app.post(modalSubmit(""));
  await app.deliveries(2);
  assert.deepEqual(app.delivered.map((call) => call.method).sort(), [
    "PATCH",
    "POST",
  ]);
});

test("a failed edit does not lose the notice or take the server down", async (t) => {
  const app = await setup(
    t,
    async () => ({
      edit: { content: "x", components: [] },
      notice: "확인해 주세요",
    }),
    () => new Response(null, { status: 500 }),
  );
  t.mock.method(process.stderr, "write", () => true);
  await app.post(modalSubmit(""));
  await app.deliveries(2);
  assert.deepEqual(app.delivered.map((call) => call.method).sort(), [
    "PATCH",
    "POST",
  ]);
  assert.equal(
    (await app.post({ type: 3, data: { custom_id: PUBLISH } })).status,
    200,
  );
});

test("other buttons still go to their own handler", async (t) => {
  const app = await setup(t, async () => ({}));
  const reply = await app.post({
    type: 3,
    data: { custom_id: "rapi_verify:v1" },
  });
  assert.deepEqual(reply.body, {
    type: 4,
    data: { content: "other", flags: 64 },
  });
  assert.equal(app.calls.length, 0);
});

test("/제보 is answered privately with its options, and with mentions off", async (t) => {
  const keys = generateKeyPairSync("ed25519");
  const seen: unknown[] = [];
  const service = {
    execute: async (identity: unknown, command: { options: object }) => {
      seen.push(identity, command.options);
      return { messages: ["제보를 받았습니다."] };
    },
  } as unknown as DiscordCommandService;
  const server = createDiscordInteractionServer(
    service,
    (keys.publicKey.export({ type: "spki", format: "der" }) as Buffer)
      .subarray(-32)
      .toString("hex"),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert(address && typeof address === "object");
  const body = Buffer.from(
    JSON.stringify({
      type: 2,
      guild_id: "g",
      channel_id: "100",
      member: { user: { id: "7" }, roles: [] },
      data: {
        name: "제보",
        options: [
          { name: "링크", type: 3, value: "https://new.ai/" },
          { name: "종류", type: 3, value: "problem" },
          { name: "메모", type: 3, value: "m" },
        ],
      },
    }),
  );
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
  assert.deepEqual(await response.json(), {
    type: 4,
    data: {
      content: "제보를 받았습니다.",
      flags: 64,
      allowed_mentions: { parse: [] },
    },
  });
  assert.deepEqual(seen[0], {
    userId: "7",
    guildId: "g",
    channelId: "100",
    roleIds: [],
  });
  assert.deepEqual(
    {
      link: (seen[1] as { link: unknown }).link,
      kind: (seen[1] as { kind: unknown }).kind,
      memo: (seen[1] as { memo: unknown }).memo,
    },
    { link: "https://new.ai/", kind: "problem", memo: "m" },
  );
});

test("a problem card's buttons go to their own handler with the signed user", async (t) => {
  const app = await setup(t, async () => ({}));
  for (const customId of ["problem_red:row", "problem_clear:row"]) {
    const reply = await app.post({ type: 3, data: { custom_id: customId } });
    assert.deepEqual(reply, {
      status: 200,
      body: { type: 7, data: { content: "decided" } },
    });
  }
  assert.deepEqual(app.calls, [
    {
      identity: { userId: "1", guildId: "g", channelId: "100", roleIds: [] },
      customId: "problem_red:row",
    },
    {
      identity: { userId: "1", guildId: "g", channelId: "100", roleIds: [] },
      customId: "problem_clear:row",
    },
  ]);
});
