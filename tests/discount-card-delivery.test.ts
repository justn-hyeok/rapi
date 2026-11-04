import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { DiscordDeliveryAdapter } from "@rapi/adapters";
import { sendDiscountCards } from "@rapi/agent";
import type { CandidateForCard } from "@rapi/core";

const row = (id: string, fields: Partial<CandidateForCard> = {}) => ({
  id,
  kind: "discount" as const,
  route: "changelog" as const,
  domain: "x.test",
  title: `Offer ${id} is 50% off`,
  url: `https://x.test/${id}`,
  evidence: "50% off",
  band: "green" as const,
  tags: [],
  operator: null,
  priceCheck: "below_list" as const,
  termsNote: null,
  ...fields,
});

/** The queries' behavior, on rows newest first. */
function memoryStore(rows: CandidateForCard[], cardedLastHour = 0) {
  const claimed = new Set<string>();
  const messages = new Map<string, string>();
  const released: string[] = [];
  return {
    claimed,
    messages,
    released,
    failSave: false,
    async cardsInLastHour() {
      return cardedLastHour + claimed.size;
    },
    async candidatesForCards() {
      return rows.filter((candidate) => !claimed.has(candidate.id));
    },
    async claimCandidateCard(id: string) {
      if (claimed.has(id)) return false;
      claimed.add(id);
      return true;
    },
    async releaseCandidateCard(id: string) {
      claimed.delete(id);
      released.push(id);
    },
    async saveCandidateCardMessage(id: string, messageId: string) {
      if (this.failSave) throw new Error("database gone");
      messages.set(id, messageId);
    },
  };
}

interface Sent {
  channel: string;
  embeds: Array<{ url: string; color: number; description: string }>;
  components: Array<{
    components: Array<{
      style: number;
      label: string;
      url?: string;
      custom_id?: string;
    }>;
  }>;
  allowed_mentions: unknown;
}

/** The real adapter with Discord answered by `answer`, given the card's url path. */
function discordAnswering(t: TestContext, answer?: (id: string) => Response) {
  const sent: Sent[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string) as Sent;
      const id = body.embeds[0]!.url.split("/").pop()!;
      const response = answer?.(id);
      if (response && !response.ok) return response;
      sent.push({ ...body, channel: url });
      return response ?? new Response(JSON.stringify({ id: `message-${id}` }));
    },
  );
  return {
    sent,
    delivery: new DiscordDeliveryAdapter("token"),
    ids: () => sent.map((message) => message.embeds[0]!.url.split("/").pop()),
  };
}

const CHANNEL = "123";

test("each card is one message with a button, and mentions stay off", async (t) => {
  const store = memoryStore([row("a")]);
  const discord = discordAnswering(t);
  assert.deepEqual(
    await sendDiscountCards({ ...discord, store, channelId: CHANNEL }),
    [],
  );
  const [message] = discord.sent;
  assert.equal(discord.sent.length, 1);
  assert.equal(
    message!.channel,
    "https://discord.com/api/v10/channels/123/messages",
  );
  assert.equal(message!.embeds.length, 1);
  assert.deepEqual(message!.allowed_mentions, { parse: [] });
  assert.deepEqual(message!.components[0]!.components[0], {
    type: 2,
    style: 5,
    label: "원문 보기",
    url: "https://x.test/a",
  });
  assert.deepEqual(
    message!.components[1]!.components.map((button) => [
      button.label,
      button.custom_id,
    ]),
    [
      ["게시", "discount_publish:a"],
      ["버리기", "discount_discard:a"],
    ],
  );
  assert.equal(store.messages.get("a"), "message-a");
});

test("five go out in an hour, newest first, and the rest wait", async (t) => {
  const rows = ["a", "b", "c", "d", "e", "f", "g"].map((id) => row(id));
  const store = memoryStore(rows);
  const discord = discordAnswering(t);
  await sendDiscountCards({ ...discord, store, channelId: CHANNEL });
  assert.deepEqual(discord.ids(), ["a", "b", "c", "d", "e"]);
  // A restart in the same hour sends nothing more, and nothing twice.
  await sendDiscountCards({ ...discord, store, channelId: CHANNEL });
  assert.equal(discord.sent.length, 5);

  // Next hour: the same rows are carded but no longer count.
  const nextHour = memoryStore(rows.slice(5));
  await sendDiscountCards({ ...discord, store: nextHour, channelId: CHANNEL });
  assert.deepEqual(discord.ids().slice(5), ["f", "g"]);
});

test("cards already sent this hour count against the limit", async (t) => {
  const store = memoryStore(
    ["a", "b", "c"].map((id) => row(id)),
    4,
  );
  const discord = discordAnswering(t);
  await sendDiscountCards({ ...discord, store, channelId: CHANNEL });
  assert.deepEqual(discord.ids(), ["a"]);

  const full = memoryStore([row("z")], 5);
  await sendDiscountCards({ ...discord, store: full, channelId: CHANNEL });
  assert.equal(discord.sent.length, 1);
});

test("noise and red rows are skipped without using up the hour", async (t) => {
  const store = memoryStore([
    row("noise", {
      title: "Updates to Hobby and Pro Terms of Service",
      evidence: "through December 1, 2026",
      priceCheck: "unknown",
    }),
    row("red", { band: "red" }),
    row("a"),
  ]);
  const discord = discordAnswering(t);
  await sendDiscountCards({ ...discord, store, channelId: CHANNEL });
  assert.deepEqual(discord.ids(), ["a"]);
  assert.deepEqual([...store.claimed], ["a"]);
});

test("a refused send does not stop the rest and is tried again later", async (t) => {
  const store = memoryStore(["a", "b"].map((id) => row(id)));
  let refuse = true;
  const discord = discordAnswering(t, (id) =>
    refuse && id === "a"
      ? new Response("", { status: 403 })
      : new Response(JSON.stringify({ id: `message-${id}` })),
  );
  const failures = await sendDiscountCards({
    ...discord,
    store,
    channelId: CHANNEL,
  });
  assert.deepEqual(failures, ["a: Discord returned 403"]);
  assert.deepEqual(discord.ids(), ["b"]);
  assert.deepEqual(store.released, ["a"]);

  refuse = false;
  await sendDiscountCards({ ...discord, store, channelId: CHANNEL });
  assert.deepEqual(discord.ids(), ["b", "a"]);
});

test("a 429 stops the run and everything stays for the next one", async (t) => {
  const store = memoryStore(["a", "b", "c"].map((id) => row(id)));
  const discord = discordAnswering(t, (id) =>
    id === "b"
      ? new Response("{}", { status: 429 })
      : new Response(JSON.stringify({ id: `message-${id}` })),
  );
  const failures = await sendDiscountCards({
    ...discord,
    store,
    channelId: CHANNEL,
  });
  assert.deepEqual(failures, ["b: Discord returned 429"]);
  assert.deepEqual(discord.ids(), ["a"]);
  assert.deepEqual(store.released, ["b"]);
  assert.deepEqual([...store.claimed], ["a"]);
});

test("a send with an unknown outcome is never sent again", async (t) => {
  const store = memoryStore(["a", "b"].map((id) => row(id)));
  let attempts = 0;
  t.mock.method(globalThis, "fetch", async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("timed out");
    return new Response(JSON.stringify({ id: "message" }));
  });
  const delivery = new DiscordDeliveryAdapter("token");
  const failures = await sendDiscountCards({
    delivery,
    store,
    channelId: CHANNEL,
  });
  assert.equal(failures.length, 1);
  assert.deepEqual(store.released, []);
  assert.deepEqual([...store.claimed], ["a", "b"]);
  assert.equal(store.messages.has("a"), false);

  await sendDiscountCards({ delivery, store, channelId: CHANNEL });
  assert.equal(attempts, 2);
});

test("a sent card whose message id could not be saved is not sent again", async (t) => {
  const store = memoryStore([row("a")]);
  store.failSave = true;
  const discord = discordAnswering(t);
  const failures = await sendDiscountCards({
    ...discord,
    store,
    channelId: CHANNEL,
  });
  assert.deepEqual(failures, ["a: database gone"]);
  await sendDiscountCards({ ...discord, store, channelId: CHANNEL });
  assert.equal(discord.sent.length, 1);
});

test("a run that loses the claim to another process sends nothing", async (t) => {
  const store = memoryStore([row("a")]);
  store.claimCandidateCard = async () => false;
  const discord = discordAnswering(t);
  await sendDiscountCards({ ...discord, store, channelId: CHANNEL });
  assert.equal(discord.sent.length, 0);
});

test("one rejected row cannot hold back rows behind it", async (t) => {
  const store = memoryStore([row("bad"), row("a")]);
  const discord = discordAnswering(t, (id) =>
    id === "bad"
      ? new Response("", { status: 400 })
      : new Response(JSON.stringify({ id: `message-${id}` })),
  );
  await sendDiscountCards({ ...discord, store, channelId: CHANNEL });
  assert.deepEqual(discord.ids(), ["a"]);
});

test("a database failure is reported, not thrown", async () => {
  const store = memoryStore([]);
  store.cardsInLastHour = async () => {
    throw new Error("database gone");
  };
  assert.deepEqual(
    await sendDiscountCards({
      store,
      delivery: {
        send: async () => {
          throw new Error("must not send");
        },
      },
      channelId: CHANNEL,
    }),
    ["cards: database gone"],
  );
});
