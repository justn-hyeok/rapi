import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { once } from "node:events";
import { describe, it, type TestContext } from "node:test";
import type { DiscordCommandService } from "@rapi/agent";
import {
  GUILD_CHECK_FAILED_MESSAGE,
  GUILD_NOT_ALLOWED_MESSAGE,
} from "@rapi/core";
import { createDiscordInteractionServer } from "../apps/bot/src/discord-http.js";

/** The real server with signed requests; every handler only counts its calls. */
async function setup(t: TestContext, allowed: () => Promise<string[]>) {
  const keys = generateKeyPairSync("ed25519");
  const called: string[] = [];
  const mark = (name: string) => async () => {
    called.push(name);
    return { type: 6 };
  };
  const server = createDiscordInteractionServer(
    {
      execute: async () => {
        called.push("command");
        return { messages: ["실행"] };
      },
    } as unknown as DiscordCommandService,
    (keys.publicKey.export({ type: "spki", format: "der" }) as Buffer)
      .subarray(-32)
      .toString("hex"),
    {
      guildGate: { allowed },
      discountCards: {
        button: mark("discount button"),
        publish: async () => {
          called.push("discount modal");
          return {};
        },
      },
      problemCards: { button: mark("problem button") },
      component: async () => {
        called.push("component");
        return "버튼";
      },
    },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert(address && typeof address === "object");
  return {
    called,
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
      return response.json() as Promise<{
        type: number;
        data?: { content?: string; flags?: number };
      }>;
    },
  };
}

const owner = {
  member: { user: { id: "owner" }, permissions: "8", roles: [] },
};
const button = (custom_id: string) => ({ type: 3, data: { custom_id } });
const interactions: Record<string, object> = {
  "[게시]": button("discount_publish:row"),
  "[버리기]": button("discount_discard:row"),
  "[빨강으로 정함]": button("problem_red:row"),
  "[문제 없음]": button("problem_clear:row"),
  "게시 확인 창": {
    type: 5,
    data: { custom_id: "discount_publish_modal:row" },
  },
  "인증 버튼": button("rapi_verify:v1"),
  "서버 구성 적용 버튼": button("server_config_apply:plan"),
  "/제보": { type: 2, data: { name: "제보" } },
  "/기능": { type: 2, data: { name: "기능" } },
  "/서버구성 적용": {
    type: 2,
    data: {
      name: "서버구성",
      options: [{ type: 1, name: "적용", options: [] }],
    },
  },
  "없는 명령": { type: 2, data: { name: "옛날명령" } },
};

describe("guild gate at the door", () => {
  for (const [name, interaction] of Object.entries(interactions))
    it(`refuses ${name} from another server, even for the owner`, async (t) => {
      const app = await setup(t, async () => ["home"]);
      const reply = await app.post({
        guild_id: "stranger",
        ...owner,
        ...interaction,
      });
      assert.deepEqual(reply, {
        type: 4,
        data: {
          content: GUILD_NOT_ALLOWED_MESSAGE,
          flags: 64,
          allowed_mentions: { parse: [] },
        },
      });
      assert.deepEqual(app.called, []);
    });

  it("refuses when the allowed guilds cannot be read", async (t) => {
    const app = await setup(t, async () => {
      throw new Error("database down");
    });
    const reply = await app.post({
      guild_id: "home",
      ...owner,
      ...interactions["/제보"]!,
    });
    assert.equal(reply.data?.content, GUILD_CHECK_FAILED_MESSAGE);
    assert.deepEqual(app.called, []);
  });

  it("lets an allowed server through to the handler", async (t) => {
    const app = await setup(t, async () => ["home"]);
    await app.post({
      guild_id: "home",
      ...owner,
      ...interactions["[게시]"]!,
    });
    assert.deepEqual(app.called, ["discount button"]);
  });

  it("answers Discord's ping, which comes from no server", async (t) => {
    const app = await setup(t, async () => []);
    assert.deepEqual(await app.post({ type: 1 }), { type: 1 });
  });

  it("leaves a DM to the handlers, which check the owner and the channel", async (t) => {
    const app = await setup(t, async () => []);
    await app.post({
      user: { id: "someone" },
      ...interactions["[게시]"]!,
    });
    assert.deepEqual(app.called, ["discount button"]);
  });
});
