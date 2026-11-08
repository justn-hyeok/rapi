import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sourceParsers } from "@rapi/adapters";
import { CommunityFeeds, RapiAgent } from "@rapi/application";
import { PostgresStore } from "@rapi/adapters";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).pathname !== "/rapi_test")
  throw new Error("Curation E2E requires rapi_test");

describe("curation feeds", () => {
  it("posts each feed once to its managed channel and skips missing channels", async () => {
    const store = new PostgresStore(databaseUrl);
    const agent = new RapiAgent(store, sourceParsers);
    try {
      await store.resetForTests();
      await store.pool.query("DELETE FROM community_posts");
      await store.pool.query(
        "DELETE FROM discord_managed_resources WHERE guild_id='g'",
      );
      const posts: Array<{
        channel: string;
        embeds: Array<Record<string, unknown>>;
      }> = [];
      let models = [
        {
          id: "a:free",
          name: "A",
          supported_parameters: ["tools"],
          pricing: { prompt: "0", completion: "0" },
        },
        { id: "paid", pricing: { prompt: "1", completion: "1" } },
      ];
      const feeds = new CommunityFeeds(
        store,
        {
          policy: "t",
          summarize: async (items) =>
            new Map(items.map((i) => [i.id, `요약 ${i.title}`])),
        },
        {
          guildId: "g",
          autoPost: { "ai-blogs": true, "free-tokens": true },
          getText: async () => {
            throw new Error("no network in tests");
          },
          post: async (channel, embeds) => {
            posts.push({ channel, embeds });
            return String(posts.length);
          },
          getJson: async (url) => {
            if (url.includes("openrouter")) return { data: models };
            return [];
          },
        },
      );
      const now = new Date();
      // No channels yet: nothing is posted, but free models are remembered.
      await feeds.runOnce(now);
      assert.equal(posts.length, 0);

      for (const [key, id] of [
        ["curation_ai_blogs", "c-ai"],
        ["curation_free_tokens", "c-free"],
      ])
        await store.pool.query(
          "INSERT INTO discord_managed_resources(guild_id,resource_type,resource_key,discord_id,last_applied_digest) VALUES('g','channel',$1,$2,'test')",
          [key, id],
        );
      await store.pool.query("DELETE FROM community_posts");
      const source = await agent.createSource(
        "rss",
        "https://official.example/feed",
        "public",
      );
      await store.pool.query(
        `UPDATE sources SET collection_policy=collection_policy||'{"official":"true","label":"Official"}'::jsonb WHERE id=$1`,
        [source],
      );
      const hn = await agent.createSource(
        "rss",
        "https://hn.example/feed",
        "public",
      );
      await agent.ingestExternalItem(
        source,
        {
          externalId: "o1",
          url: "https://official.example/post",
          title: "Big launch",
          body: "Launch body",
          author: null,
          publishedAt: now.toISOString(),
          metadata: {},
        },
        now,
      );
      await agent.ingestExternalItem(
        hn,
        {
          externalId: "h1",
          url: "https://official.example/post",
          title: "Big launch (discussion)",
          body: "",
          author: null,
          publishedAt: now.toISOString(),
          metadata: {},
        },
        now,
      );
      await agent.ingestExternalItem(
        hn,
        {
          externalId: "h2",
          url: "https://x.example/credits",
          title: "Vendor gives free credits to students",
          body: "",
          author: null,
          publishedAt: now.toISOString(),
          metadata: {},
        },
        now,
      );

      const morning = new Date(new Date().setUTCHours(1, 0, 0, 0)); // 10:00 KST
      await feeds.runOnce(morning);
      const byChannel = (id: string) => posts.filter((p) => p.channel === id);
      assert.equal(byChannel("c-ai").length, 1);
      assert.match(JSON.stringify(byChannel("c-ai")[0]!.embeds), /다룬 곳 1/);
      // The legend, one free model, and one piece of free news: a card each.
      assert.equal(byChannel("c-free").length, 3);
      assert.match(JSON.stringify(byChannel("c-free")), /띠 색깔 보는 법/);
      assert.match(JSON.stringify(byChannel("c-free")), /"title":"A"/);

      const before = posts.length;
      models = [
        ...models,
        {
          id: "b:free",
          name: "B",
          supported_parameters: ["tools"],
          pricing: { prompt: "0", completion: "0" },
        },
      ];
      await store.pool.query(
        "DELETE FROM community_posts WHERE starts_with(key,'free-models:')",
      );
      await feeds.runOnce(morning);
      // The new card waits for the next hourly batch.
      assert.equal(posts.length, before);
      await store.pool.query(
        "DELETE FROM community_posts WHERE starts_with(key,'free-tokens:cards:')",
      );
      await feeds.runOnce(morning);
      const fresh = posts.slice(before);
      assert.equal(fresh.length, 1);
      assert.match(JSON.stringify(fresh[0]!.embeds), /"title":"B"/);
      assert.equal(
        (
          await store.pool.query(
            "SELECT 1 FROM community_posts WHERE state='draft' AND starts_with(key,'card:')",
          )
        ).rowCount,
        0,
      );
    } finally {
      await store.close();
    }
  });
});
