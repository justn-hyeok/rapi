import { loadEnvironment } from "@rapi/config";
import { resolveHomeGuildId } from "@rapi/domain";
import { PostgresStore } from "@rapi/db";
import { registerAllowedGuildCommands } from "../apps/bot/src/discord-http.js";

const config = loadEnvironment();
const store = new PostgresStore(config.DATABASE_URL);
const failures = await registerAllowedGuildCommands({
  applicationId: config.DISCORD_APPLICATION_ID,
  botToken: config.DISCORD_BOT_TOKEN,
  envGuildIds: config.DISCORD_ALLOWED_GUILD_IDS,
  homeGuildId: resolveHomeGuildId(
    config.DISCORD_HOME_GUILD_ID,
    config.COMMUNITY_GUILD_ID,
    config.DISCORD_ALLOWED_GUILD_IDS,
  ),
  loadApproved: async () =>
    (await store.allowedDiscordGuilds()).map((guild) => guild.guildId),
});
await store.close();
for (const failure of failures) process.stderr.write(`${failure}\n`);
if (failures.length) process.exitCode = 1;
else process.stdout.write("Discord slash commands를 등록했습니다.\n");
