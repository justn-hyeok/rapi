import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { DiscordDeliveryAdapter } from "@rapi/adapters";
import {
  discountCardButton,
  publishDiscountCard,
  type DiscountApproval,
} from "@rapi/agent";
import type { CandidateForDecision } from "@rapi/domain";

const ID = "11111111-1111-4111-8111-111111111111";
const OWNER = { userId: "1", channelId: "100" };
const PUBLISH = `discount_publish:${ID}`;
const DISCARD = `discount_discard:${ID}`;
const SUBMIT = `discount_publish_modal:${ID}`;

const row = (fields: Partial<CandidateForDecision> = {}) =>
  ({
    id: ID,
    kind: "discount",
    route: "changelog",
    domain: "x.test",
    title: "Offer is 50% off",
    url: "https://x.test/a?ref=me",
    evidence: "50% off through December 1, 2026",
    band: "green",
    tags: ["#직접호스팅"],
    operator: null,
    priceCheck: "below_list",
    termsNote: null,
    status: "new",
    ...fields,
  }) as CandidateForDecision;

/** The queries' behavior on one row. */
function memoryStore(candidate: CandidateForDecision | null = row()) {
  return {
    row: candidate,
    decidedAt: null as Date | null,
    publicMessageId: null as string | null,
    retryAt: null as Date | null,
    failing: false,
    failingSave: false,
    failingRelease: false,
    async candidateForDecision() {
      if (this.failing) throw new Error("database gone");
      return this.row;
    },
    async publicationRetryAt() {
      return this.retryAt;
    },
    async claimCandidatePublication() {
      if (this.retryAt) return { claimed: false, retryAt: this.retryAt };
      if (this.row?.status !== "new" || this.row.band === "red")
        return { claimed: false, retryAt: null };
      this.row.status = "published";
      this.decidedAt = new Date();
      return { claimed: true, retryAt: null };
    },
    async releaseCandidatePublication() {
      if (this.failingRelease) throw new Error("database gone");
      if (this.publicMessageId) return;
      this.row!.status = "new";
      this.decidedAt = null;
    },
    async saveCandidatePublicMessage(_id: string, messageId: string) {
      if (this.failingSave) throw new Error("database gone");
      this.publicMessageId = messageId;
    },
    async discardCandidate() {
      if (this.row?.status !== "new") return false;
      this.row.status = "discarded";
      return true;
    },
  };
}

interface Sent {
  url: string;
  embeds: Array<{ url: string; description: string; color: number }>;
  components: Array<{ components: Array<Record<string, unknown>> }>;
  allowed_mentions: unknown;
}

/** The real adapter with Discord answered by `answer`. */
function setup(
  t: TestContext,
  store = memoryStore(),
  answer: () => Response = () => new Response('{"id":"900"}'),
  options: Partial<DiscountApproval> = {},
) {
  const sent: Sent[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string, init?: RequestInit) => {
      sent.push({ ...JSON.parse(init!.body as string), url } as Sent);
      return answer();
    },
  );
  return {
    store,
    sent,
    input: {
      store,
      delivery: new DiscordDeliveryAdapter("token"),
      ownerIds: ["1"],
      reviewChannelIds: async () => ["100"],
      publicChannelIds: async () => ["200"],
      ...options,
    } as DiscountApproval,
  };
}

type Reply = {
  type: number;
  data: {
    content?: string;
    flags?: number;
    custom_id?: string;
    components?: Array<{ components: Array<Record<string, unknown>> }>;
  };
};
const press = async (
  input: DiscountApproval,
  customId: string,
  identity: { userId: string; channelId?: string } = OWNER,
) => (await discountCardButton(input, identity, customId)) as Reply;

const assertRefused = (reply: Reply, pattern: RegExp) => {
  assert.equal(reply.type, 4);
  assert.equal(reply.data.flags, 64);
  assert.match(reply.data.content!, pattern);
};

test("anyone but the owner is refused and nothing changes", async (t) => {
  const { input, store, sent } = setup(t);
  const stranger = { userId: "2", channelId: "100" };
  for (const customId of [PUBLISH, DISCARD])
    assertRefused(await press(input, customId, stranger), /소유자만/);
  assert.deepEqual(await publishDiscountCard(input, stranger, SUBMIT, ""), {
    notice: "소유자만 쓸 수 있는 버튼입니다.",
  });
  assert.equal(store.row!.status, "new");
  assert.equal(sent.length, 0);
});

test("the owner's click from another channel is refused", async (t) => {
  const { input, store, sent } = setup(t);
  const elsewhere = { userId: "1", channelId: "300" };
  for (const customId of [PUBLISH, DISCARD])
    assertRefused(await press(input, customId, elsewhere), /검토 채널에서만/);
  const { notice } = await publishDiscountCard(input, elsewhere, SUBMIT, "");
  assert.match(notice!, /검토 채널에서만/);
  assert.equal(store.row!.status, "new");
  assert.equal(sent.length, 0);
});

test("the buttons work in every review channel, and each kind asks for its own channels", async (t) => {
  const store = memoryStore(row({ kind: "new_service" }));
  const asked: string[] = [];
  const { input, sent } = setup(t, store, undefined, {
    reviewChannelIds: async () => ["100", "101"],
    publicChannelIds: async (kind) => {
      asked.push(kind);
      return kind === "new_service" ? ["201"] : ["200"];
    },
  });
  const inNewChannel = { ...OWNER, channelId: "101" };
  assert.equal((await press(input, PUBLISH, inNewChannel)).type, 9);
  const result = await publishDiscountCard(input, inNewChannel, SUBMIT, "");
  assert.ok(asked.every((kind) => kind === "new_service"));
  assert.equal(sent[0]!.url.split("/").at(-2), "201");
  assert.match(result.edit!.content, /<#201>/);
});

test("a card goes to every server's channel, and one failing does not stop the rest", async (t) => {
  const store = memoryStore();
  let calls = 0;
  const { input, sent } = setup(
    t,
    store,
    () =>
      ++calls === 1
        ? new Response("{}", { status: 403 })
        : new Response(`{"id":"${calls}"}`),
    { publicChannelIds: async () => ["200", "201", "202"] },
  );
  const result = await publishDiscountCard(input, OWNER, SUBMIT, "");
  assert.deepEqual(
    sent.map(({ url }) => url.split("/").at(-2)),
    ["200", "201", "202"],
  );
  assert.equal(store.publicMessageId, "2");
  assert.equal(store.row!.status, "published");
  assert.match(result.edit!.content, /<#201>, <#202>에 게시/);
  assert.match(result.notice!, /<#200>/);
});

test("the row goes back only when every channel refused", async (t) => {
  const store = memoryStore();
  const { input } = setup(t, store, () => new Response("{}", { status: 403 }), {
    publicChannelIds: async () => ["200", "201"],
  });
  const result = await publishDiscountCard(input, OWNER, SUBMIT, "");
  assert.equal(store.row!.status, "new");
  assert.match(result.notice!, /<#200>, <#201> 권한/);
});

test("without a public channel or an owner the buttons refuse cleanly", async (t) => {
  const { input, store, sent } = setup(t);
  for (const missing of [
    { publicChannelIds: async () => [] },
    { reviewChannelIds: async () => [] },
  ]) {
    const unset = { ...input, ...missing };
    for (const customId of [PUBLISH, DISCARD])
      assertRefused(await press(unset, customId), /설정되지 않아/);
    const { notice } = await publishDiscountCard(unset, OWNER, SUBMIT, "");
    assert.match(notice!, /설정되지 않아/);
  }
  assertRefused(await press({ ...input, ownerIds: [] }, PUBLISH), /소유자만/);
  assert.equal(store.row!.status, "new");
  assert.equal(sent.length, 0);
});

test("[게시] opens a modal prefilled from the row; only the row id travels", async (t) => {
  const { input, store, sent } = setup(t);
  const reply = await press(input, PUBLISH);
  assert.equal(reply.type, 9);
  assert.equal(reply.data.custom_id, SUBMIT);
  const field = reply.data.components![0]!.components[0]!;
  assert.equal(field.value, "December 1, 2026");
  assert.equal(field.required, false);
  assert.equal(store.row!.status, "new");
  assert.equal(sent.length, 0);
});

test("with no date the modal starts blank", async (t) => {
  const { input } = setup(t, memoryStore(row({ evidence: "50% off" })));
  const reply = await press(input, PUBLISH);
  assert.equal(reply.data.components![0]!.components[0]!.value, undefined);
});

test("publishing sends the same card, without approval buttons, to the public channel", async (t) => {
  const { input, store, sent } = setup(t);
  const result = await publishDiscountCard(input, OWNER, SUBMIT, "2026-12-31");
  assert.equal(sent.length, 1);
  const [card] = sent;
  assert.equal(card!.url, "https://discord.com/api/v10/channels/200/messages");
  assert.deepEqual(card!.allowed_mentions, { parse: [] });
  assert.equal(card!.embeds.length, 1);
  assert.equal(card!.embeds[0]!.url, "https://x.test/a");
  assert.equal(card!.embeds[0]!.color, 0x2e9e5b);
  assert.match(card!.embeds[0]!.description, /마감: 2026\\-12\\-31/);
  assert.match(card!.embeds[0]!.description, /#직접호스팅/);
  assert.deepEqual(card!.components, [
    {
      type: 1,
      components: [
        { type: 2, style: 5, label: "원문 보기", url: "https://x.test/a" },
      ],
    },
  ]);
  assert.equal(store.row!.status, "published");
  assert.ok(store.decidedAt);
  assert.equal(store.publicMessageId, "900");
  assert.match(result.edit!.content, /<#200>에 게시했습니다.*마감/);
  assert.deepEqual(result.edit!.components, card!.components);
  assert.equal(result.notice, undefined);
});

test("a blank deadline shows no deadline", async (t) => {
  const { input, sent } = setup(t);
  const result = await publishDiscountCard(input, OWNER, SUBMIT, "  ");
  assert.doesNotMatch(sent[0]!.embeds[0]!.description, /마감/);
  assert.doesNotMatch(result.edit!.content, /마감/);
});

test("a second submit or click sends nothing more", async (t) => {
  const { input, sent } = setup(t);
  await publishDiscountCard(input, OWNER, SUBMIT, "");
  assert.deepEqual(await publishDiscountCard(input, OWNER, SUBMIT, ""), {
    notice: "이미 처리한 후보입니다.",
  });
  for (const customId of [PUBLISH, DISCARD])
    assertRefused(await press(input, customId), /이미 처리/);
  assert.equal(sent.length, 1);
});

test("losing the claim to another tab sends nothing", async (t) => {
  const { input, store, sent } = setup(t);
  store.claimCandidatePublication = async () => ({
    claimed: false,
    retryAt: null,
  });
  const { notice, edit } = await publishDiscountCard(input, OWNER, SUBMIT, "");
  assert.match(notice!, /이미 처리/);
  assert.equal(edit, undefined);
  assert.equal(sent.length, 0);
});

test("a red row is never published, even with the modal already open", async (t) => {
  const { input, store, sent } = setup(t, memoryStore(row({ band: "red" })));
  assertRefused(await press(input, PUBLISH), /빨강/);
  const { notice } = await publishDiscountCard(input, OWNER, SUBMIT, "");
  assert.match(notice!, /빨강/);
  assert.equal(store.row!.status, "new");
  assert.equal(sent.length, 0);
});

test("over the hourly limit it says when to try and changes nothing", async (t) => {
  const { input, store, sent } = setup(t);
  store.retryAt = new Date(1_800_000_000_000);
  assertRefused(await press(input, PUBLISH), /<t:1800000000:t> 이후/);
  const { notice } = await publishDiscountCard(input, OWNER, SUBMIT, "");
  assert.match(notice!, /시간당 5장.*<t:1800000000:t> 이후/);
  assert.equal(store.row!.status, "new");
  assert.equal(sent.length, 0);
});

test("the limit is checked when the row is claimed, not only on the click", async (t) => {
  const { input, store, sent } = setup(t);
  assert.equal((await press(input, PUBLISH)).type, 9);
  store.retryAt = new Date(1_800_000_000_000);
  await publishDiscountCard(input, OWNER, SUBMIT, "");
  assert.equal(store.row!.status, "new");
  assert.equal(sent.length, 0);
});

test("a send Discord refused is released and can be pressed again", async (t) => {
  for (const status of [403, 429]) {
    const { input, store } = setup(
      t,
      memoryStore(),
      () => new Response("{}", { status }),
    );
    const result = await publishDiscountCard(input, OWNER, SUBMIT, "");
    assert.equal(store.row!.status, "new");
    assert.equal(store.decidedAt, null);
    assert.equal(result.edit, undefined);
    assert.match(result.notice!, /게시하지 못했습니다/);
    assert.equal((await press(input, PUBLISH)).type, 9);
    t.mock.restoreAll();
  }
});

test("an unknown outcome keeps the claim and says so", async (t) => {
  for (const answer of [
    () => {
      throw new Error("timed out");
    },
    () => new Response("no json"),
    () => new Response("down", { status: 503 }),
  ]) {
    const { input, store, sent } = setup(t, memoryStore(), answer);
    const result = await publishDiscountCard(input, OWNER, SUBMIT, "");
    assert.equal(store.row!.status, "published");
    assert.equal(store.publicMessageId, null);
    assert.match(result.notice!, /알 수 없어 다시 보내지 않습니다/);
    assert.match(result.edit!.content, /알 수 없습니다/);
    assert.equal(result.edit!.components.length, 1);
    await publishDiscountCard(input, OWNER, SUBMIT, "");
    assert.equal(sent.length, 1);
    t.mock.restoreAll();
  }
});

test("a sent card whose id could not be saved stays published", async (t) => {
  const store = memoryStore();
  store.failingSave = true;
  const { input, sent } = setup(t, store);
  const result = await publishDiscountCard(input, OWNER, SUBMIT, "");
  assert.equal(store.row!.status, "published");
  assert.match(result.edit!.content, /게시했습니다/);
  assert.match(result.notice!, /저장하지 못했습니다/);
  await publishDiscountCard(input, OWNER, SUBMIT, "");
  assert.equal(sent.length, 1);
});

test("a release that fails says so instead of claiming the row is back", async (t) => {
  const store = memoryStore();
  store.failingRelease = true;
  const { input } = setup(t, store, () => new Response("{}", { status: 403 }));
  const { notice } = await publishDiscountCard(input, OWNER, SUBMIT, "");
  assert.match(notice!, /되돌리지 못했습니다/);
});

test("[버리기] removes the decision buttons and keeps the link", async (t) => {
  const { input, store, sent } = setup(t);
  const reply = await press(input, DISCARD);
  assert.equal(reply.type, 7);
  assert.equal(reply.data.content, "버렸습니다.");
  assert.deepEqual(reply.data.components, [
    {
      type: 1,
      components: [
        { type: 2, style: 5, label: "원문 보기", url: "https://x.test/a" },
      ],
    },
  ]);
  assert.equal(store.row!.status, "discarded");
  assert.equal(sent.length, 0);
  assert.match(
    (await publishDiscountCard(input, OWNER, SUBMIT, "")).notice!,
    /이미 처리/,
  );
  assert.equal(sent.length, 0);
});

test("a red row can still be thrown away", async (t) => {
  const { input, store } = setup(t, memoryStore(row({ band: "red" })));
  assert.equal((await press(input, DISCARD)).type, 7);
  assert.equal(store.row!.status, "discarded");
});

test("an unknown or malformed row id is refused", async (t) => {
  const store = memoryStore(null);
  const { input } = setup(t, store);
  assertRefused(await press(input, PUBLISH), /찾지 못했습니다/);
  assertRefused(
    await press(input, "discount_publish:'; DROP TABLE x"),
    /찾지 못했습니다/,
  );
});

test("a database failure answers the owner instead of throwing", async (t) => {
  const store = memoryStore();
  store.failing = true;
  const { input, sent } = setup(t, store);
  t.mock.method(process.stderr, "write", () => true);
  assertRefused(await press(input, PUBLISH), /다시 눌러/);
  const { notice } = await publishDiscountCard(input, OWNER, SUBMIT, "");
  assert.match(notice!, /다시 눌러/);
  assert.equal(sent.length, 0);
});
