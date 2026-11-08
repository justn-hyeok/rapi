import assert from "node:assert/strict";
import { test } from "node:test";
import { isPublicUrl } from "@rapi/core";
import { publicFetch } from "@rapi/adapters";

test("addresses that are not plainly public are refused without asking DNS", () => {
  for (const url of [
    "http://relay.io/",
    "https://127.0.0.1/",
    "https://2130706433/",
    "https://0x7f.0.0.1/",
    "https://169.254.169.254/latest/meta-data/",
    "https://10.0.0.8/",
    "https://[::1]/",
    "https://[::ffff:7f00:1]/",
    "https://localhost/",
    "https://localhost./",
    "https://foo.localhost/",
    "https://postgres/",
    "https://db.internal/",
    "https://printer.local/",
    "https://vm.tailnet-abc.ts.net/",
    "https://relay.io:5433/",
    "https://user:key@relay.io/",
    "file:///etc/passwd",
    "not a url",
  ])
    assert.equal(isPublicUrl(url), false, url);
  for (const url of ["https://relay.io/", "https://api.relay.co.kr/v1"])
    assert.equal(isPublicUrl(url), true, url);
});

const resolvesPublic = async () => ["93.184.216.34"];
const neverFetches = (async () => {
  throw new Error("must not connect");
}) as typeof fetch;

test("a public name that resolves to a private address is refused", async () => {
  for (const address of [
    "127.0.0.1",
    "10.1.2.3",
    "100.100.100.100",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "fd7a:115c:a1e0::1",
    "fe80::1%eth0",
    "unparseable",
  ])
    await assert.rejects(
      publicFetch(neverFetches, async () => ["93.184.216.34", address])(
        "https://rebind.relay.io/",
      ),
      /non-public/,
      address,
    );
  await assert.rejects(
    publicFetch(neverFetches, async () => [])("https://relay.io/"),
    /non-public/,
  );
});

test("a failed DNS lookup never connects", async () => {
  await assert.rejects(
    publicFetch(neverFetches, async () => {
      throw new Error("ENOTFOUND");
    })("https://relay.io/"),
    /ENOTFOUND/,
  );
});

test("a DNS lookup stops at the caller's timeout", async () => {
  const controller = new AbortController();
  const fetching = publicFetch(neverFetches, () => new Promise(() => {}))(
    "https://relay.io/",
    { signal: controller.signal },
  );
  controller.abort();
  await assert.rejects(fetching, /timed out/);
});

const redirect = (location: string) =>
  new Response(null, { status: 302, headers: { location } });

test("redirects are followed by hand and each hop is checked", async () => {
  const hops: Array<[string, RequestRedirect | undefined]> = [];
  const web = (async (url: string, init?: RequestInit) => {
    hops.push([url, init?.redirect]);
    return url === "https://relay.io/"
      ? redirect("/home")
      : new Response("arrived");
  }) as typeof fetch;
  const response = await publicFetch(web, resolvesPublic)("https://relay.io/");
  assert.equal(await response.text(), "arrived");
  assert.deepEqual(hops, [
    ["https://relay.io/", "manual"],
    ["https://relay.io/home", "manual"],
  ]);
});

test("a redirect to a private address is refused before connecting", async () => {
  for (const location of [
    "https://127.0.0.1/",
    "https://169.254.169.254/latest/meta-data/",
    "https://localhost/",
    "https://db.internal/",
    "http://relay.io/",
  ]) {
    const requested: string[] = [];
    const web = (async (url: string) => {
      requested.push(url);
      return redirect(location);
    }) as typeof fetch;
    await assert.rejects(
      publicFetch(web, resolvesPublic)("https://relay.io/"),
      /non-public/,
      location,
    );
    assert.deepEqual(requested, ["https://relay.io/"]);
  }
  // The name is public; the address it resolves to is not.
  const requested: string[] = [];
  await assert.rejects(
    publicFetch(
      (async (url: string) => {
        requested.push(url);
        return redirect("https://inner.relay.io/");
      }) as typeof fetch,
      async (hostname) =>
        hostname === "relay.io" ? ["93.184.216.34"] : ["10.0.0.1"],
    )("https://relay.io/"),
    /non-public/,
  );
  assert.deepEqual(requested, ["https://relay.io/"]);
});

test("a redirect loop ends", async () => {
  const web = (async () => redirect("https://relay.io/")) as typeof fetch;
  await assert.rejects(
    publicFetch(web, resolvesPublic)("https://relay.io/"),
    /Too many redirects/,
  );
});
