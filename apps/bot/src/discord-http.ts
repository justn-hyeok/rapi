import { createPublicKey, verify } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { DiscordCommandService, type DiscordCommand } from "@redhood/agent";
import { runtimeRevision } from "@redhood/core";
import { redactChat } from "@redhood/contracts";

const ed25519SpkiPrefix = Buffer.from("302a300506032b6570032100", "hex");

export function verifyDiscordRequest(
  publicKeyHex: string,
  signatureHex: string,
  timestamp: string,
  body: Buffer,
): boolean {
  const key = createPublicKey({
    key: Buffer.concat([ed25519SpkiPrefix, Buffer.from(publicKeyHex, "hex")]),
    format: "der",
    type: "spki",
  });
  return verify(
    null,
    Buffer.concat([Buffer.from(timestamp), body]),
    key,
    Buffer.from(signatureHex, "hex"),
  );
}

const stringOption = (name: string, description: string, required = true) => ({
  type: 3,
  name,
  description,
  required,
});

export const discordCommandAliases = {
  수집원: "sources",
  상태: "status",
  서버구성: "server_config",
} as const satisfies Record<string, DiscordCommand["name"]>;

export const slashCommandDefinitions = [
  { name: "수집원", description: "수집원 상태를 확인합니다", type: 1 },
  { name: "상태", description: "레드후드 운영 상태를 확인합니다", type: 1 },
  {
    name: "서버구성",
    description: "Discord 채널 구성을 관리합니다",
    type: 1,
    options: [
      {
        type: 1,
        name: "미리보기",
        description: "변경 목록과 10분 적용 버튼을 만듭니다",
      },
      {
        type: 1,
        name: "적용",
        description: "미리보기 계획 ID를 적용합니다",
        options: [stringOption("계획", "미리보기에서 받은 계획 ID")],
      },
      {
        type: 1,
        name: "내보내기",
        description: "현재 원본 구성을 YAML 또는 JSON으로 봅니다",
        options: [stringOption("형식", "yaml 또는 json", false)],
      },
    ],
  },
] satisfies Array<{
  name: string;
  description: string;
  type: number;
  options?: Array<Record<string, unknown>>;
}>;

export async function registerSlashCommands(
  applicationId: string,
  botToken: string,
  guildId?: string,
): Promise<void> {
  const scope = guildId
    ? `/applications/${applicationId}/guilds/${guildId}/commands`
    : `/applications/${applicationId}/commands`;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const response = await fetch(`https://discord.com/api/v10${scope}`, {
      method: "PUT",
      headers: {
        authorization: `Bot ${botToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(slashCommandDefinitions),
    });
    if (response.ok) {
      await response.arrayBuffer();
      return;
    }
    const body = (await response.json().catch(() => ({}))) as {
      message?: string;
      retry_after?: number;
    };
    if (response.status === 429 && attempt < 4) {
      const delayMs = Math.min(
        30_000,
        Math.max(1000, (body.retry_after ?? 1) * 1000),
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      continue;
    }
    throw new Error(
      `Discord command registration failed: ${response.status}${body.message ? ` ${body.message}` : ""}`,
    );
  }
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > 1_000_000) throw new Error("Discord interaction exceeds 1 MB");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

export function createDiscordInteractionServer(
  service: DiscordCommandService,
  publicKey: string,
  integrations?: {
    readiness?: () => Promise<unknown>;
    component?: (
      identity: {
        userId: string;
        guildId?: string;
        channelId?: string;
        roleIds?: string[];
        guildPermissions?: string;
      },
      customId: string,
    ) => Promise<string>;
  },
) {
  return createServer(async (request, response) => {
    let verifiedInteraction = false;
    try {
      if (request.method === "GET" && request.url === "/health")
        return json(response, 200, { status: "ok" });
      if (request.method === "GET" && request.url === "/ready") {
        if (!integrations?.readiness)
          return json(response, 503, { status: "unavailable" });
        const ready = await integrations.readiness();
        const isReady =
          !!ready &&
          typeof ready === "object" &&
          "ready" in ready &&
          (ready as { ready: unknown }).ready === true;
        return json(response, isReady ? 200 : 503, {
          ...(ready && typeof ready === "object" ? ready : {}),
          revision: runtimeRevision,
        });
      }
      if (request.method !== "POST")
        return json(response, 404, { error: "not found" });
      const body = await readBody(request);
      if (request.url !== "/interactions")
        return json(response, 404, { error: "not found" });
      const signature = request.headers["x-signature-ed25519"];
      const timestamp = request.headers["x-signature-timestamp"];
      if (
        typeof signature !== "string" ||
        typeof timestamp !== "string" ||
        !verifyDiscordRequest(publicKey, signature, timestamp, body)
      ) {
        return json(response, 401, { error: "invalid signature" });
      }
      const interaction = JSON.parse(body.toString("utf8")) as {
        id?: string;
        type: number;
        application_id?: string;
        token?: string;
        member?: {
          user?: { id?: string };
          roles?: string[];
          permissions?: string;
        };
        user?: { id?: string };
        guild_id?: string;
        channel_id?: string;
        data?: {
          name?: string;
          custom_id?: string;
          components?: Array<{
            components?: Array<{ custom_id?: string; value?: string }>;
          }>;
          options?: Array<{ name: string; value: unknown }>;
        };
      };
      verifiedInteraction = true;
      if (interaction.type === 1) return json(response, 200, { type: 1 });
      const userId = interaction.member?.user?.id ?? interaction.user?.id;
      if (!userId) return json(response, 400, { error: "invalid interaction" });
      const identity = {
        userId,
        ...(interaction.guild_id ? { guildId: interaction.guild_id } : {}),
        ...(interaction.channel_id
          ? { channelId: interaction.channel_id }
          : {}),
        ...(interaction.member?.roles
          ? { roleIds: interaction.member.roles }
          : {}),
        ...(interaction.member?.permissions
          ? { guildPermissions: interaction.member.permissions }
          : {}),
      };
      if (interaction.type === 3 && interaction.data?.custom_id) {
        if (!integrations?.component)
          return json(response, 400, { error: "component unavailable" });
        if (
          interaction.data.custom_id.startsWith("server_config_apply:") &&
          interaction.application_id &&
          interaction.token
        ) {
          json(response, 200, { type: 5, data: { flags: 64 } });
          void integrations
            .component(identity, interaction.data.custom_id)
            .then(async (message) => {
              const update = await fetch(
                `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`,
                {
                  method: "PATCH",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    content: message,
                    allowed_mentions: { parse: [] },
                  }),
                },
              );
              await update.arrayBuffer();
            })
            .catch(async (error: unknown) => {
              const update = await fetch(
                `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`,
                {
                  method: "PATCH",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    content:
                      error instanceof Error
                        ? error.message
                        : "서버 구성 적용 실패",
                    allowed_mentions: { parse: [] },
                  }),
                },
              );
              await update.arrayBuffer();
            });
          return;
        }
        const message = await integrations.component(
          identity,
          interaction.data.custom_id,
        );
        return json(response, 200, {
          type: 4,
          data: { content: message, flags: 64 },
        });
      }
      if (!interaction.data?.name)
        return json(response, 400, { error: "invalid interaction" });
      const commandName = (
        discordCommandAliases as Record<
          string,
          DiscordCommand["name"] | undefined
        >
      )[interaction.data.name];
      if (!commandName)
        return json(response, 400, { error: "unknown interaction command" });
      const suppliedOptions = interaction.data.options ?? [];
      const subcommand = suppliedOptions[0] as
        | {
            name?: string;
            type?: number;
            options?: Array<{ name: string; value: unknown }>;
          }
        | undefined;
      const leafOptions =
        subcommand?.type === 1 ? (subcommand.options ?? []) : suppliedOptions;
      const options = Object.fromEntries(
        leafOptions.map((option) => [option.name, option.value]),
      );
      if (subcommand?.type === 1) options.action = subcommand.name;
      const aliases: Record<string, string> = {
        계획: "planId",
        형식: "format",
      };
      for (const [discordName, internalName] of Object.entries(aliases)) {
        if (options[discordName] !== undefined) {
          options[internalName] = options[discordName];
        }
      }
      if (interaction.id) options.requestId = interaction.id;
      const command = { name: commandName, options };
      if (
        commandName === "server_config" &&
        options.action === "적용" &&
        interaction.application_id &&
        interaction.token
      ) {
        json(response, 200, { type: 5, data: { flags: 64 } });
        void service
          .execute(identity, command)
          .then(async (result) => {
            const update = await fetch(
              `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`,
              {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  content: result.messages[0] ?? "완료",
                  allowed_mentions: { parse: [] },
                }),
              },
            );
            await update.arrayBuffer();
            if (!update.ok) throw new Error("Discord deferred reply failed");
            for (const content of result.messages.slice(1)) {
              const followup = await fetch(
                `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}`,
                {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    content,
                    flags: 64,
                    allowed_mentions: { parse: [] },
                  }),
                },
              );
              await followup.arrayBuffer();
              if (!followup.ok) throw new Error("Discord follow-up failed");
            }
          })
          .catch(async (error: unknown) => {
            const update = await fetch(
              `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`,
              {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  content:
                    error instanceof Error ? error.message : "요청 처리 실패",
                  allowed_mentions: { parse: [] },
                }),
              },
            );
            await update.arrayBuffer();
          })
          .catch(() =>
            process.stderr.write(
              "Discord deferred response could not be delivered\n",
            ),
          );
        return;
      }
      const result = await service.execute(identity, command);
      const confirmationCustomId = result.data?.confirmationCustomId;
      const components =
        typeof confirmationCustomId === "string"
          ? [
              {
                type: 1,
                components: [
                  {
                    type: 2,
                    style: 4,
                    label: "서버 구성 적용",
                    custom_id: confirmationCustomId,
                  },
                ],
              },
            ]
          : undefined;
      json(response, 200, {
        type: 4,
        data: {
          content: result.messages[0] ?? "완료",
          flags: 64,
          ...(components ? { components } : {}),
          allowed_mentions: { parse: [] },
        },
      });
      if (
        result.messages.length > 1 &&
        interaction.application_id &&
        interaction.token
      ) {
        void (async () => {
          for (const content of result.messages.slice(1)) {
            const followup = await fetch(
              `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}`,
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  content,
                  flags: 64,
                  allowed_mentions: { parse: [] },
                }),
              },
            );
            await followup.arrayBuffer();
          }
        })().catch(() => undefined);
      }
      return;
    } catch (error) {
      if (verifiedInteraction && !response.headersSent)
        return json(response, 200, {
          type: 4,
          data: {
            content: redactChat(
              error instanceof Error ? error.message : "요청 처리 실패",
            ).slice(0, 2_000),
            flags: 64,
            allowed_mentions: { parse: [] },
          },
        });
      return json(response, 400, {
        error: error instanceof Error ? error.message : "request failed",
      });
    }
  });
}
