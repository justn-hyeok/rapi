import {
  assertDiscordLevel,
  assertDiscordScope,
  GUILD_NOT_ALLOWED_MESSAGE,
  isGuildAllowed,
  resolveDiscordAccess,
  splitDiscordMessage,
  type DiscordAccessLevel,
  type DiscordAccessScope,
  type DiscordAllowlists,
  type DiscordIdentity,
} from "@rapi/core";
import { RapiAgent } from "./rapi-agent.js";

export const slashCommands = ["sources", "status", "server_config"] as const;

export interface DiscordCommand {
  name: (typeof slashCommands)[number];
  options: Record<string, unknown>;
}

export interface DiscordCommandResult {
  messages: string[];
  data?: Record<string, unknown>;
}

export function requiredCommandAccess(
  command: DiscordCommand["name"],
): DiscordAccessLevel {
  return command === "server_config" ? "superadmin" : "admin";
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

export class DiscordCommandService {
  constructor(
    private readonly agent: RapiAgent,
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
      /** Guilds the bot answers in; undefined means no restriction. */
      guildAllowlist?: () => Promise<readonly string[] | undefined>;
    },
  ) {}

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
    const access = resolveDiscordAccess(identity, this.allowlists);
    const level = access.level;
    // A guild-scoped admin may run guild settings but nothing that reaches all of Rapi.
    const guildAdmin =
      access.scope === "guild" && commandScope(command.name) === "guild";
    let required = requiredCommandAccess(command.name);
    if (required !== "user" && commandScope(command.name) === "global")
      assertDiscordScope(access, "global", GUILD_ADMIN_COMMAND_LABELS);
    if (guildAdmin && required === "superadmin") required = "admin";
    assertDiscordLevel(level, required);
    const ownerId = identity.userId;
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
            ownerId,
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
                ownerId,
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
    }
  }
}
