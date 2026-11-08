import { discordLayoutPorts } from "@rapi/adapters";
import { DiscordLayoutManager } from "@rapi/application";
import { loadEnvironment } from "@rapi/config";
import { PostgresDatabase, PostgresDiscordLayoutStore } from "@rapi/adapters";

// Posts or refreshes the usage guide in #라피-도움말 without a layout apply.
const config = loadEnvironment();
const guildId =
  config.COMMUNITY_GUILD_ID ?? config.DISCORD_ALLOWED_GUILD_IDS?.[0];
if (!guildId)
  throw new Error("COMMUNITY_GUILD_ID 또는 허용 guild ID가 필요합니다.");
const db = new PostgresDatabase(config.DATABASE_URL, {
  max: 1,
  connectionTimeoutMs: config.DB_CONNECT_TIMEOUT_MS,
  queryTimeoutMs: config.DB_QUERY_TIMEOUT_MS,
});
try {
  await new DiscordLayoutManager(new PostgresDiscordLayoutStore(db), {
    ...discordLayoutPorts(config.DISCORD_BOT_TOKEN, config.DISCORD_LAYOUT_FILE),
  }).ensureHelpMessage(guildId);
  console.log("도움말을 게시했습니다.");
} finally {
  await db.close();
}
