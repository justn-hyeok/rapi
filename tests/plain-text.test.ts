import assert from "node:assert/strict";
import { test } from "node:test";
import { plainText, summarize } from "@redhood/core";

const htmlBody =
  '<p>Article URL: <a href="https://x.test/a">https://x.test/a</a></p> <p>Comments URL: <a href="https://x.test/c">c</a></p>';

test("plainText decodes escaped markup before dropping it", () => {
  assert.equal(
    plainText("&lt;div class=&quot;x&quot;&gt;Fix &amp;amp; ship&lt;/div&gt;"),
    "Fix & ship",
  );
  assert.equal(plainText("a &lt;!-- c --&gt; b"), "a b");
  assert.equal(plainText("Fast &amp; Local Agents"), "Fast & Local Agents");
});

test("plainText keeps angle brackets that are not HTML tags", () => {
  assert.equal(plainText("1 < 2 and 3 > 2"), "1 < 2 and 3 > 2");
  assert.equal(
    plainText("Agents <ship> and Vec<String>"),
    "Agents <ship> and Vec<String>",
  );
});

test("the stored rule summary is plain text", () => {
  const summary = summarize({ title: "t", body: htmlBody });
  assert.ok(!/[<>]/.test(summary));
  assert.match(summary, /^Article URL: https:\/\/x\.test\/a/);
});
