import {
  ApiSummarizer,
  CodexSummarizer,
  DiscordDeliveryAdapter,
  FeedSourceAdapter,
  GitHubSourceAdapter,
  GitHubStarRecommender,
  HtmlSourceAdapter,
  createModelClient,
  superadminDmNotifier,
} from "@redhood/adapters";
import {
  DEFAULT_SUMMARY_MODEL,
  DiscordCommandService,
  DiscordLayoutManager,
  RedhoodAgent,
  createCommunityFeeds,
} from "@redhood/agent";
import {
  createGuildGate,
  GUILD_NOT_ALLOWED_MESSAGE,
  isGuildAllowed,
  resolveHomeGuildId,
  summarizeReadiness,
} from "@redhood/core";
import { loadEnvironment } from "@redhood/config";
import {
  compareMigrationNames,
  expectedMigrationNames,
  ModelUsageStore,
  PostgresStore,
} from "@redhood/db";
import { readFile } from "node:fs/promises";
import {
  createDiscordInteractionServer,
  registerSlashCommands,
} from "./discord-http.js";
import { assessSourceHealth } from "./source-health.js";

const config = loadEnvironment();
const store = new PostgresStore(config.DATABASE_URL, {
  max: config.DB_POOL_MAX,
  connectionTimeoutMs: config.DB_CONNECT_TIMEOUT_MS,
  queryTimeoutMs: config.DB_QUERY_TIMEOUT_MS,
});
const discord = new DiscordDeliveryAdapter(config.DISCORD_BOT_TOKEN);
const layout = new DiscordLayoutManager(store, {
  botToken: config.DISCORD_BOT_TOKEN,
  layoutFile: config.DISCORD_LAYOUT_FILE,
});
// Null unless MODEL_API_BASE_URL and MODEL_API_KEY are set; callers fall back to the CLI.
const modelClient = createModelClient(
  config,
  new ModelUsageStore(store),
  superadminDmNotifier(discord, config.DISCORD_SUPERADMIN_USER_IDS ?? []),
);
const summarizer =
  process.env.SUMMARY_MODEL === "off"
    ? undefined
    : config.SUMMARIZER_BACKEND === "api" && modelClient
      ? new ApiSummarizer(
          modelClient,
          `api:${config.MODEL_FOR_SUMMARY ?? config.MODEL_DEFAULT}`,
        )
      : new CodexSummarizer(process.env.SUMMARY_MODEL || DEFAULT_SUMMARY_MODEL);
const agent = new RedhoodAgent(store);
// The curation channels: AI blogs and free tokens.
const communityFeeds = config.COMMUNITY_GUILD_ID
  ? await createCommunityFeeds({
      store,
      summarizer,
      guildId: config.COMMUNITY_GUILD_ID,
      extraGuildIds: config.DISCORD_ALLOWED_GUILD_IDS ?? [],
      botToken: config.DISCORD_BOT_TOKEN,
      root: process.cwd(),
    })
  : undefined;
const feed = new FeedSourceAdapter();
const htmlList = new HtmlSourceAdapter();
const github = new GitHubSourceAdapter(config.GITHUB_READ_TOKEN);
const stars = new GitHubStarRecommender(config.GITHUB_READ_TOKEN);

const homeGuildId = resolveHomeGuildId(
  config.DISCORD_HOME_GUILD_ID,
  config.COMMUNITY_GUILD_ID,
  config.DISCORD_ALLOWED_GUILD_IDS,
);
// Guild membership is checked against the gate, which also covers approved guilds.
const guildGate = createGuildGate({
  envIds: config.DISCORD_ALLOWED_GUILD_IDS,
  homeGuildId,
  load: async () =>
    (await store.allowedDiscordGuilds()).map((guild) => guild.guildId),
});
const allowlists = {
  userIds: config.DISCORD_ALLOWED_USER_IDS,
  ...(config.DISCORD_SUPERADMIN_USER_IDS
    ? { superadminUserIds: config.DISCORD_SUPERADMIN_USER_IDS }
    : {}),
  ...(config.DISCORD_ADMIN_USER_IDS
    ? { adminUserIds: config.DISCORD_ADMIN_USER_IDS }
    : {}),
  ...(config.DISCORD_USER_IDS ? { userUserIds: config.DISCORD_USER_IDS } : {}),
  ...(config.DISCORD_ADMIN_ROLE_IDS
    ? { adminRoleIds: config.DISCORD_ADMIN_ROLE_IDS }
    : {}),
  ...(config.DISCORD_USER_ROLE_IDS
    ? { userRoleIds: config.DISCORD_USER_ROLE_IDS }
    : {}),
  guildMembersAreUsers: config.DISCORD_GUILD_MEMBERS_ARE_USERS,
  ...(homeGuildId ? { homeGuildId } : {}),
  ...(config.DISCORD_ALLOWED_CHANNEL_IDS
    ? { channelIds: config.DISCORD_ALLOWED_CHANNEL_IDS }
    : {}),
};
const commands = new DiscordCommandService(agent, allowlists, {
  guildAllowlist: () => guildGate.allowed(),
  status: async () => {
    try {
      const monitor = JSON.parse(
        await readFile(config.MONITOR_STATE_FILE, "utf8"),
      ) as {
        updatedAt: string;
        components: Array<{
          name: string;
          status: string;
          checkedAt: string;
          lastSuccessAt?: string;
          reason?: string;
          details?: Record<string, unknown>;
        }>;
      };
      const stale =
        Date.now() - new Date(monitor.updatedAt).getTime() >
        config.MONITOR_INTERVAL_SECONDS * 3000;
      return [
        `레드후드 상태: ${stale ? "확인 불가" : "감시 중"}`,
        ...monitor.components.map(
          (component) =>
            `${component.name}: ${stale ? "unknown" : component.status} · 확인 ${component.checkedAt}` +
            (component.lastSuccessAt
              ? ` · 최근 성공 ${component.lastSuccessAt}`
              : "") +
            (component.reason ? ` · ${component.reason}` : "") +
            (typeof component.details?.percent === "number" ||
            typeof component.details?.percent === "string"
              ? ` · DB ${component.details.percent}%`
              : ""),
        ),
      ].join("\n");
    } catch {
      // Fall back to a direct database check before the monitor has written state.
    }
    try {
      const health = await store.checkHealth();
      return `레드후드 상태: 정상\nDB 응답: ${health.latencyMs}ms\nDB 사용량: ${health.databaseBytes} bytes`;
    } catch {
      return "레드후드 상태: 확인 불가\nDB 연결을 확인하지 못했습니다.";
    }
  },
  serverConfig: {
    preview: (guildId, actorId) => layout.preview(guildId, actorId),
    apply: (guildId, actorId, planId) => layout.apply(guildId, actorId, planId),
    export: (_guildId, format) => layout.export(format),
  },
});

if (process.env.REGISTER_DISCORD_COMMANDS === "true") {
  await registerSlashCommands(
    config.DISCORD_APPLICATION_ID,
    config.DISCORD_BOT_TOKEN,
    homeGuildId,
  );
}

type LoopState = {
  running?: boolean;
  lastStartedAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
};
const loops: Record<"collection" | "curation", LoopState> = {
  collection: {},
  curation: {},
};

async function runLoop(
  name: keyof typeof loops,
  work: () => Promise<unknown>,
): Promise<void> {
  const state = loops[name];
  if (state.running) return;
  state.running = true;
  state.lastStartedAt = new Date().toISOString();
  try {
    await work();
    state.lastSuccessAt = new Date().toISOString();
    delete state.lastError;
  } catch (error) {
    state.lastError =
      error instanceof Error ? error.message.slice(0, 200) : "failed";
    process.stderr.write(`${name}: ${state.lastError}\n`);
  } finally {
    state.running = false;
  }
}

const collect = () =>
  agent.collectConfiguredSources(feed, github, stars, htmlList);

// Curation calls the model and can take minutes; it never delays the collection loop.
async function curate(): Promise<void> {
  const failures = await communityFeeds?.runOnce();
  if (failures?.length)
    throw new Error(`Curation feeds failed: ${failures.join("; ")}`);
}

const server = createDiscordInteractionServer(
  commands,
  config.DISCORD_PUBLIC_KEY,
  {
    component: async (identity, customId) => {
      if (!identity.guildId)
        throw new Error("서버에서만 사용할 수 있는 버튼입니다.");
      if (!isGuildAllowed(identity.guildId, await guildGate.allowed()))
        throw new Error(GUILD_NOT_ALLOWED_MESSAGE);
      if (customId === "redhood_verify:v1")
        return layout.verifyMember(identity.guildId, identity.userId);
      if (customId.startsWith("server_config_apply:")) {
        const result = await commands.execute(identity, {
          name: "server_config",
          options: {
            action: "적용",
            planId: customId.slice("server_config_apply:".length),
          },
        });
        return result.messages[0] ?? "서버 구성을 적용했습니다.";
      }
      throw new Error("알 수 없는 버튼입니다.");
    },
    readiness: async () => {
      try {
        const now = new Date();
        const [result, expectedMigrations, appliedMigrations, sources] =
          await Promise.all([
            store.checkHealth(),
            expectedMigrationNames(),
            store.appliedMigrationNames(),
            store.sourceStatus(),
          ]);
        const migrations = compareMigrationNames(
          expectedMigrations,
          appliedMigrations,
        );
        const sourceHealth = assessSourceHealth(
          sources.map((source) => ({
            kind: String(source.kind),
            active: source.state === "active",
            failureCount: Number(source.failure_count ?? 0),
            lastSuccessAt: source.last_success_at as Date | null,
          })),
        );
        return summarizeReadiness(
          [
            {
              name: "database",
              status: "ok",
              checkedAt: now.toISOString(),
              required: true,
              latencyMs: result.latencyMs,
              details: {
                databaseBytes: result.databaseBytes,
                clusterDatabaseBytes: result.clusterDatabaseBytes,
                differenceBytes:
                  result.clusterDatabaseBytes - result.databaseBytes,
              },
            },
            {
              name: "migrations",
              status: migrations.ok ? "ok" : "failed",
              checkedAt: now.toISOString(),
              required: true,
              details: {
                expected: expectedMigrations.length,
                applied: appliedMigrations.length,
                missing: migrations.missing,
                unexpected: migrations.unexpected,
              },
              ...(migrations.ok
                ? {}
                : {
                    reason:
                      "database migration set does not match this revision",
                  }),
            },
            {
              name: "sources",
              status: sourceHealth.status,
              checkedAt: now.toISOString(),
              required: true,
              details: {
                configured: sourceHealth.configured,
                failing: sourceHealth.failing,
                unsupported: sourceHealth.unsupported,
              },
              ...(sourceHealth.reason ? { reason: sourceHealth.reason } : {}),
            },
            ...Object.entries(loops).map(([name, state]) => ({
              name,
              status: state.lastError ? ("failed" as const) : ("ok" as const),
              checkedAt: state.lastStartedAt ?? now.toISOString(),
              required: name === "collection",
              ...(state.lastSuccessAt
                ? { lastSuccessAt: state.lastSuccessAt }
                : {}),
              ...(state.lastError ? { reason: state.lastError } : {}),
            })),
          ],
          now,
          config.POLL_INTERVAL_SECONDS * 2000,
        );
      } catch {
        return summarizeReadiness([
          {
            name: "database",
            status: "failed",
            checkedAt: new Date().toISOString(),
            required: true,
            reason: "database unavailable",
          },
        ]);
      }
    },
  },
);
server.listen(config.PORT, "127.0.0.1", () => {
  process.stdout.write(`redhood-bot listening on 127.0.0.1:${config.PORT}\n`);
});

void runLoop("collection", collect);
const collectionTimer = setInterval(
  () => void runLoop("collection", collect),
  config.POLL_INTERVAL_SECONDS * 1000,
);
const curationTimer = communityFeeds
  ? setInterval(() => void runLoop("curation", curate), 5 * 60_000)
  : undefined;

const shutdown = (): void => {
  clearInterval(collectionTimer);
  if (curationTimer) clearInterval(curationTimer);
  server.close(() => {
    void store.close().finally(() => process.exit(0));
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
