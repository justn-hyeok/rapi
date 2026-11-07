import { createHmac, timingSafeEqual } from "node:crypto";
import {
  facetCatalog,
  repoFacets,
  type DiscordIdentity,
  type Interests,
} from "@rapi/core";
import type { PostgresStore } from "@rapi/db";
import { STAR_VOTE_PREFIX } from "./star-reminders.js";

// A link in today's DM keeps working for a week, so an old message still opens it.
const LINK_DAYS = 7;
const DAY_MS = 86_400_000;
const MAX_FACETS = 3000;
const FACET_KEY = /^[^:\s][^:]{0,20}:.{1,100}$/u;

type InterestStore = Pick<
  PostgresStore,
  | "currentStars"
  | "starInterests"
  | "saveStarInterests"
  | "saveStarVote"
  | "starRepo"
>;

export interface StarInterestPage {
  store: InterestStore;
  ownerId: string;
  // A key only this deployment has. The link is signed with a key derived from it.
  secret: string;
  baseUrl: string;
}

const linkKey = (secret: string) =>
  createHmac("sha256", secret).update("rapi star interest link").digest();

const signature = (secret: string, ownerId: string, expires: number) =>
  createHmac("sha256", linkKey(secret))
    .update(`${ownerId}.${expires}`)
    .digest("base64url");

/** The page's address with a token that names the owner and expires in a week. */
export function starInterestUrl(page: StarInterestPage, now: Date): string {
  const expires = Math.floor((now.getTime() + LINK_DAYS * DAY_MS) / 1000);
  const token = `${expires}.${signature(page.secret, page.ownerId, expires)}`;
  return `${page.baseUrl.replace(/\/+$/, "")}/stars?t=${token}`;
}

/** Whether a token is this owner's and has not expired. */
export function validStarToken(
  page: StarInterestPage,
  token: string | null,
  now: Date,
): boolean {
  const [expiresText, given] = (token ?? "").split(".");
  const expires = Number(expiresText);
  if (!given || !Number.isInteger(expires) || expires * 1000 < now.getTime())
    return false;
  const expected = Buffer.from(signature(page.secret, page.ownerId, expires));
  const actual = Buffer.from(given);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Every facet the owner's stars have, with what they picked so far. */
export async function starInterestData(page: StarInterestPage, now: Date) {
  const [stars, saved] = await Promise.all([
    page.store.currentStars(),
    page.store.starInterests(page.ownerId),
  ]);
  return {
    stars: stars.length,
    catalog: facetCatalog(stars, now),
    picked: saved.picked,
    votes: saved.votes.length,
  };
}

/** Keeps only well-formed keys at -1, -0.5, 0.5 or 1; a zero is not stored. */
export function cleanInterests(body: unknown): Interests {
  const facets = (body as { facets?: unknown } | null)?.facets;
  if (!facets || typeof facets !== "object" || Array.isArray(facets))
    throw new Error("facets must be an object");
  const entries = Object.entries(facets as Record<string, unknown>);
  if (entries.length > MAX_FACETS) throw new Error("too many facets");
  const clean: Record<string, number> = {};
  for (const [key, weight] of entries)
    if (
      FACET_KEY.test(key) &&
      typeof weight === "number" &&
      [-1, -0.5, 0.5, 1].includes(weight)
    )
      clean[key] = weight;
  return clean;
}

export async function saveStarInterestChoices(
  page: StarInterestPage,
  body: unknown,
): Promise<number> {
  const facets = cleanInterests(body);
  await page.store.saveStarInterests(page.ownerId, facets);
  return Object.keys(facets).length;
}

const ephemeral = (content: string) => ({
  type: 4,
  data: { content, flags: 64, allowed_mentions: { parse: [] } },
});

/** A thumb on a reminder card: only the owner's counts, with the repository's facets now. */
export async function starVoteButton(
  page: StarInterestPage,
  identity: DiscordIdentity,
  customId: string,
  now = new Date(),
) {
  if (identity.userId !== page.ownerId)
    return ephemeral("스타 알림을 받는 사람만 누를 수 있습니다.");
  const rest = customId.slice(STAR_VOTE_PREFIX.length);
  const vote = rest.startsWith("1:") ? 1 : rest.startsWith("-1:") ? -1 : 0;
  const fullName = rest.slice(rest.indexOf(":") + 1);
  if (!vote || !fullName) return ephemeral("알 수 없는 버튼입니다.");
  try {
    const repo = await page.store.starRepo(fullName);
    if (!repo) return ephemeral("이 저장소 기록을 찾지 못했습니다.");
    await page.store.saveStarVote(
      page.ownerId,
      repo.fullName,
      vote,
      repoFacets(repo, now).slice(0, 60),
    );
    return ephemeral(
      vote > 0
        ? `👍 ${repo.fullName}: 비슷한 걸 더 보내겠습니다.`
        : `👎 ${repo.fullName}: 다시 보내지 않고, 비슷한 것도 덜 보냅니다.`,
    );
  } catch {
    return ephemeral("기록하지 못했습니다. 잠시 뒤 다시 눌러 주세요.");
  }
}
