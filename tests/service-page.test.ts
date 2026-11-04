import assert from "node:assert/strict";
import { test } from "node:test";
import { parseServicePage, readServicePage } from "@rapi/adapters";

const HTML = { "content-type": "text/html; charset=utf-8" };
const resolve = async () => ["93.184.216.34"];
const html = (body: string) => new Response(body, { headers: HTML });

const terms = (markup: string) =>
  parseServicePage(`<html><body>${markup}</body></html>`, "https://relay.io/")
    .termsUrl;

test("a terms link is found by its words or its address", () => {
  assert.equal(
    terms('<a href="/legal/a">Terms of Service</a>'),
    "https://relay.io/legal/a",
  );
  assert.equal(terms('<a href="/tos">Read</a>'), "https://relay.io/tos");
  assert.equal(
    terms('<a href="https://docs.relay.io/terms-of-use">x</a>'),
    "https://docs.relay.io/terms-of-use",
  );
  assert.equal(terms('<a href="/k">이용약관</a>'), "https://relay.io/k");
  assert.equal(terms('<a href="/k">用户协议</a>'), "https://relay.io/k");
});

test("a page with no terms link says so instead of guessing", () => {
  assert.equal(
    terms('<a href="/privacy">Privacy</a><a href="/">Home</a>'),
    null,
  );
  assert.equal(terms("<p>Terms of Service apply.</p>"), null);
  assert.equal(terms("<a>Terms</a>"), null);
});

test("a terms link keeps the address only and skips private ones", () => {
  assert.equal(
    terms('<a href="/terms?ref=abc123#top">Terms</a>'),
    "https://relay.io/terms",
  );
  assert.equal(
    terms(
      '<a href="https://10.0.0.1/terms">Terms</a><a href="http://relay.io/terms">Terms</a><a href="https://relay.io/tos">Terms</a>',
    ),
    "https://relay.io/tos",
  );
  assert.equal(terms('<a href="javascript:alert(1)">Terms</a>'), null);
  assert.equal(terms(`<a href="/terms/${"x".repeat(600)}">Terms</a>`), null);
});

test("page text leaves out scripts and keeps what people read", () => {
  const page = parseServicePage(
    '<script>var key="sk-secret"</script><footer>© 2026 Relay Labs, Inc.</footer>',
    "https://relay.io/",
  );
  assert.equal(page.text, "© 2026 Relay Labs, Inc.");
});

test("the request carries no key, and an API host falls back to its bare name", async () => {
  const seen: Array<[string, Record<string, string>]> = [];
  const web = (async (url: string, init?: RequestInit) => {
    seen.push([url, init?.headers as Record<string, string>]);
    return url === "https://relay.io/"
      ? html('<a href="/terms">Terms</a>')
      : new Response('{"status":"ok"}', {
          headers: { "content-type": "application/json" },
        });
  }) as typeof fetch;
  const page = await readServicePage("api.relay.io", { fetch: web, resolve });
  assert.equal(page?.termsUrl, "https://relay.io/terms");
  assert.deepEqual(
    seen.map(([url]) => url),
    ["https://api.relay.io/", "https://relay.io/"],
  );
  for (const [, headers] of seen)
    assert.deepEqual(Object.keys(headers).sort(), ["Accept", "User-Agent"]);
});

test("a page that cannot be read is null, however it fails", async () => {
  for (const web of [
    async () => new Response("no", { status: 403 }),
    async () =>
      new Response("{}", { headers: { "content-type": "text/json" } }),
    async () => {
      throw new Error("ECONNRESET");
    },
    async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://169.254.169.254/" },
      }),
  ])
    assert.equal(
      await readServicePage("relay.io", {
        fetch: web as unknown as typeof fetch,
        resolve,
      }),
      null,
    );
});

test("private and local names never reach DNS or the network", async () => {
  let reached = 0;
  for (const domain of [
    "localhost",
    "127.0.0.1",
    "postgres",
    "db.internal",
    "[::1]",
    "relay.io:5433",
    "user:key@relay.io",
  ])
    assert.equal(
      await readServicePage(domain, {
        fetch: (async () => {
          reached++;
          return html("");
        }) as typeof fetch,
        resolve: async () => {
          reached++;
          return ["93.184.216.34"];
        },
      }),
      null,
      domain,
    );
  assert.equal(reached, 0);
});

test("a body over the limit is cut, and the timeout comes through", async () => {
  let signal: AbortSignal | null | undefined;
  const web = (async (_url: string, init?: RequestInit) => {
    signal = init?.signal;
    return html(`<a href="/terms">Terms</a>${"x".repeat(5000)}`);
  }) as typeof fetch;
  const page = await readServicePage("relay.io", {
    fetch: web,
    resolve,
    maxBodyBytes: 1000,
  });
  assert.equal(page?.termsUrl, "https://relay.io/terms");
  assert.ok(page!.text.length <= 1000);
  assert.ok(signal);

  const stuck = (async (_url: string, init?: RequestInit) =>
    new Promise((_, reject) =>
      init?.signal?.addEventListener("abort", () =>
        reject(new Error("aborted")),
      ),
    )) as typeof fetch;
  assert.equal(
    await readServicePage("relay.io", {
      fetch: stuck,
      resolve,
      timeoutMs: 5,
    }),
    null,
  );
});
