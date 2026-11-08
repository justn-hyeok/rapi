import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  DiscordRateLimitError,
  DiscordServerError,
  PermanentDeliveryError,
  UncertainDeliveryError,
} from "@rapi/application";
import { DiscordDeliveryAdapter } from "@rapi/adapters";
import { remindStars, starReminderPayload } from "@rapi/application";
import type { DeliveryPayload, GitHubStar, StoredStar } from "@rapi/domain";

// 09:30 in Seoul on 2026-11-05, and 08:59 the same morning.
const MORNING = new Date("2026-11-05T00:30:00Z");
const EARLY = new Date("2026-11-04T23:59:00Z");
const NEXT_MORNING = new Date("2026-11-06T00:30:00Z");

const fresh = (fullName: string, starredAt = "2024-01-01T00:00:00Z") => ({
  fullName,
  url: `https://github.com/${fullName}`,
  description: "",
  language: null,
  stars: 5,
  archived: false,
  starredAt,
});

/** The store's behavior: rows that survive only as long as the run needs them. */
function memoryStore(initial: GitHubStar[] = []) {
  const rows = new Map<string, StoredStar & { count: number }>();
  const saved: Array<{ names: string[]; complete: boolean }> = [];
  const days = new Map<string, string | null>();
  const store = {
    rows,
    saved,
    days,
    failSave: false,
    async saveStars(stars: readonly GitHubStar[], complete: boolean) {
      saved.push({ names: stars.map((star) => star.fullName), complete });
      for (const star of stars)
        rows.set(star.fullName, {
          ...star,
          starredAt: new Date(star.starredAt),
          lastRemindedAt: rows.get(star.fullName)?.lastRemindedAt ?? null,
          count: rows.get(star.fullName)?.count ?? 0,
        });
    },
    async currentStars(): Promise<StoredStar[]> {
      return [...rows.values()].map((row) => ({ ...row }));
    },
    async starReminderClaimed(day: string) {
      return days.has(day);
    },
    async claimStarReminder(day: string, stars: readonly StoredStar[]) {
      if (days.has(day)) return false;
      days.set(day, null);
      for (const star of stars) {
        const row = rows.get(star.fullName)!;
        row.lastRemindedAt = new Date();
        row.count += 1;
      }
      return true;
    },
    async releaseStarReminder(day: string, stars: readonly StoredStar[]) {
      days.delete(day);
      for (const star of stars) {
        const row = rows.get(star.fullName)!;
        row.lastRemindedAt = star.lastRemindedAt;
        row.count -= 1;
      }
    },
    async saveStarReminderMessage(day: string, messageId: string) {
      if (store.failSave) throw new Error("database gone");
      days.set(day, messageId);
    },
  };
  for (const star of initial)
    rows.set(star.fullName, {
      ...star,
      starredAt: new Date(star.starredAt),
      lastRemindedAt: null,
      count: 0,
    });
  return store;
}

function setup(
  options: {
    stored?: GitHubStar[];
    listed?: GitHubStar[];
    answer?: () => void;
    read?: () => void;
  } = {},
) {
  const store = memoryStore(options.stored);
  const sent: Array<{ recipient: string; channel: string; key?: string }> = [];
  let reads = 0;
  const input = {
    store,
    ownerId: "42",
    random: () => 0.9,
    reads: {},
    delivery: {
      async send(
        target: { channel: string; recipientId: string },
        _payload: DeliveryPayload,
        key?: string,
      ) {
        options.answer?.();
        sent.push({
          recipient: target.recipientId,
          channel: target.channel,
          ...(key ? { key } : {}),
        });
        return { providerId: `message-${sent.length}` };
      },
    },
    async readStars() {
      reads += 1;
      options.read?.();
      return { stars: options.listed ?? [fresh("a/one")], complete: true };
    },
  };
  return { store, sent, input, reads: () => reads };
}

test("nothing happens before nine in Seoul", async () => {
  const { sent, input, reads } = setup();
  assert.deepEqual(await remindStars({ ...input, now: EARLY }), []);
  assert.equal(reads(), 0);
  assert.equal(sent.length, 0);
});

test("one DM to the owner, marked as sent, and only once however often it runs", async () => {
  const { store, sent, input, reads } = setup({
    listed: [fresh("a/one"), fresh("a/two"), fresh("a/three")],
  });
  for (let run = 0; run < 3; run += 1)
    assert.deepEqual(await remindStars({ ...input, now: MORNING }), []);
  assert.deepEqual(sent, [
    {
      recipient: "42",
      channel: "discord_dm",
      key: "star-reminder:42:2026-11-05",
    },
  ]);
  assert.equal(reads(), 1);
  assert.equal(store.days.get("2026-11-05"), "message-1");
  // Two of three were marked with this coin.
  assert.equal(
    [...store.rows.values()].filter((row) => row.count === 1).length,
    2,
  );
});

test("a restart in the same day sends nothing and reads nothing", async () => {
  const first = setup();
  await remindStars({ ...first.input, now: MORNING });
  const restarted = { ...first.input, reads: {} };
  assert.deepEqual(await remindStars({ ...restarted, now: MORNING }), []);
  assert.equal(first.sent.length, 1);
  assert.equal(first.reads(), 1);
});

test("the next day sends again and reads the list again", async () => {
  const { sent, input, reads } = setup({
    listed: [fresh("a/one"), fresh("a/two"), fresh("a/three")],
  });
  await remindStars({ ...input, now: MORNING });
  await remindStars({ ...input, now: NEXT_MORNING });
  assert.equal(sent.length, 2);
  assert.equal(reads(), 2);
});

test("a failed read keeps the stored stars and still reminds from them", async () => {
  const { store, sent, input, reads } = setup({
    stored: [fresh("a/kept")],
    read: () => {
      throw new Error("Source returned 403");
    },
  });
  const failures = await remindStars({ ...input, now: MORNING });
  assert.deepEqual(failures, ["read: Source returned 403"]);
  assert.equal(sent.length, 1);
  assert.equal(store.rows.get("a/kept")?.count, 1);
  assert.equal(reads(), 1);
});

test("with nothing stored a failed read waits for tomorrow instead of retrying", async () => {
  const { store, sent, input, reads } = setup({
    read: () => {
      throw new Error("Source returned 404");
    },
  });
  const failures = await remindStars({ ...input, now: MORNING });
  assert.deepEqual(failures, ["read: Source returned 404"]);
  assert.deepEqual(await remindStars({ ...input, now: MORNING }), []);
  assert.equal(reads(), 1);
  assert.equal(sent.length, 0);
  assert.equal(store.days.size, 0);
});

test("nothing forgotten sends nothing and claims nothing", async () => {
  const { store, sent, input } = setup({
    listed: [fresh("a/new", "2026-11-01T00:00:00Z")],
  });
  assert.deepEqual(await remindStars({ ...input, now: MORNING }), []);
  assert.equal(sent.length, 0);
  assert.equal(store.days.size, 0);
});

for (const [name, error] of [
  ["403", new PermanentDeliveryError("Discord returned 403")],
  ["429", new DiscordRateLimitError("Discord returned 429")],
] as const)
  test(`a ${name} frees the day and leaves the stars as they were`, async () => {
    let refuse = true;
    const { store, sent, input, reads } = setup({
      answer: () => {
        if (refuse) throw error;
      },
    });
    const failures = await remindStars({ ...input, now: MORNING });
    assert.equal(failures.length, 1);
    assert.equal(store.days.size, 0);
    assert.equal(store.rows.get("a/one")?.count, 0);
    assert.equal(store.rows.get("a/one")?.lastRemindedAt, null);
    refuse = false;
    assert.deepEqual(await remindStars({ ...input, now: MORNING }), []);
    assert.equal(sent.length, 1);
    assert.equal(reads(), 1);
  });

for (const [name, error] of [
  ["no answer", new UncertainDeliveryError("outcome is uncertain")],
  ["a 5xx", new DiscordServerError("Discord returned 500")],
] as const)
  test(`${name} keeps the day claimed, so it is never sent twice`, async () => {
    const { store, sent, input } = setup({
      answer: () => {
        throw error;
      },
    });
    assert.equal((await remindStars({ ...input, now: MORNING })).length, 1);
    assert.deepEqual(await remindStars({ ...input, now: MORNING }), []);
    assert.equal(store.days.get("2026-11-05"), null);
    assert.equal(store.rows.get("a/one")?.count, 1);
    assert.equal(sent.length, 0);
  });

test("failing to record the message id does not free the day", async () => {
  const { store, sent, input } = setup();
  store.failSave = true;
  assert.deepEqual(await remindStars({ ...input, now: MORNING }), [
    "save: database gone",
  ]);
  assert.deepEqual(await remindStars({ ...input, now: MORNING }), []);
  assert.equal(sent.length, 1);
  assert.equal(store.days.has("2026-11-05"), true);
});

test("a database failure is reported, not thrown", async () => {
  const { store, sent, input } = setup();
  store.starReminderClaimed = async () => {
    throw new Error("database gone");
  };
  assert.deepEqual(await remindStars({ ...input, now: MORNING }), [
    "stars: database gone",
  ]);
  assert.equal(sent.length, 0);
});

test("the real adapter opens a DM and posts there with mentions off", async (t: TestContext) => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        body: JSON.parse(init!.body as string) as Record<string, unknown>,
      });
      return new Response(JSON.stringify({ id: `id-${calls.length}` }));
    },
  );
  const star: StoredStar = {
    ...fresh("a/one"),
    description: "@everyone [x](https://evil.test)",
    starredAt: new Date("2024-01-01T00:00:00Z"),
    lastRemindedAt: null,
  };
  await new DiscordDeliveryAdapter("token").send(
    { channel: "discord_dm", recipientId: "42" },
    starReminderPayload([
      { repo: star, reason: "" },
      {
        repo: { ...star, fullName: "a/two", url: "https://github.com/a/two" },
        reason: "",
      },
    ]),
  );
  assert.deepEqual(
    calls.map((call) => call.url),
    [
      "https://discord.com/api/v10/users/@me/channels",
      "https://discord.com/api/v10/channels/id-1/messages",
    ],
  );
  assert.deepEqual(calls[0]!.body, { recipient_id: "42" });
  const message = calls[1]!.body as {
    embeds: Array<{ description: string; url: string }>;
    components: Array<{ components: Array<{ style: number; url: string }> }>;
    allowed_mentions: unknown;
  };
  assert.deepEqual(message.allowed_mentions, { parse: [] });
  assert.equal(message.embeds.length, 2);
  assert.ok(!message.embeds[0]!.description.includes("https://"));
  assert.deepEqual(
    message.components[0]!.components.map((button) => [
      button.style,
      button.url,
    ]),
    [
      [5, "https://github.com/a/one"],
      [5, "https://github.com/a/two"],
    ],
  );
  // A thumb up and down for each, on a row of their own.
  assert.deepEqual(
    (
      message.components[1]!.components as unknown as Array<{
        custom_id: string;
      }>
    ).map((button) => button.custom_id),
    [
      "star_vote:1:a/one",
      "star_vote:-1:a/one",
      "star_vote:1:a/two",
      "star_vote:-1:a/two",
    ],
  );
});
