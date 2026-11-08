import assert from "node:assert/strict";
import { test } from "node:test";
import { closeTruncatedFeed, FeedSource, parseFeed } from "@rapi/adapters";

test("accepts an HTML DOCTYPE inside item CDATA content", () => {
  const xml = `<?xml version="1.0"?><rss><channel><item><guid>1</guid><link>https://example.invalid/1</link><title>Release</title><content:encoded><![CDATA[<!DOCTYPE html><p>Body</p>]]></content:encoded></item></channel></rss>`;
  assert.equal(parseFeed(xml).length, 1);
});

test("rejects a document type declaration outside CDATA", () => {
  const xml = `<?xml version="1.0"?><!DOCTYPE rss [<!ENTITY x "y">]><rss><channel><item><guid>1</guid><title>&x;</title></item></channel></rss>`;
  assert.throws(() => parseFeed(xml), /DOCTYPE is not allowed/);
});

test("reads the start of a feed longer than the byte limit", async () => {
  const entry = (id: number) =>
    `<entry><id>${id}</id><title>Post ${id}</title><link href="https://x.test/${id}"/><summary>s</summary></entry>`;
  const atom = `<feed>${[1, 2, 3, 4].map(entry).join("")}</feed>`;
  const seen: string[] = [];
  const adapter = new FeedSource({
    maxBodyBytes: entry(1).length * 2 + 20,
    truncate: true,
    fetch: async (url) => {
      seen.push(url as string);
      return new Response(atom);
    },
  });
  const { items } = await adapter.fetch("https://x.test/atom");
  assert.deepEqual(seen, ["https://x.test/atom"]);
  assert.deepEqual(
    items.map((item) => item.title),
    ["Post 1", "Post 2"],
  );
  const rss =
    "<rss><channel><item><guid>1</guid><title>One</title></item><item><guid>2</guid><ti";
  assert.equal(parseFeed(closeTruncatedFeed(rss))[0]?.title, "One");
  assert.equal(parseFeed(closeTruncatedFeed(rss)).length, 1);
});

test("keeps inline XHTML and CDATA Atom content as body text", () => {
  const [xhtml, cdata] = parseFeed(
    `<feed><entry><id>1</id><title>A</title><content type="xhtml"><div xmlns="x"><p>50% <b>off</b></p></div></content></entry>
     <entry><id>2</id><title>B</title><content type="html"><![CDATA[<p>Body</p>]]></content></entry></feed>`,
  );
  assert.match(xhtml!.body, /<p>50% <b>off<\/b><\/p>/);
  assert.equal(cdata!.body, "<p>Body</p>");
});
