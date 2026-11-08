import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { discordLayoutDependencies } from "@rapi/adapters";
import { DiscordLayoutManager } from "@rapi/application";
import { loadEnvironment } from "@rapi/config";
import {
  PostgresDatabase,
  PostgresDiscordLayoutStore,
  PostgresSourceStore,
} from "@rapi/adapters";
import { replaceEnvironmentValue } from "./update-discord-token.mjs";

const officialFeeds = [
  "https://openai.com/news/rss.xml",
  "https://github.blog/changelog/feed/",
  "https://blog.cloudflare.com/rss/",
  "https://supabase.com/rss.xml",
] as const;

async function updateEnvironment(
  values: Record<string, string>,
): Promise<void> {
  const target = resolve(process.env.RAPI_ENV_FILE ?? ".env");
  let contents = await readFile(target, "utf8");
  for (const [name, value] of Object.entries(values))
    contents = replaceEnvironmentValue(contents, name, value);
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

const config = loadEnvironment();
const guildId =
  config.COMMUNITY_GUILD_ID ?? config.DISCORD_ALLOWED_GUILD_IDS?.[0];
if (!guildId)
  throw new Error("COMMUNITY_GUILD_ID 또는 허용 guild ID가 필요합니다.");

const db = new PostgresDatabase(config.DATABASE_URL, {
  max: 2,
  connectionTimeoutMs: config.DB_CONNECT_TIMEOUT_MS,
  queryTimeoutMs: config.DB_QUERY_TIMEOUT_MS,
});
const layoutStore = new PostgresDiscordLayoutStore(db);
const layout = new DiscordLayoutManager(layoutStore, {
  ...discordLayoutDependencies(
    config.DISCORD_BOT_TOKEN,
    config.DISCORD_LAYOUT_FILE,
  ),
});
try {
  for (const feed of officialFeeds)
    await new PostgresSourceStore(db).createSource("rss", feed, "public");

  await updateEnvironment({
    COMMUNITY_GUILD_ID: guildId,
    POLL_INTERVAL_SECONDS: "900",
    DISCORD_GUILD_MEMBERS_ARE_USERS: "false",
    DISCORD_USER_ROLE_IDS: await layoutStore
      .managedDiscordResourceId(guildId, "role", "rapi_user")
      .then(
        (id) => id ?? Promise.reject(new Error("라피 USER 역할이 없습니다.")),
      ),
    DISCORD_ADMIN_ROLE_IDS: await layoutStore
      .managedDiscordResourceId(guildId, "role", "rapi_staff")
      .then(
        (id) => id ?? Promise.reject(new Error("라피 운영진 역할이 없습니다.")),
      ),
    OPERATIONS_CHANNEL_ID: await layout.channelId(guildId, "operations_alerts"),
  });
  process.stdout.write("커뮤니티 통합 구성을 저장했습니다.\n");
} finally {
  await db.close();
}
