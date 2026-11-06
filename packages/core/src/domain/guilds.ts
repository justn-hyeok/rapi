import { templateCard, templateText } from "./card-template.js";
import { clip, type DiscordCard } from "./discord-card.js";
import { escapeMarkdown, plainLine } from "./discount-cards.js";

/** Shown to anyone using Rapi in a guild the operator has not approved. */
export const GUILD_NOT_ALLOWED_MESSAGE =
  "승인되지 않은 서버입니다. 서버 관리 권한이 있는 분이 /서버신청으로 라피 운영자에게 승인을 요청할 수 있어요.";

/** Shown when the allowed guilds could not be read: nothing passes until they can. */
export const GUILD_CHECK_FAILED_MESSAGE =
  "이 서버가 승인됐는지 확인하지 못했습니다. 잠시 뒤 다시 시도해 주세요.";

export const GUILD_REQUEST_COMMAND = "서버신청";
export const GUILD_REQUEST_REASON_MAX_CHARS = 100;
export const GUILD_NAME_MAX_CHARS = 100;
/** How long a guild no longer blocked waits before it may ask again. */
export const GUILD_REQUEST_WAIT_DAYS = 7;

export interface GuildRequestForCard {
  guildId: string;
  name: string | null;
  requesterId: string | null;
  reason: string | null;
}

/** One line of a stranger's text, safe to store: no controls, no scheme, short. */
export function cleanGuildText(
  value: string | undefined,
  limit: number,
): string | null {
  return clip(plainLine(value ?? ""), limit) || null;
}

/**
 * The owner's card. The name and reason are strangers' text, so they are escaped
 * again here: nothing in them can format, link or mention.
 */
export function guildRequestCard(request: GuildRequestForCard): DiscordCard {
  const text = (value: string, limit: number) =>
    escapeMarkdown(clip(plainLine(value), limit));
  return templateCard("guildRequest", {
    서버: request.name
      ? text(request.name, GUILD_NAME_MAX_CHARS)
      : templateText("guildNameUnknown"),
    서버ID: request.guildId,
    요청자: request.requesterId ? `<@${request.requesterId}>` : "",
    사유: request.reason
      ? text(request.reason, GUILD_REQUEST_REASON_MAX_CHARS)
      : "",
  });
}

/** Home guild: explicit setting, then the community guild, then the first allowed guild. */
export function resolveHomeGuildId(
  home: string | undefined,
  community: string | undefined,
  allowed: readonly string[] | undefined,
): string | undefined {
  return home ?? community ?? allowed?.[0];
}

/**
 * Guilds the bot answers in: the env list, approved guilds and the home guild.
 * This is a public bot, so with nothing configured it answers in no guild at all.
 */
export function allowedGuildIds(
  envIds: readonly string[] | undefined,
  approvedIds: readonly string[],
  homeGuildId?: string,
): string[] {
  return [
    ...new Set([
      ...(envIds ?? []),
      ...approvedIds,
      ...(homeGuildId ? [homeGuildId] : []),
    ]),
  ];
}

export function isGuildAllowed(
  guildId: string,
  allowed: readonly string[],
): boolean {
  return allowed.includes(guildId);
}

export interface FeedGuildTarget {
  guildId: string;
  /** When the guild was approved; null for env/home guilds that always receive. */
  allowedSince: Date | null;
}

/**
 * Guilds that should receive a post: not yet sent there, and not approved
 * after the post was created (no backlog for new guilds).
 */
export function selectFeedTargets(
  postCreatedAt: Date,
  guilds: readonly FeedGuildTarget[],
  alreadySent: ReadonlySet<string>,
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const guild of guilds) {
    if (alreadySent.has(guild.guildId) || seen.has(guild.guildId)) continue;
    if (guild.allowedSince && guild.allowedSince > postCreatedAt) continue;
    seen.add(guild.guildId);
    result.push(guild.guildId);
  }
  return result;
}

/** Caches the approved-guild lookup so every interaction does not hit the database. */
export function createGuildGate(options: {
  envIds: readonly string[] | undefined;
  homeGuildId: string | undefined;
  load: () => Promise<readonly string[]>;
  ttlMs?: number;
  now?: () => number;
}): {
  allowed(): Promise<string[]>;
  invalidate(): void;
} {
  const ttl = options.ttlMs ?? 15_000;
  const now = options.now ?? Date.now;
  let cached: { at: number; ids: string[] } | undefined;
  return {
    async allowed() {
      if (cached && now() - cached.at < ttl) return cached.ids;
      const ids = allowedGuildIds(
        options.envIds,
        await options.load(),
        options.homeGuildId,
      );
      cached = { at: now(), ids };
      return ids;
    },
    invalidate() {
      cached = undefined;
    },
  };
}
