import { createPublicKey, verify } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  GUILD_APPROVE_PREFIX,
  GUILD_BLOCK_PREFIX,
  DISCOUNT_DEADLINE_INPUT,
  DISCOUNT_DISCARD_PREFIX,
  DISCOUNT_MODAL_PREFIX,
  DISCOUNT_PUBLISH_PREFIX,
  DiscordCommandService,
  PROBLEM_CLEAR_PREFIX,
  PROBLEM_RED_PREFIX,
  type DiscordCommand,
  type DiscountPublishResult,
} from "@rapi/agent";
import {
  allowedGuildIds,
  isGuildAllowed,
  GUILD_CHECK_FAILED_MESSAGE,
  GUILD_FEATURES,
  GUILD_NOT_ALLOWED_MESSAGE,
  GUILD_REQUEST_COMMAND,
  GUILD_REQUEST_REASON_MAX_CHARS,
  ALERT_COMMANDS,
  REVIEW_ALERT_COMMAND,
  REVIEW_ALERT_KINDS,
  REPORT_MEMO_MAX_CHARS,
  runtimeRevision,
  type DiscordIdentity,
} from "@rapi/core";
import { redactChat } from "@rapi/contracts";

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
  제보: "report",
  기능: "features",
  서버: "guilds",
  "ai-할인-알림": "notification_channels",
  "새-서비스-알림": "notification_channels",
  "라피-업데이트-알림": "notification_channels",
  "검토-알림": "notification_channels",
} as const satisfies Record<string, DiscordCommand["name"]>;

const featureOption = {
  ...stringOption("기능", "바꿀 기능"),
  choices: GUILD_FEATURES.map(({ key, label }) => ({
    name: label,
    value: key,
  })),
};

const guildTargetOption = stringOption("서버", "서버 ID");

const reviewKindOption = {
  ...stringOption("종류", "검토 알림 종류"),
  choices: REVIEW_ALERT_KINDS.map(({ key, label }) => ({
    name: label,
    value: key,
  })),
};

// Discord hides these from members without Manage Server; checked again on arrival.
const alertCommand = (
  name: string,
  description: string,
  kindOptions: Array<Record<string, unknown>> = [],
) => ({
  name,
  description,
  type: 1,
  default_member_permissions: "32",
  options: [
    {
      type: 1,
      name: "켜기",
      description: "알림을 받을 채널을 정합니다",
      options: [
        ...kindOptions,
        {
          type: 7,
          name: "채널",
          description: "받을 채널. 비우면 지금 채널",
          required: false,
          channel_types: [0, 5],
        },
      ],
    },
    {
      type: 1,
      name: "끄기",
      description: "이 알림을 더 받지 않습니다",
      options: kindOptions,
    },
    {
      type: 1,
      name: "보기",
      description: "받는 채널을 봅니다",
      options: kindOptions,
    },
  ],
});

export const slashCommandDefinitions = [
  { name: "수집원", description: "수집원 상태를 확인합니다", type: 1 },
  { name: "상태", description: "라피 운영 상태를 확인합니다", type: 1 },
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
  {
    name: "제보",
    description: "AI 서비스 링크를 라피에게 알려 줍니다",
    type: 1,
    options: [
      stringOption("링크", "https 링크"),
      {
        ...stringOption("종류", "고르지 않으면 할인", false),
        choices: [
          { name: "할인", value: "discount" },
          { name: "새 서비스", value: "new_service" },
          { name: "문제", value: "problem" },
        ],
      },
      {
        ...stringOption("메모", "소유자에게 전할 짧은 메모", false),
        max_length: REPORT_MEMO_MAX_CHARS,
      },
    ],
  },
  {
    name: "기능",
    description: "이 서버에서 켠 기능을 보고 바꿉니다. 소유자만 쓸 수 있습니다",
    type: 1,
    options: [
      { type: 1, name: "보기", description: "켜고 끈 기능을 봅니다" },
      {
        type: 1,
        name: "켜기",
        description: "기능을 켭니다",
        options: [featureOption],
      },
      {
        type: 1,
        name: "끄기",
        description: "기능을 끕니다",
        options: [featureOption],
      },
    ],
  },
  {
    name: "서버",
    description: "다른 서버를 승인하거나 차단합니다. 소유자만 쓸 수 있습니다",
    type: 1,
    options: [
      {
        type: 1,
        name: "승인",
        description: "서버를 승인하고 명령을 등록합니다",
        options: [guildTargetOption],
      },
      {
        type: 1,
        name: "차단",
        description: "서버를 차단하고 명령을 지웁니다",
        options: [guildTargetOption],
      },
      {
        type: 1,
        name: "해제",
        description: "차단을 풉니다. 승인되지는 않습니다",
        options: [guildTargetOption],
      },
    ],
  },
  ...ALERT_COMMANDS.map(({ name, about }) =>
    alertCommand(name, `${about}을 받을 채널을 정합니다`),
  ),
  alertCommand(
    REVIEW_ALERT_COMMAND,
    "검토 카드를 받을 채널을 정합니다. 소유자가 홈 서버에서만 쓸 수 있습니다",
    [reviewKindOption],
  ),
] satisfies Array<{
  name: string;
  description: string;
  type: number;
  default_member_permissions?: string;
  options?: Array<Record<string, unknown>>;
}>;

/**
 * All a server sees before it is approved: global commands reach any server that adds
 * the bot, so nothing else goes here. Discord hides it from members without Manage
 * Server and from DMs; the request is still checked when it arrives.
 */
export const globalCommandDefinitions = [
  {
    name: GUILD_REQUEST_COMMAND,
    description: "이 서버에서 라피를 쓸 수 있게 운영자에게 승인을 요청합니다",
    type: 1,
    contexts: [0],
    integration_types: [0],
    default_member_permissions: "32",
    options: [
      {
        ...stringOption("사유", "운영자에게 전할 짧은 사유", false),
        max_length: GUILD_REQUEST_REASON_MAX_CHARS,
      },
    ],
  },
];

async function putCommands(
  applicationId: string,
  botToken: string,
  guildId: string | undefined,
  definitions: readonly unknown[],
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
      body: JSON.stringify(definitions),
      signal: AbortSignal.timeout(15_000),
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

/** What an approved guild sees. Only the owner sets review alerts, and only at home. */
export function guildCommandDefinitions(
  guildId: string,
  homeGuildId: string | undefined,
) {
  return guildId === homeGuildId
    ? slashCommandDefinitions
    : slashCommandDefinitions.filter(
        (command) => command.name !== REVIEW_ALERT_COMMAND,
      );
}

/** A guild gets its commands; without one, only what an unapproved server may see. */
export function registerSlashCommands(
  applicationId: string,
  botToken: string,
  guildId?: string,
  homeGuildId?: string,
): Promise<void> {
  return putCommands(
    applicationId,
    botToken,
    guildId,
    guildId
      ? guildCommandDefinitions(guildId, homeGuildId)
      : globalCommandDefinitions,
  );
}

/** The name isn't in the interaction. Only a guild the bot is in can answer this. */
export async function fetchGuildName(
  botToken: string,
  guildId: string,
): Promise<string | null> {
  try {
    const response = await fetch(
      `https://discord.com/api/v10/guilds/${guildId}`,
      {
        headers: { authorization: `Bot ${botToken}` },
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (!response.ok) {
      await response.arrayBuffer();
      return null;
    }
    const { name } = (await response.json()) as { name?: unknown };
    return typeof name === "string" ? name : null;
  } catch {
    return null;
  }
}

/** Takes a blocked guild's commands away. */
export function clearGuildCommands(
  applicationId: string,
  botToken: string,
  guildId: string,
): Promise<void> {
  return putCommands(applicationId, botToken, guildId, []);
}

/**
 * Replaces the global commands and registers in every allowed guild, returning what
 * failed. One failing never stops the next, and without approved guilds the env list
 * and home guild still go.
 */
export async function registerAllowedGuildCommands(input: {
  applicationId: string;
  botToken: string;
  envGuildIds: readonly string[] | undefined;
  homeGuildId: string | undefined;
  loadApproved: () => Promise<readonly string[]>;
}): Promise<string[]> {
  const failures: string[] = [];
  const reason = (error: unknown) =>
    error instanceof Error ? error.message.slice(0, 200) : "failed";
  let approved: readonly string[] = [];
  try {
    approved = await input.loadApproved();
  } catch (error) {
    failures.push(`approved guilds: ${reason(error)}`);
  }
  const guildIds = allowedGuildIds(
    input.envGuildIds,
    approved,
    input.homeGuildId,
  );
  for (const guildId of [undefined, ...guildIds]) {
    try {
      await registerSlashCommands(
        input.applicationId,
        input.botToken,
        guildId,
        input.homeGuildId,
      );
    } catch (error) {
      failures.push(`${guildId ?? "global"}: ${reason(error)}`);
    }
  }
  return failures;
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

// A modal's answer is sent only after the acknowledgement, through its own token.
async function deliverDiscountResult(
  interaction: { application_id: string; token: string },
  result: DiscountPublishResult,
): Promise<void> {
  const webhook = `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}`;
  const send = async (path: string, method: string, body: object) => {
    const response = await fetch(`${webhook}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, allowed_mentions: { parse: [] } }),
      signal: AbortSignal.timeout(15_000),
    });
    await response.arrayBuffer();
    if (!response.ok) throw new Error(`Discord returned ${response.status}`);
  };
  const [edit, notice] = await Promise.allSettled([
    result.edit && send("/messages/@original", "PATCH", result.edit),
    result.notice && send("", "POST", { content: result.notice, flags: 64 }),
  ]);
  for (const outcome of [edit, notice])
    if (outcome.status === "rejected") throw outcome.reason;
}

export function createDiscordInteractionServer(
  service: DiscordCommandService,
  publicKey: string,
  integrations?: {
    readiness?: () => Promise<unknown>;
    /** Checked before any handler, so none of them has to remember it. */
    guildGate?: { allowed(): Promise<readonly string[]> };
    guildRequests?: {
      request: (
        identity: DiscordIdentity,
        reason: string | undefined,
      ) => Promise<string>;
      button: (
        identity: DiscordIdentity,
        customId: string,
      ) => Promise<DiscountPublishResult>;
    };
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
    discountCards?: {
      button: (identity: DiscordIdentity, customId: string) => Promise<unknown>;
      publish: (
        identity: DiscordIdentity,
        customId: string,
        deadline: string,
      ) => Promise<DiscountPublishResult>;
    };
    problemCards?: {
      button: (identity: DiscordIdentity, customId: string) => Promise<unknown>;
    };
    starVotes?: {
      prefix: string;
      button: (identity: DiscordIdentity, customId: string) => Promise<unknown>;
    };
    /** The owner's star interest page, under /stars. Answers null for other paths. */
    pages?: (
      method: string,
      url: URL,
      body: () => Promise<Buffer>,
    ) => Promise<{ status: number; type: string; body: string } | null>;
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
      if (integrations?.pages) {
        const page = await integrations.pages(
          request.method ?? "GET",
          new URL(request.url ?? "/", "http://rapi.local"),
          () => readBody(request),
        );
        if (page) {
          response.writeHead(page.status, {
            "content-type": `${page.type}; charset=utf-8`,
            "cache-control": "no-store",
            "referrer-policy": "no-referrer",
            "x-frame-options": "DENY",
            ...(page.type === "text/html" && {
              "content-security-policy":
                "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'",
            }),
          });
          response.end(page.body);
          return;
        }
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
      // The one thing a server may do before it is allowed.
      if (
        interaction.type === 2 &&
        interaction.data?.name === GUILD_REQUEST_COMMAND &&
        integrations?.guildRequests
      ) {
        const reason = interaction.data.options?.find(
          (option) => option.name === "사유",
        )?.value;
        return json(response, 200, {
          type: 4,
          data: {
            content: await integrations.guildRequests.request(
              identity,
              typeof reason === "string" ? reason : undefined,
            ),
            flags: 64,
            allowed_mentions: { parse: [] },
          },
        });
      }
      if (interaction.guild_id && integrations?.guildGate) {
        const refusal = await integrations.guildGate.allowed().then(
          (allowed) =>
            isGuildAllowed(interaction.guild_id!, allowed)
              ? undefined
              : GUILD_NOT_ALLOWED_MESSAGE,
          () => GUILD_CHECK_FAILED_MESSAGE,
        );
        if (refusal)
          return json(response, 200, {
            type: 4,
            data: {
              content: refusal,
              flags: 64,
              allowed_mentions: { parse: [] },
            },
          });
      }
      const customId = interaction.data?.custom_id ?? "";
      // Registering commands can take longer than Discord waits, so this is answered first.
      if (
        interaction.type === 3 &&
        integrations?.guildRequests &&
        (customId.startsWith(GUILD_APPROVE_PREFIX) ||
          customId.startsWith(GUILD_BLOCK_PREFIX)) &&
        interaction.application_id &&
        interaction.token
      ) {
        json(response, 200, { type: 6 });
        const webhook = {
          application_id: interaction.application_id,
          token: interaction.token,
        };
        void integrations.guildRequests
          .button(identity, customId)
          .then((result) => deliverDiscountResult(webhook, result))
          .catch(() =>
            process.stderr.write(
              "Guild request result could not be delivered\n",
            ),
          );
        return;
      }
      const discountCards = integrations?.discountCards;
      if (
        interaction.type === 3 &&
        discountCards &&
        (customId.startsWith(DISCOUNT_PUBLISH_PREFIX) ||
          customId.startsWith(DISCOUNT_DISCARD_PREFIX))
      )
        return json(
          response,
          200,
          await discountCards.button(identity, customId),
        );
      if (
        interaction.type === 3 &&
        integrations?.problemCards &&
        (customId.startsWith(PROBLEM_RED_PREFIX) ||
          customId.startsWith(PROBLEM_CLEAR_PREFIX))
      )
        return json(
          response,
          200,
          await integrations.problemCards.button(identity, customId),
        );
      if (
        interaction.type === 3 &&
        integrations?.starVotes &&
        customId.startsWith(integrations.starVotes.prefix)
      )
        return json(
          response,
          200,
          await integrations.starVotes.button(identity, customId),
        );
      // Sending can take longer than Discord waits, so this is answered first.
      if (
        interaction.type === 5 &&
        discountCards &&
        customId.startsWith(DISCOUNT_MODAL_PREFIX) &&
        interaction.application_id &&
        interaction.token
      ) {
        json(response, 200, { type: 6 });
        const deadline =
          interaction.data?.components
            ?.flatMap((row) => row.components ?? [])
            .find((field) => field.custom_id === DISCOUNT_DEADLINE_INPUT)
            ?.value ?? "";
        const webhook = {
          application_id: interaction.application_id,
          token: interaction.token,
        };
        void discountCards
          .publish(identity, customId, deadline)
          .then((result) => deliverDiscountResult(webhook, result))
          .catch(() =>
            process.stderr.write(
              "Discount card result could not be delivered\n",
            ),
          );
        return;
      }
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
        링크: "link",
        종류: "kind",
        메모: "memo",
        기능: "feature",
        서버: "target",
        채널: "channel",
      };
      for (const [discordName, internalName] of Object.entries(aliases)) {
        if (options[discordName] !== undefined) {
          options[internalName] = options[discordName];
        }
      }
      // The command decides what it changes; only /검토-알림 has a choice to make.
      const alert = ALERT_COMMANDS.find(
        ({ name }) => name === interaction.data?.name,
      );
      if (alert) options.kind = alert.kind;
      if (interaction.id) options.requestId = interaction.id;
      const command = { name: commandName, options };
      if (
        ((commandName === "server_config" && options.action === "적용") ||
          commandName === "guilds" ||
          commandName === "notification_channels") &&
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
