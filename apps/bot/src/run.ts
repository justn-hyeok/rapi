import {
  ApiSummarizer,
  CodexSummarizer,
  DiscordDeliveryAdapter,
  FeedSourceAdapter,
  GitHubSourceAdapter,
  GitHubStarRecommender,
  HtmlSourceAdapter,
  createModelClient,
  readLatestRapiRelease,
  readOwnStars,
  encryptSecret,
  decryptSecret,
  finishGitHubOAuth,
  githubAuthorizeUrl,
  revokeGitHubGrant,
  searchRepos,
  digTrails,
  followNeighbors,
  superadminDmNotifier,
} from "@rapi/adapters";
import {
  DEFAULT_SUMMARY_MODEL,
  DiscordCommandService,
  DiscordLayoutManager,
  RapiAgent,
  collectDiscountCandidates,
  createCommunityFeeds,
  changeGuild,
  announceRapiUpdate,
  createGuildFeatures,
  createNotificationChannels,
  discountCardButton,
  guildRequestButton,
  loadDiscountSources,
  problemCardButton,
  publishDiscountCard,
  receiveGuildRequest,
  receiveReport,
  remindEveryone,
  starCommand,
  type StarService,
  STAR_VOTE_PREFIX,
  starVoteButton,
  sendDiscountCards,
  sendGuildRequestCards,
  sendProblemCards,
  verifyDiscountCandidates,
  verifyReports,
} from "@rapi/agent";
import {
  allowedGuildIds,
  createGuildGate,
  discordOwnerIds,
  GUILD_NOT_ALLOWED_MESSAGE,
  isGuildAllowed,
  resolveHomeGuildId,
  summarizeReadiness,
  type PublicAlertKind,
} from "@rapi/core";
import { loadEnvironment } from "@rapi/config";
import {
  compareMigrationNames,
  expectedMigrationNames,
  ModelUsageStore,
  PostgresStore,
} from "@rapi/db";
import { readFile } from "node:fs/promises";
import { githubConnectPages } from "./github-connect-page.js";
import { starPages } from "./star-page.js";
import {
  clearGuildCommands,
  createDiscordInteractionServer,
  fetchGuildName,
  registerAllowedGuildCommands,
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
const agent = new RapiAgent(store);
const homeGuildId = resolveHomeGuildId(
  config.DISCORD_HOME_GUILD_ID,
  config.COMMUNITY_GUILD_ID,
  config.DISCORD_ALLOWED_GUILD_IDS,
);
const guildFeatures = createGuildFeatures({ store, homeGuildId });
// The curation channels: AI blogs and free tokens.
const communityFeeds = config.COMMUNITY_GUILD_ID
  ? await createCommunityFeeds({
      store,
      summarizer,
      guildId: config.COMMUNITY_GUILD_ID,
      extraGuildIds: config.DISCORD_ALLOWED_GUILD_IDS ?? [],
      guildFeatures,
      botToken: config.DISCORD_BOT_TOKEN,
      root: process.cwd(),
    })
  : undefined;
const feed = new FeedSourceAdapter();
const htmlList = new HtmlSourceAdapter();
const github = new GitHubSourceAdapter(config.GITHUB_READ_TOKEN);
const stars = new GitHubStarRecommender(config.GITHUB_READ_TOKEN);

const loadApprovedGuilds = async () =>
  (await store.allowedDiscordGuilds()).map((guild) => guild.guildId);
// Guild membership is checked against the gate, which also covers approved guilds.
const guildGate = createGuildGate({
  envIds: config.DISCORD_ALLOWED_GUILD_IDS,
  homeGuildId,
  load: loadApprovedGuilds,
});
if (!homeGuildId)
  process.stderr.write(
    "guilds: no home or allowed guild configured, every server is refused\n",
  );
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
const channels = createNotificationChannels({
  store,
  delivery: discord,
  ownerIds: discordOwnerIds(allowlists),
  homeGuildId,
  allowedGuilds: () => guildGate.allowed(),
  reviewFallback: config.DISCOUNT_REVIEW_CHANNEL_ID,
  publicFallback: config.DISCOUNT_PUBLIC_CHANNEL_ID,
});
const reviewChannelIds = async () => (await channels.review()).ids;
const guildRequests = {
  store,
  gate: guildGate,
  ownerIds: discordOwnerIds(allowlists),
  reviewChannelId: async () => (await channels.review()).guildRequest,
  reviewChannelIds,
  // Allowed by configuration, so a row cannot take them away.
  configuredGuildIds: allowedGuildIds(
    config.DISCORD_ALLOWED_GUILD_IDS,
    [],
    homeGuildId,
  ),
  commands: {
    register: (guildId: string) =>
      registerSlashCommands(
        config.DISCORD_APPLICATION_ID,
        config.DISCORD_BOT_TOKEN,
        guildId,
        homeGuildId,
      ),
    clear: (guildId: string) =>
      clearGuildCommands(
        config.DISCORD_APPLICATION_ID,
        config.DISCORD_BOT_TOKEN,
        guildId,
      ),
  },
  // Sends the card now unless a run is already going; the timer catches that one.
  onOpened: () => void runLoop("cards", sendCards),
};
const commands = new DiscordCommandService(agent, allowlists, {
  guildAllowlist: () => guildGate.allowed(),
  guildFeatures,
  notificationChannels: channels,
  changeGuild: (actorId, action, target) =>
    changeGuild(guildRequests, actorId, action, target),
  stars: (identity, options) => starCommand(starService, identity, options),
  report: (identity, options) =>
    receiveReport(
      {
        store,
        reviewChannelId: async () => (await channels.review()).report,
      },
      identity,
      options,
    ),
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
        `라피 상태: ${stale ? "확인 불가" : "감시 중"}`,
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
      return `라피 상태: 정상\nDB 응답: ${health.latencyMs}ms\nDB 사용량: ${health.databaseBytes} bytes`;
    } catch {
      return "라피 상태: 확인 불가\nDB 연결을 확인하지 못했습니다.";
    }
  },
  serverConfig: {
    preview: (guildId, actorId) => layout.preview(guildId, actorId),
    apply: (guildId, actorId, planId) => layout.apply(guildId, actorId, planId),
    export: (_guildId, format) => layout.export(format),
  },
});

// A guild that refuses, or a rate limit, never keeps the bot from starting.
if (process.env.REGISTER_DISCORD_COMMANDS === "true") {
  void registerAllowedGuildCommands({
    applicationId: config.DISCORD_APPLICATION_ID,
    botToken: config.DISCORD_BOT_TOKEN,
    envGuildIds: config.DISCORD_ALLOWED_GUILD_IDS,
    homeGuildId,
    loadApproved: loadApprovedGuilds,
  }).then((failures) => {
    for (const failure of failures)
      process.stderr.write(`command registration: ${failure}\n`);
  });
}

type LoopState = {
  running?: boolean;
  lastStartedAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
};
const loops: Record<
  "collection" | "curation" | "candidates" | "cards" | "stars",
  LoopState
> = {
  collection: {},
  curation: {},
  candidates: {},
  cards: {},
  stars: {},
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

// Recorded only; each source reports its own failures in /수집원. A source failing
// does not hold back checking the candidates already found.
async function collectCandidates(): Promise<void> {
  const sources = await loadDiscountSources(process.cwd());
  const failures = [
    ...(await collectDiscountCandidates({
      store,
      sources,
      githubToken: config.GITHUB_READ_TOKEN,
      // Lists and forums in Chinese go out in Korean.
      ...(summarizer?.translate && {
        translate: (texts: string[]) => summarizer.translate!(texts),
      }),
    })),
    ...(await verifyDiscountCandidates({
      store,
      operators: sources.operators,
      ...(summarizer?.translate && {
        translate: (texts: string[]) => summarizer.translate!(texts),
      }),
    })),
  ];
  if (failures.length)
    throw new Error(`Candidate sources failed: ${failures.join("; ")}`);
}

async function checkReports(): Promise<string[]> {
  try {
    const { operators } = await loadDiscountSources(process.cwd());
    return await verifyReports({ store, operators });
  } catch (error) {
    return [`reports: ${error instanceof Error ? error.message : "failed"}`];
  }
}

// Independent of the daily collection, so cards held back by the hourly limit
// still go out and a report does not wait a day. Without a channel nothing is sent.
async function sendCards(): Promise<void> {
  const review = await channels.review();
  const { guildRequest, report } = review;
  const target = { store, delivery: discord };
  // First, because someone is waiting and checking reports reads web pages.
  const failures = guildRequest
    ? await sendGuildRequestCards({
        ...target,
        channelId: guildRequest,
        guildName: (guildId) =>
          fetchGuildName(config.DISCORD_BOT_TOKEN, guildId),
      })
    : [];
  failures.push(...(await checkReports()));
  if (report)
    failures.push(
      ...(await sendProblemCards({ ...target, channelId: report })),
    );
  failures.push(
    ...(await sendDiscountCards({ ...target, channels: review })),
    ...(await announceRapiUpdate({
      ...target,
      channelIds: () => channels.publicChannels("rapi_update"),
      latestRelease: () => readLatestRapiRelease(),
    })),
  );
  if (failures.length)
    throw new Error(`Discount cards failed: ${failures.join("; ")}`);
}

// Star reminders go to each person's own DM, for the GitHub account they
// connected with /스타 through GitHub OAuth, read with the token they granted.
// The configured owner is connected from the environment, read with the
// deployment's token, and keeps the rows from before stars had owners.
const starOwnerId = config.DISCORD_SUPERADMIN_USER_IDS?.[0];
const starLogin = config.STAR_REMINDER_GITHUB_USER;
// The interest page needs a public address and a key to sign its links with.
const starSite =
  config.RAPI_PUBLIC_BASE_URL && config.WEBHOOK_ENCRYPTION_KEY
    ? {
        store,
        secret: config.WEBHOOK_ENCRYPTION_KEY,
        baseUrl: config.RAPI_PUBLIC_BASE_URL,
        defaultOwnerId: starOwnerId,
      }
    : undefined;
const githubApp =
  config.GITHUB_OAUTH_CLIENT_ID &&
  config.GITHUB_OAUTH_CLIENT_SECRET &&
  config.RAPI_PUBLIC_BASE_URL
    ? {
        clientId: config.GITHUB_OAUTH_CLIENT_ID,
        clientSecret: config.GITHUB_OAUTH_CLIENT_SECRET,
        redirectUri: `${config.RAPI_PUBLIC_BASE_URL.replace(/\/+$/, "")}/github/callback`,
      }
    : undefined;
const encryptionKey = config.WEBHOOK_ENCRYPTION_KEY;
const starService: StarService = {
  store,
  delivery: discord,
  github: {
    readStars: (login, token) => readOwnStars(login, token),
    digTrails: (seeds, token) => digTrails(seeds, token),
    followNeighbors: (logins, token) => followNeighbors(logins, token),
    searchRepos: (queries, token) => searchRepos(queries, token),
  },
  oauth:
    githubApp && encryptionKey
      ? {
          authorizeUrl: (state) => githubAuthorizeUrl(githubApp, state),
          finish: (code) => finishGitHubOAuth(githubApp, code),
          revoke: (token) => revokeGitHubGrant(githubApp, token),
          encrypt: (token) => encryptSecret(token, encryptionKey),
          decrypt: (value) => decryptSecret(value, encryptionKey),
          secret: encryptionKey,
        }
      : undefined,
  owner: starOwnerId
    ? { userId: starOwnerId, token: config.GITHUB_READ_TOKEN }
    : undefined,
  site: starSite,
  reads: new Map(),
};
let starsReady: Promise<void> | undefined;
const prepareStars = async () => {
  if (!starOwnerId) return;
  await store.adoptOwnerlessStars(starOwnerId);
  if (starLogin) await store.addStarSubscriber(starOwnerId, starLogin);
};

async function sendStarReminder(): Promise<void> {
  // Once per start, and again after a failure.
  starsReady ??= prepareStars().catch((error: unknown) => {
    starsReady = undefined;
    throw error;
  });
  await starsReady;
  const failures = await remindEveryone(starService);
  if (failures.length)
    throw new Error(`Star reminder failed: ${failures.join("; ")}`);
}

const discountApproval = {
  store,
  delivery: discord,
  ownerIds: discordOwnerIds(allowlists),
  reviewChannelIds,
  publicChannelIds: (kind: PublicAlertKind) => channels.publicChannels(kind),
};

const server = createDiscordInteractionServer(
  commands,
  config.DISCORD_PUBLIC_KEY,
  {
    guildGate,
    guildRequests: {
      request: (identity, reason) =>
        receiveGuildRequest(guildRequests, identity, reason),
      button: (identity, customId) =>
        guildRequestButton(guildRequests, identity, customId),
    },
    discountCards: {
      button: (identity, customId) =>
        discountCardButton(discountApproval, identity, customId),
      publish: (identity, customId, deadline) =>
        publishDiscountCard(discountApproval, identity, customId, deadline),
    },
    problemCards: {
      button: (identity, customId) =>
        problemCardButton(discountApproval, identity, customId),
    },
    ...(starSite && {
      starVotes: {
        prefix: STAR_VOTE_PREFIX,
        button: (
          identity: Parameters<typeof starVoteButton>[1],
          customId: string,
        ) => starVoteButton(starSite, identity, customId),
      },
      pages: async (method: string, url: URL, body: () => Promise<Buffer>) =>
        (await starPages(starSite)(method, url, body)) ??
        githubConnectPages(starService)(method, url),
    }),
    component: async (identity, customId) => {
      if (!identity.guildId)
        throw new Error("서버에서만 사용할 수 있는 버튼입니다.");
      if (!isGuildAllowed(identity.guildId, await guildGate.allowed()))
        throw new Error(GUILD_NOT_ALLOWED_MESSAGE);
      if (customId === "rapi_verify:v1") {
        await commands.assertGuildFeature(identity.guildId, "server_config");
        return layout.verifyMember(identity.guildId, identity.userId);
      }
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
              // A slower loop is not stale just because it has not run lately.
              checkedAt:
                name === "candidates" || name === "cards" || name === "stars"
                  ? now.toISOString()
                  : (state.lastStartedAt ?? now.toISOString()),
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
  process.stdout.write(`rapi-bot listening on 127.0.0.1:${config.PORT}\n`);
});

void runLoop("collection", collect);
const collectionTimer = setInterval(
  () => void runLoop("collection", collect),
  config.POLL_INTERVAL_SECONDS * 1000,
);
const curationTimer = communityFeeds
  ? setInterval(() => void runLoop("curation", curate), 5 * 60_000)
  : undefined;
const candidatesStart = setTimeout(
  () => void runLoop("candidates", collectCandidates),
  60_000,
);
const candidatesTimer = setInterval(
  () => void runLoop("candidates", collectCandidates),
  24 * 60 * 60_000,
);
void runLoop("cards", sendCards);
const cardsTimer = setInterval(
  () => void runLoop("cards", sendCards),
  10 * 60_000,
);
void runLoop("stars", sendStarReminder);
const starsTimer = setInterval(
  () => void runLoop("stars", sendStarReminder),
  10 * 60_000,
);

const shutdown = (): void => {
  clearInterval(collectionTimer);
  if (curationTimer) clearInterval(curationTimer);
  clearTimeout(candidatesStart);
  clearInterval(candidatesTimer);
  clearInterval(cardsTimer);
  clearInterval(starsTimer);
  server.close(() => {
    void store.close().finally(() => process.exit(0));
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
