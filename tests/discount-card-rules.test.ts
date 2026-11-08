import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CARD_COLOR,
  cardLink,
  discordEmbed,
  discountCard,
  findDeadline,
  reviewCard,
  offerHasEnded,
  postSummary,
  shouldCardCandidate as shouldCardAt,
  type CandidateForCard,
} from "@rapi/domain";

// The fixture's offer runs through September 18.
const shouldCardCandidate = (candidate: CandidateForCard) =>
  shouldCardAt(candidate, new Date("2026-09-01T00:00:00Z"));

const offer = (fields: Partial<CandidateForCard> = {}): CandidateForCard => ({
  id: "1",
  kind: "discount",
  route: "changelog",
  domain: "vercel.com",
  title: "GPT-6.1 Sol is 50% off on AI Gateway",
  url: "https://vercel.com/changelog/sol",
  evidence: "GPT-6.1 Sol is 50% off on AI Gateway through September 18.",
  band: "yellow",
  tags: ["#재판매"],
  operator: "Vercel",
  priceCheck: "below_list",
  termsNote: null,
  ...fields,
});
// What the collector keeps from an ordinary update: nothing below list.
const update = (title: string, evidence = title) =>
  offer({ title, evidence, priceCheck: "unknown" });

test("ordinary updates from the real changelogs do not become cards", () => {
  for (const candidate of [
    update(
      "Updates to Hobby and Pro Terms of Service",
      "Updates to Hobby and Pro Terms of Service. The new terms apply through December 1, 2026 and cover free Hobby accounts.",
    ),
    update("Kimi K3 now available on AI Gateway"),
    update(
      "Kimi K3 now available on AI Gateway",
      "Kimi K3 now available on AI Gateway. Load credits onto AI Gateway through March 1, 2027. Feel free to try it, no credit card needed for the tax-free plan.",
    ),
  ])
    assert.equal(shouldCardCandidate(candidate), false, candidate.evidence);
});

test("an offer becomes a card when it is below list or gives something", () => {
  for (const candidate of [
    offer(),
    update(
      "Feature Eligible ChatGPT Pro and Business subscribers can now claim up to $500 per month in free API credits",
    ),
    update(
      "Introducing Claude Haiku 5.5",
      "we're introducing a new monthly API credit for our Claude Max subscribers",
    ),
    update("무료 크레딧 지급"),
    offer({
      kind: "new_service",
      route: "code_search",
      title: "https://api.relay.io/v1",
      evidence: "https://github.com/o/r",
      priceCheck: "unknown",
    }),
  ])
    assert.equal(shouldCardCandidate(candidate), true, candidate.title);
});

test("a red or unchecked row is never a card, however good the offer", () => {
  assert.equal(shouldCardCandidate(offer({ band: "red" })), false);
  assert.equal(shouldCardCandidate(offer({ band: null })), false);
  assert.equal(
    shouldCardCandidate(offer({ kind: "new_service", band: "red" })),
    false,
  );
  assert.equal(
    shouldCardCandidate(offer({ kind: "new_service", band: null })),
    false,
  );
});

test("only an https address can be a card's link", () => {
  for (const url of [
    "http://x.test/a",
    "javascript:alert(1)",
    "not a url",
    "https://user:pass@x.test/a",
    `https://x.test/${"a".repeat(600)}`,
  ]) {
    assert.equal(cardLink(url), null, url);
    assert.equal(shouldCardCandidate(offer({ url })), false, url);
  }
});

test("a referral parameter never reaches a link", () => {
  assert.equal(
    cardLink("https://x.test/a?ref=me&id=7&aff_id=1&utm_source=z&via=y&code=q"),
    "https://x.test/a?id=7",
  );
});

test("a card shows source, linked title, details, tags and its band", () => {
  const embed = discordEmbed(discountCard(offer())) as {
    author: { name: string };
    title: string;
    url: string;
    description: string;
    color: number;
  };
  assert.equal(embed.author.name, "공식 변경로그 · vercel.com");
  assert.equal(embed.title, "GPT\\-6\\.1 Sol is 50% off on AI Gateway");
  assert.equal(embed.url, "https://vercel.com/changelog/sol");
  assert.deepEqual(embed.description.split("\n"), [
    "through September 18\\.",
    "운영: Vercel",
    "가격: 정가보다 쌈",
    "#재판매",
  ]);
  assert.notEqual(
    discountCard(offer({ band: "green" })).color,
    discountCard(offer({ band: "yellow" })).color,
  );
});

test("a missing terms link is one line and does not change the color", () => {
  for (const termsNote of ["확인 못 함", "링크 없음"] as const) {
    const card = discountCard(offer({ termsNote }));
    assert.equal(
      card.description?.split("\n").filter((line) => line.startsWith("약관"))
        .length,
      1,
    );
    assert.ok(card.description!.includes(`약관: ${termsNote}`));
    assert.equal(card.color, discountCard(offer()).color);
  }
  assert.ok(!discountCard(offer()).description?.includes("약관"));
});

test("a stranger's text cannot form a link, a mention or markdown", () => {
  const card = discountCard(
    offer({
      domain: "evil.test",
      title:
        "[claim](http://evil.test) <@123> @everyone **now** hthttps://tps://x.test https:/x:///y.test",
      evidence: `line one\n# <#1> ![a](b) \`c\` ||d|| discord.gg/abc ht\u200btps://z.test`,
      operator: "[Op](https://evil.test)",
    }),
  );
  const [detail, operator] = card.description!.split("\n");
  const text = [card.title, detail, operator!.replace("운영: ", "")].join("\n");
  // Whatever is left of these is escaped, so Discord shows it as plain text.
  assert.ok(!/(?<!\\)[[\]()<>@*`|:]/.test(text), text);
  assert.ok(!/(?<!\\)\.\w/.test(text), text);
  assert.ok(text.includes("discord\\.gg/abc"), text);
  assert.ok(!text.includes("​"));
  assert.equal(card.title.includes("\n"), false);
  assert.ok(card.description?.startsWith("line one \\# "), card.description);
});

test("an address title stays readable and is not a link in the text", () => {
  const card = discountCard(
    offer({
      kind: "new_service",
      route: "code_search",
      domain: "api.relay.io",
      title: "https://api.relay.io/v1",
      url: "https://github.com/o/r/blob/a/c.ts",
      evidence: "https://github.com/o/r",
      operator: null,
      priceCheck: "unknown",
      termsNote: "확인 못 함",
      tags: [],
    }),
  );
  assert.equal(card.author, "코드 검색 · api.relay.io");
  assert.equal(card.title, "api\\.relay\\.io/v1");
  assert.equal(card.url, "https://github.com/o/r/blob/a/c.ts");
  assert.deepEqual(card.description?.split("\n"), [
    "github\\.com/o/r",
    "약관: 확인 못 함",
  ]);
});

test("a title with nothing left falls back instead of being empty", () => {
  assert.equal(
    discountCard(offer({ title: "\u200b\n", domain: "x.test" })).title,
    "x\\.test",
  );
  assert.equal(
    discountCard(offer({ title: " ", domain: null })).title,
    "이름 없는 후보",
  );
});

test("a deadline is prefilled from a date in the title or evidence", () => {
  for (const [title, evidence, expected] of [
    ["50% off", "50% off through September 18.", "September 18"],
    ["Ends Dec. 1, 2026", "", "Dec. 1, 2026"],
    ["50% off", "Offer ends on 1 March 2027 for everyone.", "1 March 2027"],
    ["할인", "2026년 12월 31일까지 무료", "2026년 12월 31일"],
    ["할인", "12월 3일까지", "12월 3일"],
    ["Sale", "valid until 2026-12-31", "2026-12-31"],
    ["Sale", "마감: 2026.12.31 입니다", "2026.12.31"],
    // The end wins over a date that only says when this was written.
    ["Sale", "Posted Nov 1, 2026. Credits expire on Jan 15.", "Jan 15"],
    // Any other date is still offered, for the owner to confirm or clear.
    ["Sale on Nov 5", "50% off", "Nov 5"],
  ] as const)
    assert.equal(
      findDeadline({ title, evidence }),
      expected,
      evidence || title,
    );
});

test("no date, no deadline: version numbers and prices are not dates", () => {
  for (const [title, evidence] of [
    ["50% off", "50% off for everyone"],
    ["Claude 3.5 is out", "v2026.13.45 costs $20 / 30 days"],
    ["May the odds", "maybe 10 models"],
    ["Released in May 2026", "for 2026"],
  ] as const)
    assert.equal(findDeadline({ title, evidence }), "", title);
});

test("a confirmed deadline shows as one safe line; blank shows nothing", () => {
  const body = (deadline?: string) =>
    discountCard(offer({ evidence: "50% off" }), deadline).description;
  assert.doesNotMatch(body()!, /마감/);
  assert.doesNotMatch(body("   ")!, /마감/);
  assert.match(body("2026-12-31")!, /^마감: 2026\\-12\\-31$/m);
  const hostile = body("<@123> [x](https://evil.test)\n@everyone")!;
  assert.doesNotMatch(hostile, /https:|(?<!\\)<@|(?<!\\)@everyone|\]\(/);
  assert.equal(
    hostile.split("\n").filter((line) => line.startsWith("마감")).length,
    1,
  );
  assert.ok(body("x".repeat(100))!.includes(`마감: ${"x".repeat(39)}…`));
});

const report = (fields: Partial<CandidateForCard> = {}) =>
  offer({
    route: "report",
    domain: "new.ai",
    title: "new.ai",
    url: "https://new.ai/deal",
    evidence: "",
    tags: [],
    operator: null,
    priceCheck: "unknown",
    termsNote: "확인 못 함",
    ...fields,
  });

test("a report needs no discount wording, but red and unchecked stay out", () => {
  assert.equal(shouldCardCandidate(report()), true);
  assert.equal(shouldCardCandidate(report({ band: "red" })), false);
  assert.equal(shouldCardCandidate(report({ band: null })), false);
  assert.equal(shouldCardCandidate(report({ url: "http://new.ai/" })), false);
});

test("a memo shows on the review card alone, as text that cannot ping or link", () => {
  const memo = "@everyone [클릭](https://evil.ai) <@1> `x`";
  const shown = report({ memo });
  assert.equal(discountCard(shown).author, "제보 · new.ai");
  assert.doesNotMatch(discountCard(shown).description ?? "", /메모|evil/);

  const line = reviewCard(shown).description!.split("\n").at(-1)!;
  assert.equal(
    line,
    "메모: \\@everyone \\[클릭\\]\\(evil\\.ai\\) \\<\\@1\\> \\`x\\`",
  );
  assert.deepEqual(reviewCard(report()), discountCard(report()));
});

test("price cut wording alone makes a card", () => {
  for (const evidence of [
    "Claude Sonnet 4.6: 10% discount on all groups",
    "API prices have been reduced accordingly.",
    "we will adopt peak/off-peak pricing, with off-peak prices set at half",
    "모든 모델 20% 할인",
  ])
    assert.equal(
      shouldCardCandidate(update("Service update", evidence)),
      true,
      evidence,
    );
});

test("an offer past its own end date is not a card", () => {
  const ling = offer({
    title: "Ling 3.1 Flash 1019 now available on AI Gateway for free",
    evidence: "free until November 3, 2026. The updated model is for coding.",
    priceCheck: "unknown",
  });
  const on = (day: string) => shouldCardAt(ling, new Date(day));
  assert.equal(on("2026-11-02T00:00:00Z"), true);
  assert.equal(on("2026-11-03T14:00:00Z"), true);
  assert.equal(on("2026-11-03T15:00:00Z"), false);
  assert.equal(on("2026-11-05T00:00:00Z"), false);
});

test("an end date is read in every written form", () => {
  const now = new Date("2026-11-05T00:00:00Z");
  const ended = (evidence: string) =>
    offerHasEnded({ title: "", evidence }, now);
  for (const evidence of [
    "50% off through 2026-11-01",
    "무료 2026년 11월 1일까지",
    "11월 1일까지 할인",
    "free until Nov 1st",
    "ends 1 November 2026",
    "ends on October 31",
  ])
    assert.equal(ended(evidence), true, evidence);
  for (const evidence of [
    "50% off through 2026-12-01",
    "free until December 1",
    "free until January 15",
    "released on October 1 with 50% off",
    "50% off, no end date",
  ])
    assert.equal(ended(evidence), false, evidence);
});

test("a person's report and a new service are not judged by an end date", () => {
  const now = new Date("2026-11-05T00:00:00Z");
  const evidence = "free until November 3, 2026";
  assert.equal(shouldCardAt(offer({ evidence, route: "report" }), now), true);
  assert.equal(
    shouldCardAt(offer({ evidence, kind: "new_service" }), now),
    true,
  );
});

const boardPost = (fields: Partial<CandidateForCard> = {}) =>
  offer({
    route: "community",
    domain: null,
    title: "TokenU 活动 充 $10 送 $3",
    url: "https://linux.do/t/topic/1",
    evidence: "双十一活动",
    tags: ["#위험"],
    priceCheck: "unknown",
    ...fields,
  });

test("a board post is carded on the collector's judgement unless its end date passed", () => {
  assert.equal(shouldCardCandidate(boardPost()), true);
  assert.equal(
    shouldCardCandidate(boardPost({ evidence: "活动 until 2026-08-01" })),
    false,
  );
});

test("a risky card says so first, in the warning color, on the public card too", () => {
  const card = discountCard(boardPost());
  assert.match(card.description!, /^위험: 검증하지 않은 커뮤니티 글입니다/);
  // Said once, by the risk line; no terms line, since no page was read.
  assert.doesNotMatch(card.description!, /#위험|약관/);
  assert.equal(card.color, CARD_COLOR.warn);
  assert.equal(card.author, "커뮤니티 · linux.do");
  assert.doesNotMatch(discountCard(offer()).description!, /위험:/);
});

test("a PromoClock deal is a card until its own end date", () => {
  const deal = (evidence: string) =>
    offer({
      route: "promoclock",
      title: "Synthesia: first month from $9",
      evidence,
      priceCheck: "unknown",
    });
  // The terms say neither free nor a cut; PromoClock lists only deals.
  assert.ok(
    shouldCardCandidate(deal("First month from $9 (since 2026-08-27).")),
  );
  assert.ok(
    !shouldCardCandidate(deal("Half price (2026-08-01 ~ 2026-08-20).")),
  );
});

test("a board post's card names its forum without giving it a domain", () => {
  const card = discountCard(
    boardPost({ url: "https://www.v2ex.com/t/1254849" }),
  );
  assert.equal(card.author, "커뮤니티 · www.v2ex.com");
});

test("a board post's card keeps its opening and drops the feed's footer", () => {
  const card = discountCard(
    boardPost({
      title: "무료 모델 두 가지",
      evidence:
        "첫 번째는 연구용 무료 모델입니다. 두 번째는 무료 API 호출입니다. 세 번째 이야기는 길게 이어집니다 그리고 계속됩니다 아주 길게 계속해서 이어지는 문장이라 카드에는 다 들어가지 않습니다 그래서 잘라야 합니다 아직도 이어집니다 정말로 끝없이 이어지는 이야기라서 링크를 눌러야 다 볼 수 있습니다 여기까지 읽었다면 충분합니다. 8개의 게시물 - 참여자 7명 전체 주제 읽기",
    }),
  );
  const lines = card.description!.split("\n");
  assert.equal(
    lines[1],
    "첫 번째는 연구용 무료 모델입니다\\. 두 번째는 무료 API 호출입니다\\.",
  );
  assert.doesNotMatch(card.description!, /게시물|주제 읽기/);
});

test("a short post loses only the footer, in any of the feed's languages", () => {
  for (const footer of [
    "3 个帖子 - 3 位参与者 阅读完整话题",
    "3 posts - 2 participants Read full topic",
    "3개의 게시물 - 참여자 3명 전체 주제 읽기",
  ])
    assert.equal(postSummary(`가입하면 $5 증정 ${footer}`), "가입하면 $5 증정");
});
