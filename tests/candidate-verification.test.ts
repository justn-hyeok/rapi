import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  knownOperator,
  verifyCandidate,
  type CandidateToVerify,
  type KnownOperator,
  type ServicePage,
} from "@rapi/core";

const OPENAI: KnownOperator = {
  domain: "openai.com",
  name: "OpenAI",
  service: "official",
  tags: [],
};
const VERCEL: KnownOperator = {
  domain: "vercel.com",
  name: "Vercel",
  service: "router",
  tags: [],
};
const APIYI: KnownOperator = {
  domain: "apiyi.com",
  name: "APIYI",
  service: "reseller",
  tags: [],
};

const relay: CandidateToVerify = {
  id: "1",
  kind: "new_service",
  route: "code_search",
  domain: "api.relay.io",
  title: "https://api.relay.io/v1",
  evidence: "https://github.com/o/r",
};
const offer = (title: string, domain: string): CandidateToVerify => ({
  id: "2",
  kind: "discount",
  route: "changelog",
  domain,
  title,
  evidence: title,
});
const page = (text: string, termsUrl: string | null = null): ServicePage => ({
  text,
  termsUrl,
});

test("an official API stays green when it discounts its own model", () => {
  const result = verifyCandidate(
    offer("GPT-6.1 Sol is 50% off", "developers.openai.com"),
    OPENAI,
    page("Home"),
  );
  assert.equal(result.band, "green");
  assert.equal(result.operator, "OpenAI");
  assert.equal(result.priceCheck, "below_list");
  assert.deepEqual(result.tags, []);
});

test("a router selling a closed model below list is yellow, however well known", () => {
  const result = verifyCandidate(
    offer("GPT-6.1 Sol is 50% off on AI Gateway", "vercel.com"),
    VERCEL,
    page("Home"),
  );
  assert.equal(result.band, "yellow");
  assert.deepEqual(result.tags, ["#재판매"]);
});

test("a known router with no closed-model discount is green", () => {
  const result = verifyCandidate(
    offer("Claim AI Gateway credits for your team", "vercel.com"),
    VERCEL,
    page("GPT-6.1 is 50% off here"),
  );
  assert.equal(result.band, "green");
  assert.equal(result.priceCheck, "unknown");
});

test("a known reseller is always yellow and tagged", () => {
  const result = verifyCandidate(
    offer("Service notice", "docs.apiyi.com"),
    APIYI,
    page("APIYI Inc."),
  );
  assert.equal(result.band, "yellow");
  assert.deepEqual(result.tags, ["#재판매"]);
  assert.equal(result.operator, "APIYI");
});

test("a relay found by code search with no operator is yellow resale", () => {
  const result = verifyCandidate(relay, null, page("Cheap API. Sign up now."));
  assert.equal(result.band, "yellow");
  assert.equal(result.operator, null);
  assert.deepEqual(result.tags, ["#재판매"]);
});

test("a named company does not make a closed-model relay green", () => {
  const result = verifyCandidate(
    relay,
    null,
    page("© 2026 Relay Labs, Inc. 50% off every model"),
  );
  assert.equal(result.band, "yellow");
  assert.equal(result.operator, "Relay Labs, Inc.");
  assert.equal(result.priceCheck, "below_list");
  assert.deepEqual(result.tags, ["#재판매"]);
});

test("a list-price router with a named company is green", () => {
  const result = verifyCandidate(
    relay,
    null,
    page("Relay Labs, Inc. routes GPT-6.1 with no markup."),
  );
  assert.equal(result.band, "green");
  assert.equal(result.priceCheck, "list_price");
  assert.deepEqual(result.tags, []);
});

test("claiming list price and a discount together counts as below list", () => {
  const result = verifyCandidate(
    relay,
    null,
    page("Relay Labs, Inc. No markup, and 30% off this week."),
  );
  assert.equal(result.band, "yellow");
  assert.equal(result.priceCheck, "below_list");
});

const newService: CandidateToVerify = {
  ...relay,
  route: "pull_request",
  domain: "nimbus.ai",
};

test("direct hosting of open models with a named company is green", () => {
  const result = verifyCandidate(
    newService,
    null,
    page("Nimbus GmbH runs Qwen on our own GPUs."),
  );
  assert.equal(result.band, "green");
  assert.equal(result.operator, "Nimbus GmbH");
  assert.deepEqual(result.tags, ["#직접호스팅", "#오픈모델"]);
});

test("an open model relay is green only when it names its suppliers", () => {
  const named = verifyCandidate(
    newService,
    null,
    page("주식회사 님버스. Llama-4 is served by Fireworks."),
  );
  assert.equal(named.band, "green");
  assert.equal(named.operator, "주식회사 님버스");
  assert.deepEqual(named.tags, ["#오픈모델"]);

  const unnamed = verifyCandidate(
    newService,
    null,
    page("주식회사 님버스. Try Llama-4."),
  );
  assert.equal(unnamed.band, "yellow");
  assert.deepEqual(unnamed.tags, ["#오픈모델"]);
});

test("being able to self-host a gateway is not direct hosting", () => {
  const result = verifyCandidate(
    newService,
    null,
    page("Nimbus GmbH makes a gateway you can self-host."),
  );
  assert.equal(result.band, "yellow");
  assert.deepEqual(result.tags, []);
});

test("an unread page leaves the operator unclear and the terms unchecked", () => {
  const result = verifyCandidate(relay, null, null);
  assert.equal(result.band, "yellow");
  assert.equal(result.operator, null);
  assert.equal(result.termsNote, "확인 못 함");
  assert.equal(result.termsUrl, null);
});

test("terms are recorded as found and never change the band", () => {
  const known = offer("Claim credits", "developers.openai.com");
  const verdicts = [
    verifyCandidate(known, OPENAI, null),
    verifyCandidate(known, OPENAI, page("Home")),
    verifyCandidate(known, OPENAI, page("Home", "https://openai.com/terms")),
  ];
  assert.deepEqual(
    verdicts.map(({ band, termsNote, termsUrl }) => [
      band,
      termsNote,
      termsUrl,
    ]),
    [
      ["green", "확인 못 함", null],
      ["green", "링크 없음", null],
      ["green", null, "https://openai.com/terms"],
    ],
  );
});

test("a stranger's repository name does not decide tags", () => {
  const result = verifyCandidate(
    { ...relay, evidence: "https://github.com/o/qwen-relay" },
    null,
    page("Sign up"),
  );
  assert.deepEqual(result.tags, ["#재판매"]);
});

test("no rule ever returns red", () => {
  const pages = [
    null,
    page("Scam. Key theft reported. 먹튀 피해 신고. Stolen keys, fake models."),
    page("Relay Labs, Inc. no markup"),
  ];
  for (const known of [null, OPENAI, VERCEL, APIYI])
    for (const candidate of [relay, newService, offer("50% off", "x.io")])
      for (const shown of pages)
        assert.match(
          verifyCandidate(candidate, known, shown).band,
          /^(?:green|yellow)$/,
        );
});

test("known operators match the domain and its subdomains only", () => {
  assert.equal(knownOperator("openai.com", [OPENAI]), OPENAI);
  assert.equal(knownOperator("developers.openai.com", [OPENAI]), OPENAI);
  assert.equal(knownOperator("notopenai.com", [OPENAI]), null);
  assert.equal(knownOperator("openai.com.evil.io", [OPENAI]), null);
  assert.equal(knownOperator(null, [OPENAI]), null);
});

test("every replayed real offer reaches its expected band", () => {
  const events = JSON.parse(
    readFileSync("tests/fixtures/discount-replay.json", "utf8"),
  ) as Array<{ id: string; title: string; body: string }>;
  const known: Record<string, [KnownOperator, "green" | "yellow"]> = {
    openai: [OPENAI, "green"],
    anthropic: [{ ...OPENAI, name: "Anthropic" }, "green"],
    deepseek: [{ ...OPENAI, name: "DeepSeek" }, "green"],
    vercel: [VERCEL, "yellow"],
    cloudflare: [{ ...VERCEL, service: "hosting" }, "yellow"],
    aws: [{ ...VERCEL, service: "hosting" }, "yellow"],
    apiyi: [APIYI, "yellow"],
  };
  for (const event of events) {
    const [operator, band] = known[event.id.split("-")[0]!]!;
    const result = verifyCandidate(
      {
        id: event.id,
        kind: "discount",
        route: "changelog",
        domain: operator.domain,
        title: event.title,
        evidence: event.body.slice(0, 600),
      },
      operator,
      null,
    );
    assert.equal(result.band, band, event.id);
  }
});

test("a report's own domain name says nothing about its price or models", () => {
  const result = verifyCandidate(
    {
      id: "3",
      kind: "discount",
      route: "report",
      domain: "cheaper-llama-3.ai",
      title: "cheaper-llama-3.ai",
      evidence: "",
    },
    null,
    page("Sign up now."),
  );
  assert.equal(result.priceCheck, "unknown");
  assert.deepEqual(result.tags, []);
  assert.equal(result.band, "yellow");
});

test("a board post is yellow and risky whatever it says about itself", () => {
  const result = verifyCandidate(
    {
      id: "9",
      kind: "discount",
      route: "community",
      domain: null,
      title: "Acme Inc. no markup, our own GPUs",
      evidence: "no markup",
    },
    { domain: "linux.do", name: "x", service: "official", tags: [] },
    null,
  );
  assert.equal(result.band, "yellow");
  assert.ok(result.tags.includes("#위험"));
});

test("a listed relay site is yellow, risky and resold whatever its page says", () => {
  const result = verifyCandidate(
    {
      id: "10",
      kind: "discount",
      route: "relay_list",
      domain: "relay.test",
      title: "Relay: 가입 $100",
      evidence: "a/b 목록에 새로 올라옴",
    },
    null,
    page("Acme Inc. no markup, our own GPUs"),
  );
  assert.equal(result.band, "yellow");
  assert.ok(result.tags.includes("#위험"));
  assert.ok(result.tags.includes("#재판매"));
});
