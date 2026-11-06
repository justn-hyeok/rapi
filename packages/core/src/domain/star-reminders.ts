import { templateCard } from "./card-template.js";
import { clip, type DiscordCard } from "./discord-card.js";
import { kstDateKey } from "./curation.js";
import { cardLink, escapeMarkdown, plainLine } from "./discount-cards.js";

/** One of the owner's stars, as GitHub reports it today. */
export interface GitHubStar {
  fullName: string;
  url: string;
  description: string;
  language: string | null;
  stars: number;
  archived: boolean;
  starredAt: string;
}

export interface StoredStar extends Omit<GitHubStar, "starredAt"> {
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

/** The repository's own words are a stranger's, so they show as plain text. */
export function starCard(star: StoredStar): DiscordCard {
  return templateCard(
    "star",
    {
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
  star: StoredStar,
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
