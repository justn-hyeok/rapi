import {
  assertDiscordLevel,
  assertDiscordScope,
  describeGuildFeatures,
  discordOwnerIds,
  GUILD_NOT_ALLOWED_MESSAGE,
  guildFeatureChanged,
  guildFeatureRefusal,
  isGuildAllowed,
  isGuildFeature,
  resolveDiscordAccess,
  splitDiscordMessage,
  type DiscordAccessLevel,
  type DiscordAccessScope,
  type DiscordAllowlists,
  type DiscordIdentity,
  type GuildFeature,
} from "@rapi/domain";
import type { GuildFeatureSwitch } from "../guilds/features.js";
import type { NotificationChannels } from "../guilds/notification-channels.js";
import { SourceCollection } from "../sources/collection.js";
import type { ReportOptions } from "../discounts/reports.js";

export const slashCommands = [
  "sources",
  "status",
  "server_config",
  "report",
  "stars",
  "connections",
  "features",
  "guilds",
  "notification_channels",
] as const;

/** The feature each command belongs to. /기능 and /서버 have none: they have to stay reachable. */
const commandFeatures: Record<
  (typeof slashCommands)[number],
  GuildFeature | undefined
> = {
  sources: "status",
  status: "status",
  server_config: "server_config",
  report: "report",
  stars: "stars",
  // Connecting an account is not a server's feature to switch off.
  connections: undefined,
  features: undefined,
  guilds: undefined,
  notification_channels: undefined,
};

export interface DiscordCommand {
  name: (typeof slashCommands)[number];
  options: Record<string, unknown>;
}

export interface DiscordCommandResult {
  messages: string[];
  data?: Record<string, unknown>;
}

// Each person's own: anyone in an allowed server, and only from a server,
// since a DM needs a server shared with the bot.
const PERSONAL = new Set<DiscordCommand["name"]>(["stars", "connections"]);

export function requiredCommandAccess(
  command: DiscordCommand["name"],
): DiscordAccessLevel {
  if (PERSONAL.has(command) || command === "report") return "user";
  return command === "server_config" ||
    command === "features" ||
    command === "guilds"
    ? "superadmin"
    : "admin";
}

const guildScopedCommands: ReadonlySet<DiscordCommand["name"]> = new Set([
  "server_config",
]);

/** Slash names a guild-scoped admin can use in their own server. */
const GUILD_ADMIN_COMMAND_LABELS = ["/서버구성"];

/** Whether a command only changes the guild it runs in, or reaches all of Rapi. */
export function commandScope(
  command: DiscordCommand["name"],
): DiscordAccessScope {
  return guildScopedCommands.has(command) ? "guild" : "global";
}

function requiredString(
  options: Record<string, unknown>,
  name: string,
): string {
  const value = options[name];
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`Missing command option: ${name}`);
  return value;
}

function optionalString(
  options: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = options[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export class DiscordCommands {
  constructor(
    private readonly agent: SourceCollection,
    private readonly allowlists: DiscordAllowlists,
    private readonly operations?: {
      status: () => Promise<string>;
      serverConfig?: {
        preview(
          guildId: string,
          actorId: string,
        ): Promise<{ summary: string; planId: string }>;
        apply(
          guildId: string,
          actorId: string,
          planId: string,
        ): Promise<string>;
        export(guildId: string, format: "yaml" | "json"): Promise<string>;
      };
      report?: (
        identity: DiscordIdentity,
        options: ReportOptions,
      ) => Promise<string>;
      // Each person's own star reminders.
      stars?: (
        identity: DiscordIdentity,
        options: Record<string, unknown>,
      ) => Promise<string>;
      // Each person's own accounts on other services.
      connections?: (
        identity: DiscordIdentity,
        options: Record<string, unknown>,
      ) => Promise<string>;
      /** Guilds the bot answers in. */
      guildAllowlist?: () => Promise<readonly string[]>;
      guildFeatures?: GuildFeatureSwitch;
      notificationChannels?: Pick<NotificationChannels, "change">;
      changeGuild?: (
        actorId: string,
        action: string,
        target: string,
      ) => Promise<string>;
    },
  ) {}

  /** Throws the refusal when the feature is off in this guild. */
  async assertGuildFeature(
    guildId: string,
    feature: GuildFeature,
  ): Promise<void> {
    const features = await this.operations?.guildFeatures?.enabled(guildId);
    if (features && !features.has(feature))
      throw new Error(guildFeatureRefusal(feature));
  }

  // Owner only, whatever Discord permissions someone has in that server. Skips the
  // channel allowlist, so it cannot lock the owner out of another server.
  private async features(
    identity: DiscordIdentity,
    options: Record<string, unknown>,
  ): Promise<DiscordCommandResult> {
    if (!discordOwnerIds(this.allowlists).includes(identity.userId))
      throw new Error("소유자만 쓸 수 있는 명령입니다.");
    if (!identity.guildId) throw new Error("서버에서만 쓸 수 있는 명령입니다.");
    const features = this.operations?.guildFeatures;
    if (!features) throw new Error("서버별 기능이 설정되지 않았습니다.");
    const action = optionalString(options, "action") ?? "보기";
    let changed: string | undefined;
    if (action !== "보기") {
      if (action !== "켜기" && action !== "끄기")
        throw new Error("지원하지 않는 기능 동작입니다.");
      const feature = options.feature;
      if (!isGuildFeature(feature)) throw new Error("알 수 없는 기능입니다.");
      const enabled = action === "켜기";
      await features.set(identity.guildId, feature, enabled, identity.userId);
      changed = guildFeatureChanged(feature, enabled);
    }
    const summary = describeGuildFeatures(
      await features.enabled(identity.guildId),
      identity.guildId === this.allowlists.homeGuildId,
    );
    return { messages: [changed ? `${changed}\n\n${summary}` : summary] };
  }

  // Owner only, like /기능. The target is named, so it works from any allowed server.
  private async guilds(
    identity: DiscordIdentity,
    options: Record<string, unknown>,
  ): Promise<DiscordCommandResult> {
    if (!discordOwnerIds(this.allowlists).includes(identity.userId))
      throw new Error("소유자만 쓸 수 있는 명령입니다.");
    if (!this.operations?.changeGuild)
      throw new Error("서버 승인 기능이 설정되지 않았습니다.");
    return {
      messages: [
        await this.operations.changeGuild(
          identity.userId,
          requiredString(options, "action"),
          requiredString(options, "target"),
        ),
      ],
    };
  }

  async execute(
    identity: DiscordIdentity,
    command: DiscordCommand,
  ): Promise<DiscordCommandResult> {
    if (identity.guildId && this.operations?.guildAllowlist) {
      if (
        !isGuildAllowed(
          identity.guildId,
          await this.operations.guildAllowlist(),
        )
      )
        throw new Error(GUILD_NOT_ALLOWED_MESSAGE);
    }
    if (command.name === "features")
      return this.features(identity, command.options);
    if (command.name === "guilds")
      return this.guilds(identity, command.options);
    // Checks its own permissions: a server's admins set this without any Rapi role.
    if (command.name === "notification_channels") {
      const channels = this.operations?.notificationChannels;
      if (!channels) throw new Error("알림 채널이 설정되지 않았습니다.");
      return { messages: [await channels.change(identity, command.options)] };
    }
    const feature = commandFeatures[command.name];
    if (identity.guildId && feature)
      await this.assertGuildFeature(identity.guildId, feature);
    // Anyone in an allowed server may report or get star reminders; the channel
    // gate still applies.
    const anyMember = command.name === "report" || PERSONAL.has(command.name);
    if (command.name === "report" && !identity.guildId)
      throw new Error("제보는 서버에서만 보낼 수 있습니다.");
    // The DM needs a server shared with the bot, which a server command proves.
    if (PERSONAL.has(command.name) && !identity.guildId)
      throw new Error("라피가 있는 서버에서 해 주세요.");
    const access = resolveDiscordAccess(
      identity,
      anyMember
        ? { ...this.allowlists, guildMembersAreUsers: true }
        : this.allowlists,
    );
    const level = access.level;
    // A guild-scoped admin may run guild settings but nothing that reaches all of Rapi.
    const guildAdmin =
      access.scope === "guild" && commandScope(command.name) === "guild";
    let required = requiredCommandAccess(command.name);
    if (required !== "user" && commandScope(command.name) === "global")
      assertDiscordScope(access, "global", GUILD_ADMIN_COMMAND_LABELS);
    if (guildAdmin && required === "superadmin") required = "admin";
    assertDiscordLevel(level, required);
    const actorId = identity.userId;
    switch (command.name) {
      case "sources": {
        const rows = await this.agent.store.sourceStatus();
        return { messages: splitDiscordMessage(JSON.stringify(rows, null, 2)) };
      }
      case "status": {
        if (!this.operations)
          throw new Error("운영 상태 기능이 설정되지 않았습니다.");
        return {
          messages: splitDiscordMessage(await this.operations.status()),
        };
      }
      case "server_config": {
        if (!identity.guildId || !this.operations?.serverConfig)
          throw new Error("서버 구성 기능이 설정되지 않았습니다.");
        const action = optionalString(command.options, "action") ?? "미리보기";
        if (action === "미리보기") {
          const preview = await this.operations.serverConfig.preview(
            identity.guildId,
            actorId,
          );
          return {
            messages: splitDiscordMessage(preview.summary),
            data: {
              confirmationCustomId: `server_config_apply:${preview.planId}`,
            },
          };
        }
        if (action === "적용")
          return {
            messages: splitDiscordMessage(
              await this.operations.serverConfig.apply(
                identity.guildId,
                actorId,
                requiredString(command.options, "planId"),
              ),
            ),
          };
        if (action === "내보내기") {
          const format =
            optionalString(command.options, "format") === "json"
              ? "json"
              : "yaml";
          return {
            messages: splitDiscordMessage(
              await this.operations.serverConfig.export(
                identity.guildId,
                format,
              ),
            ),
          };
        }
        throw new Error("지원하지 않는 서버 구성 동작입니다.");
      }
      case "stars": {
        if (!this.operations?.stars)
          throw new Error("스타 알림이 설정되지 않았습니다.");
        return {
          messages: [await this.operations.stars(identity, command.options)],
        };
      }
      case "connections": {
        if (!this.operations?.connections)
          throw new Error("연결 기능이 설정되지 않았습니다.");
        return {
          messages: [
            await this.operations.connections(identity, command.options),
          ],
        };
      }
      case "report": {
        if (!this.operations?.report)
          throw new Error("제보 기능이 설정되지 않았습니다.");
        return {
          messages: [
            await this.operations.report(identity, {
              link: requiredString(command.options, "link"),
              kind: optionalString(command.options, "kind"),
              memo: optionalString(command.options, "memo"),
            }),
          ],
        };
      }
    }
  }
}
