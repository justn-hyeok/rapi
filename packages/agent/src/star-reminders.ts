import { DiscordServerError, UncertainDeliveryError } from "@rapi/adapters";
import {
  clip,
  combinedInterests,
  discordEmbed,
  foundRepoCard,
  interestQueries,
  kstDateKey,
  kstReached,
  pickForgottenStars,
  pickFoundRepo,
  pickInterestingStar,
  plainLine,
  starButton,
  starCard,
  type DeliveryAdapter,
  type DeliveryPayload,
  type GitHubStar,
  type StoredStar,
} from "@rapi/core";
import type { PostgresStore } from "@rapi/db";

const REMINDER_KST_HOUR = 9;

type StarStore = Pick<
  PostgresStore,
  | "saveStars"
  | "currentStars"
  | "starReminderClaimed"
  | "claimStarReminder"
  | "releaseStarReminder"
  | "saveStarReminderMessage"
> &
  Partial<
    Pick<
      PostgresStore,
      "starInterests" | "seenStarRepos" | "saveStarSuggestion"
    >
  >;

export const STAR_VOTE_PREFIX = "star_vote:";
// Discord's limit on a custom_id.
const CUSTOM_ID_MAX_CHARS = 100;

/** A repository in the day's message, and why, when the owner's interests chose it. */
export interface ReminderPick {
  repo: StoredStar;
  reason: string;
  // Found by a search, not one of the owner's stars.
  found?: boolean;
}

const isoOrNull = (value: Date | string | null | undefined) =>
  value ? new Date(value).toISOString() : null;

const voteId = (vote: 1 | -1, fullName: string) =>
  `${STAR_VOTE_PREFIX}${vote}:${fullName}`;

const failureText = (step: string, error: unknown) =>
  `${step}: ${error instanceof Error ? error.message : "failed"}`;

/**
 * One message for the day: a card for each repository, a link and a thumb up and
 * down for each, and the link to the interest page. The adapter turns mentions off.
 */
export function starReminderPayload(
  picks: readonly ReminderPick[],
  interestUrl?: string,
): DeliveryPayload {
  const links = picks.flatMap(({ repo }) => starButton(repo) ?? []);
  const votes = picks.flatMap(({ repo }) => {
    if (voteId(-1, repo.fullName).length > CUSTOM_ID_MAX_CHARS) return [];
    const name = clip(plainLine(repo.fullName.split("/")[1] ?? ""), 60);
    return [
      {
        type: 2,
        style: 3,
        label: `👍 ${name}`,
        custom_id: voteId(1, repo.fullName),
      },
      {
        type: 2,
        style: 2,
        label: `👎 ${name}`,
        custom_id: voteId(-1, repo.fullName),
      },
    ];
  });
  const rows = [
    links,
    votes.slice(0, 5),
    interestUrl
      ? [{ type: 2, style: 5, label: "관심사 고르기", url: interestUrl }]
      : [],
  ].filter((row) => row.length > 0);
  return {
    subject: "잊고 있던 스타",
    text: picks.map(({ repo }) => repo.fullName).join("\n"),
    html: "",
    itemIds: [],
    discord: {
      embeds: picks.map(({ repo, reason, found }) =>
        discordEmbed(
          found ? foundRepoCard(repo, reason) : starCard(repo, reason),
        ),
      ),
      components: rows.map((components) => ({ type: 1, components })),
    },
  };
}

/**
 * The day's repositories. With interests: the forgotten star that fits them best
 * and one new repository a search found for them. Without, or when nothing fits:
 * one or two forgotten stars, as before. A thumbed-down repository never returns.
 */
async function choose(
  store: StarStore,
  ownerId: string,
  stars: StoredStar[],
  now: Date,
  random: (() => number) | undefined,
  search: ((queries: string[]) => Promise<GitHubStar[]>) | undefined,
  failures: string[],
): Promise<ReminderPick[]> {
  const fallback = () =>
    pickForgottenStars(stars, now, random).map((repo) => ({
      repo,
      reason: "",
    }));
  if (!store.starInterests) return fallback();
  let saved: Awaited<ReturnType<NonNullable<StarStore["starInterests"]>>>;
  try {
    saved = await store.starInterests(ownerId);
  } catch (error) {
    failures.push(failureText("interests", error));
    return fallback();
  }
  const interests = combinedInterests(saved.picked, saved.votes);
  if (!Object.values(interests).some((weight) => weight > 0)) return fallback();
  const voted = new Set(saved.votes.map((vote) => vote.fullName.toLowerCase()));
  const disliked = new Set(
    saved.votes
      .filter((vote) => vote.vote < 0)
      .map((vote) => vote.fullName.toLowerCase()),
  );
  const picks: ReminderPick[] = [];
  const star = pickInterestingStar(
    stars.filter(
      (candidate) => !disliked.has(candidate.fullName.toLowerCase()),
    ),
    interests,
    now,
    random,
  );
  if (star) picks.push(star);
  if (search && store.seenStarRepos) {
    try {
      const seen = await store.seenStarRepos();
      for (const name of voted) seen.add(name);
      const found = pickFoundRepo(
        await search(interestQueries(interests, now)),
        seen,
        interests,
        now,
      );
      if (found)
        picks.push({
          repo: {
            ...found.repo,
            starredAt: new Date(found.repo.starredAt),
            lastRemindedAt: null,
          },
          reason: found.reason,
          found: true,
        });
    } catch (error) {
      failures.push(failureText("search", error));
    }
  }
  return picks.length ? picks : fallback();
}

/**
 * Runs often and does nothing outside its moment: from 09:00 Asia/Seoul until the
 * day's message is claimed. A failed read keeps what is stored and still reminds
 * from it. Claimed before sending, so dying mid-send loses the day's message rather
 * than sending it twice. Only a send Discord definitely refused is released and
 * tried again on a later run. Returns the failures.
 */
export async function remindStars(input: {
  store: StarStore;
  delivery: Pick<DeliveryAdapter, "send">;
  ownerId: string;
  readStars: () => Promise<{ stars: GitHubStar[]; complete: boolean }>;
  // A GitHub search for new repositories that fit the owner's interests.
  searchRepos?: (queries: string[]) => Promise<GitHubStar[]>;
  // The signed link to the interest page, made fresh for each message.
  interestUrl?: (now: Date) => string;
  // The list is read once a day, even when the read fails or the send is tried again.
  // A restart forgets this, which costs a few requests at most.
  reads: { lastDay?: string; picks?: { day: string; picks: ReminderPick[] } };
  now?: Date;
  random?: () => number;
}): Promise<string[]> {
  const { store, delivery, ownerId, readStars, reads } = input;
  const now = input.now ?? new Date();
  if (!kstReached(now, REMINDER_KST_HOUR)) return [];
  const day = kstDateKey(now);
  const failures: string[] = [];
  let picks: ReminderPick[];
  try {
    if (await store.starReminderClaimed(day)) return [];
    if (reads.lastDay !== day) {
      reads.lastDay = day;
      try {
        const { stars, complete } = await readStars();
        await store.saveStars(stars, complete);
      } catch (error) {
        failures.push(failureText("read", error));
      }
    }
    // Chosen once a day, so a failed send does not search GitHub again.
    if (reads.picks?.day !== day)
      reads.picks = {
        day,
        picks: await choose(
          store,
          ownerId,
          await store.currentStars(),
          now,
          input.random,
          input.searchRepos,
          failures,
        ),
      };
    picks = reads.picks.picks;
    if (
      picks.length === 0 ||
      !(await store.claimStarReminder(
        day,
        picks.map((pick) => pick.repo),
      ))
    )
      return failures;
    for (const pick of picks)
      if (pick.found && store.saveStarSuggestion)
        await store
          .saveStarSuggestion({
            ...pick.repo,
            starredAt: pick.repo.starredAt.toISOString(),
            pushedAt: isoOrNull(pick.repo.pushedAt),
            createdAt: isoOrNull(pick.repo.createdAt),
          })
          .catch((error: unknown) =>
            failures.push(failureText("suggestion", error)),
          );
  } catch (error) {
    return [...failures, failureText("stars", error)];
  }
  let messageId: string;
  try {
    const sent = await delivery.send(
      { channel: "discord_dm", recipientId: ownerId },
      starReminderPayload(picks, input.interestUrl?.(now)),
      `star-reminder:${day}`,
    );
    messageId = sent.providerId;
  } catch (error) {
    failures.push(failureText("send", error));
    // It may have reached the owner, and one more day without stars costs nothing.
    if (
      !(error instanceof UncertainDeliveryError) &&
      !(error instanceof DiscordServerError)
    )
      await store
        .releaseStarReminder(
          day,
          picks.filter((pick) => !pick.found).map((pick) => pick.repo),
        )
        .catch((releaseError: unknown) =>
          failures.push(failureText("release", releaseError)),
        );
    return failures;
  }
  await store
    .saveStarReminderMessage(day, messageId)
    .catch((saveError: unknown) =>
      failures.push(failureText("save", saveError)),
    );
  return failures;
}
