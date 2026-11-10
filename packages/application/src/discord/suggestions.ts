import { escapeMarkdown } from "@rapi/domain";
import { type DiscordGateway } from "./ports.js";
import {
  signedLinkToken,
  validSignedLinkToken,
} from "../shared/signed-link.js";

export const SUGGESTION_MAX_CHARS = 1000;
export const SUGGESTIONS_PER_HOUR = 5;

const LINK_DAYS = 7;
const LINK_LABEL = "rapi help link";
const HOUR_MS = 3_600_000;

/**
 * The /help page and its suggestions: a public address to sign links for, the
 * owner's review channel to send them to, and in-memory send times for the
 * hourly limit. No database: the limit resets on restart, which is fine.
 */
export interface HelpSite {
  secret: string;
  baseUrl: string;
  reviewChannelId: () => Promise<string | undefined>;
  delivery: Pick<DiscordGateway, "send">;
  /** Send times in ms per person, for the hourly limit. */
  recent: Map<string, number[]>;
}

export type SuggestionOutcome =
  | "sent"
  | "empty"
  | "too_long"
  | "limited"
  | "no_channel"
  | "failed";

/** The /help address for one person, signed like a star interest link. */
export function helpPageUrl(
  site: Pick<HelpSite, "secret" | "baseUrl">,
  userId: string,
  now: Date,
): string {
  const token = signedLinkToken(
    site.secret,
    LINK_LABEL,
    userId,
    LINK_DAYS,
    now,
  );
  return `${site.baseUrl.replace(/\/+$/, "")}/help?u=${userId}&t=${token}`;
}

/** Whether the token is this person's and has not expired. */
export function validHelpToken(
  site: Pick<HelpSite, "secret">,
  userId: string | null,
  token: string | null,
  now: Date,
): boolean {
  return validSignedLinkToken(site.secret, LINK_LABEL, userId, token, now);
}

/** Drop one matching time, for when a counted send turned out not to send. */
function release(recent: number[], time: number): void {
  const index = recent.indexOf(time);
  if (index >= 0) recent.splice(index, 1);
}

/**
 * One suggestion to the owner's review channel. Never throws: every failure is
 * a named outcome the page can translate into a message.
 */
export async function sendSuggestion(
  site: HelpSite,
  userId: string,
  text: unknown,
  now: Date,
): Promise<SuggestionOutcome> {
  if (typeof text !== "string" || !text.trim()) return "empty";
  const trimmed = text.trim();
  if (trimmed.length > SUGGESTION_MAX_CHARS) return "too_long";
  const cutoff = now.getTime() - HOUR_MS;
  const time = now.getTime();
  // No await between the check and recording, so concurrent calls cannot all pass.
  const recent = (site.recent.get(userId) ?? []).filter((at) => at > cutoff);
  site.recent.set(userId, recent);
  if (recent.length >= SUGGESTIONS_PER_HOUR) return "limited";
  recent.push(time);
  let channelId: string | undefined;
  try {
    channelId = await site.reviewChannelId();
  } catch {
    release(recent, time);
    return "failed";
  }
  if (!channelId) {
    release(recent, time);
    return "no_channel";
  }
  try {
    await site.delivery.send(
      { channel: "discord_channel", recipientId: channelId },
      {
        subject: "건의",
        text: `**건의** <@${userId}>\n${escapeMarkdown(trimmed)}`,
        html: "",
        itemIds: [],
      },
      `suggestion:${userId}:${now.getTime()}`,
    );
    return "sent";
  } catch (error) {
    release(recent, time);
    process.stderr.write(
      `suggestion: ${error instanceof Error ? error.message.slice(0, 200) : "failed"}\n`,
    );
    return "failed";
  }
}
