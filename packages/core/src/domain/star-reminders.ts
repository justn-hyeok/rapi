import { templateCard } from "./card-template.js";
import { clip, type DiscordCard } from "./discord-card.js";
import { kstDateKey } from "./curation.js";
import { cardLink, escapeMarkdown, plainLine } from "./discount-cards.js";
import {
  aboutLiked,
  interestFit,
  interestReason,
  type Interests,
  type RepoFacts,
} from "./star-interests.js";

/** One of the owner's stars, as GitHub reports it today. */
export interface GitHubStar {
  fullName: string;
  url: string;
  description: string;
  language: string | null;
  stars: number;
  archived: boolean;
  starredAt: string;
  // What the interest page sorts by. Rows stored before it have none.
  topics?: readonly string[];
  pushedAt?: string | null;
  createdAt?: string | null;
  ownerType?: string | null;
  license?: string | null;
}

export interface StoredStar
  extends Omit<GitHubStar, "starredAt" | "pushedAt" | "createdAt"> {
  pushedAt?: Date | string | null;
  createdAt?: Date | string | null;
  starredAt: Date;
  lastRemindedAt: Date | null;
}

const DAY_MS = 86_400_000;
const FORGOTTEN_AFTER_DAYS = 30;
const REMIND_AGAIN_AFTER_DAYS = 180;
// Randomness only among the ones that waited longest, so old stars still come first.
const PICK_WINDOW = 20;

export const STAR_DESCRIPTION_MAX_CHARS = 300;
// The longest label Discord accepts on a button.
const BUTTON_LABEL_MAX_CHARS = 80;

/** Starred over 30 days ago, not reminded for 180 days, and not archived. */
export function isForgottenStar(star: StoredStar, now: Date): boolean {
  const age = (date: Date) => now.getTime() - date.getTime();
  return (
    !star.archived &&
    age(star.starredAt) > FORGOTTEN_AFTER_DAYS * DAY_MS &&
    (!star.lastRemindedAt ||
      age(star.lastRemindedAt) > REMIND_AGAIN_AFTER_DAYS * DAY_MS)
  );
}

/** One or two stars for today: longest since a reminder first, then oldest star. */
export function pickForgottenStars(
  stars: readonly StoredStar[],
  now: Date,
  random: () => number = Math.random,
): StoredStar[] {
  const window = stars
    .filter((star) => isForgottenStar(star, now))
    .sort(
      (a, b) =>
        (a.lastRemindedAt?.getTime() ?? 0) -
          (b.lastRemindedAt?.getTime() ?? 0) ||
        a.starredAt.getTime() - b.starredAt.getTime(),
    )
    .slice(0, PICK_WINDOW);
  const count = random() < 0.5 ? 1 : 2;
  const picked: StoredStar[] = [];
  while (window.length > 0 && picked.length < count) {
    const [star] = window.splice(Math.floor(random() * window.length), 1);
    picked.push(star!);
  }
  return picked;
}

/** A repository for today and which of the owner's interests it fits. */
export interface StarPick<T extends RepoFacts = StoredStar> {
  repo: T;
  reason: string;
}

// The best few are shuffled, so the same star does not win every morning.
const INTEREST_WINDOW = 5;

/**
 * The forgotten star that fits the owner's interests best, or none when no
 * star is about anything they like. Ties go to the one waited longest.
 */
export function pickInterestingStar(
  stars: readonly StoredStar[],
  interests: Interests,
  now: Date,
  random: () => number = Math.random,
): StarPick | null {
  const ranked = stars
    .filter((star) => isForgottenStar(star, now))
    .map((star) => ({ star, ...interestFit(star, interests, now) }))
    .filter((entry) => entry.score > 0 && aboutLiked(entry.liked))
    .sort(
      (a, b) =>
        b.score - a.score ||
        (a.star.lastRemindedAt?.getTime() ?? 0) -
          (b.star.lastRemindedAt?.getTime() ?? 0),
    )
    .slice(0, INTEREST_WINDOW);
  if (ranked.length === 0) return null;
  const chosen = ranked[Math.floor(random() * ranked.length)]!;
  return { repo: chosen.star, reason: interestReason(chosen.liked) };
}

/** The best new repository from a search, skipping any the owner has seen. */
export function pickFoundRepo<T extends RepoFacts>(
  found: readonly T[],
  seen: ReadonlySet<string>,
  interests: Interests,
  now: Date,
): StarPick<T> | null {
  const best = found
    .filter((repo) => !seen.has(repo.fullName.toLowerCase()))
    .map((repo) => ({ repo, ...interestFit(repo, interests, now) }))
    .filter((entry) => entry.score > 0 && aboutLiked(entry.liked))
    .sort((a, b) => b.score - a.score || b.repo.stars - a.repo.stars)[0];
  return best ? { repo: best.repo, reason: interestReason(best.liked) } : null;
}

/** A repository a search found, which the owner never starred. */
export function foundRepoCard(
  repo: RepoFacts & { url: string },
  reason: string,
): DiscordCard {
  return templateCard(
    "starFound",
    {
      저장소: escapeMarkdown(plainLine(repo.fullName)),
      설명: escapeMarkdown(
        clip(plainLine(repo.description), STAR_DESCRIPTION_MAX_CHARS),
      ),
      언어: repo.language ? escapeMarkdown(plainLine(repo.language)) : "",
      별: repo.stars.toLocaleString("en-US"),
      이유: escapeMarkdown(clip(plainLine(reason), 160)),
    },
    { url: cardLink(repo.url) },
  );
}

/** The repository's own words are a stranger's, so they show as plain text. */
export function starCard(star: StoredStar, reason = ""): DiscordCard {
  return templateCard(
    "star",
    {
      이유: escapeMarkdown(clip(plainLine(reason), 160)),
      저장소: escapeMarkdown(plainLine(star.fullName)),
      설명: escapeMarkdown(
        clip(plainLine(star.description), STAR_DESCRIPTION_MAX_CHARS),
      ),
      언어: star.language ? escapeMarkdown(plainLine(star.language)) : "",
      별: star.stars.toLocaleString("en-US"),
      누른날: kstDateKey(star.starredAt),
    },
    { url: cardLink(star.url) },
  );
}

/** A link button to the repository. Discord shows a label as plain text. */
export function starButton(
  star: Pick<RepoFacts, "fullName"> & { url: string },
): { type: 2; style: 5; label: string; url: string } | null {
  const url = cardLink(star.url);
  return url
    ? {
        type: 2,
        style: 5,
        label: clip(plainLine(star.fullName), BUTTON_LABEL_MAX_CHARS),
        url,
      }
    : null;
}
