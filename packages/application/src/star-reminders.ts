import {
  type DiscordGateway,
  DiscordServerError,
  type StarStore,
  UncertainDeliveryError,
} from "./ports/index.js";
import {
  clip,
  closeNeighbors,
  combinedInterests,
  digSeeds,
  discordEmbed,
  foundRepoCard,
  interestQueries,
  kstDateKey,
  kstReached,
  pickForgottenStars,
  pickDug,
  pickFoundRepo,
  pickInterestingStar,
  plainLine,
  rankDug,
  restingFromHistory,
  starButton,
  starCard,
  type DeliveryPayload,
  type DigTrail,
  type GitHubStar,
  type Interests,
  type KeptNeighbor,
  type StoredStar,
} from "@rapi/domain";

const REMINDER_KST_HOUR = 9;

export type ReminderStore = Pick<
  StarStore,
  | "saveStars"
  | "currentStars"
  | "starReminderClaimed"
  | "claimStarReminder"
  | "releaseStarReminder"
  | "saveStarReminderMessage"
> &
  Partial<
    Pick<
      StarStore,
      | "starInterests"
      | "seenStarRepos"
      | "saveStarSuggestion"
      | "starRepo"
      | "starDigHistory"
      | "saveStarNeighbors"
      | "starNeighbors"
      | "markStarNeighborsFollowed"
    >
  >;

export const STAR_VOTE_PREFIX = "star_vote:";
// Discord's limit on a custom_id.
const CUSTOM_ID_MAX_CHARS = 100;

/** A repository in the day's message, and why, when the owner's interests chose it. */
export interface ReminderPick {
  repo: StoredStar;
  reason: string;
  // Found by a dig or a search, not one of the owner's stars.
  found?: boolean;
  // How a dig reached it, in words and as the way and seed it mostly came by.
  trail?: string;
  dig?: { kind: string; seed: string };
}

/** The ways to new repositories: digging from seeds, then a plain search. */
interface Finders {
  dig?: ((seeds: string[]) => Promise<DigTrail[]>) | undefined;
  // The stars of neighbors kept from earlier digs.
  follow?:
    | ((logins: string[]) => Promise<Array<Omit<KeptNeighbor, "shared">>>)
    | undefined;
  search?: ((queries: string[]) => Promise<GitHubStar[]>) | undefined;
  // The owner's GitHub login, whose own repositories are no find.
  self?: string | undefined;
}

// Liked repositories the dig may start from, latest first.
const LIKED_SEEDS = 10;
// Kept neighbors followed a day.
const FOLLOWED_NEIGHBORS = 3;
const DAY_MS = 86_400_000;
// A thumbed-down repository's maker rests this long.
const DISLIKED_OWNER_REST_DAYS = 30;

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
      embeds: picks.map(({ repo, reason, found, trail }) =>
        discordEmbed(
          found ? foundRepoCard(repo, reason, trail) : starCard(repo, reason),
        ),
      ),
      components: rows.map((components) => ({ type: 1, components })),
    },
  };
}

/**
 * A repository the owner has never seen: dug from their liked, fitting or
 * recent stars first, and only when that finds nothing, a search for their
 * interests. Null when neither finds one.
 */
async function findNew(
  store: ReminderStore,
  stars: StoredStar[],
  saved: {
    interests: Interests;
    votes: ReadonlyArray<{
      fullName: string;
      vote: number;
      votedAt?: Date | string;
    }>;
  },
  ownerId: string,
  now: Date,
  random: (() => number) | undefined,
  finders: Finders,
  failures: string[],
): Promise<ReminderPick | null> {
  if (!store.seenStarRepos) return null;
  const { interests, votes } = saved;
  const asPick = (
    repo: GitHubStar,
    reason: string,
    dug?: { trail: string; kind: string; seed: string },
  ): ReminderPick => ({
    repo: {
      ...repo,
      starredAt: new Date(repo.starredAt),
      lastRemindedAt: null,
    },
    reason,
    found: true,
    ...(dug && {
      trail: dug.trail,
      dig: { kind: dug.kind, seed: dug.seed },
    }),
  });
  let seen: Set<string>;
  try {
    seen = await store.seenStarRepos();
  } catch (error) {
    failures.push(failureText("seen", error));
    return null;
  }
  for (const vote of votes) seen.add(vote.fullName.toLowerCase());
  if (finders.dig)
    try {
      const liked = store.starRepo
        ? (
            await Promise.all(
              votes
                .filter((vote) => vote.vote > 0)
                .slice(-LIKED_SEEDS)
                .map((vote) => store.starRepo!(vote.fullName)),
            )
          ).filter((repo): repo is GitHubStar => repo !== null)
        : [];
      const history = store.starDigHistory ? await store.starDigHistory() : [];
      const resting = restingFromHistory(history, now);
      const disliked = new Set<string>();
      for (const vote of votes)
        if (vote.vote < 0) {
          disliked.add(vote.fullName.toLowerCase());
          if (
            vote.votedAt &&
            now.getTime() - new Date(vote.votedAt).getTime() <
              DISLIKED_OWNER_REST_DAYS * DAY_MS
          )
            resting.owners.add(vote.fullName.split("/")[0]!.toLowerCase());
        }
      const seeds = digSeeds({
        stars,
        liked,
        interests,
        now,
        random,
        resting: resting.seeds,
      });
      // A kept neighbor who led to a thumbed-down find lately rests too.
      const keptRows =
        finders.follow && store.starNeighbors
          ? (await store.starNeighbors(FOLLOWED_NEIGHBORS * 3))
              .filter(
                (row) => !resting.seeds.has(`@${row.login.toLowerCase()}`),
              )
              .slice(0, FOLLOWED_NEIGHBORS)
          : [];
      const [trails, followed] = await Promise.all([
        seeds.length ? finders.dig(seeds) : Promise.resolve([]),
        keptRows.length && finders.follow
          ? finders.follow(keptRows.map((row) => row.login))
          : Promise.resolve([]),
      ]);
      const kept = followed.map((neighbor) => ({
        ...neighbor,
        shared:
          keptRows.find((row) => row.login === neighbor.login)?.shared ?? 0,
      }));
      // What a dig learns about people is kept even on a day it finds nothing.
      await store
        .saveStarNeighbors?.(closeNeighbors(trails, stars))
        .catch((error: unknown) =>
          failures.push(failureText("neighbors", error)),
        );
      await store
        .markStarNeighborsFollowed?.(kept.map((neighbor) => neighbor.login))
        .catch((error: unknown) =>
          failures.push(failureText("followed", error)),
        );
      const dug = pickDug(
        rankDug({
          trails,
          kept,
          ownStars: stars,
          seen,
          disliked,
          restingOwners: resting.owners,
          self: finders.self,
          interests,
          now,
        }),
        { random, history },
      );
      if (dug) return asPick(dug.repo, dug.reason, dug);
    } catch (error) {
      failures.push(failureText("dig", error));
    }
  if (finders.search && Object.values(interests).some((weight) => weight > 0))
    try {
      const found = pickFoundRepo(
        await finders.search(interestQueries(interests, now)),
        seen,
        interests,
        now,
      );
      if (found) return asPick(found.repo, found.reason);
    } catch (error) {
      failures.push(failureText("search", error));
    }
  return null;
}

/**
 * The day's repositories: one forgotten star, the one that fits the owner's
 * interests best when they have some, and one new repository a dig or a search
 * found. Without a new one, one or two forgotten stars, as before. A
 * thumbed-down repository never returns.
 */
async function choose(
  store: ReminderStore,
  ownerId: string,
  stars: StoredStar[],
  now: Date,
  random: (() => number) | undefined,
  finders: Finders,
  failures: string[],
): Promise<ReminderPick[]> {
  let interests: Interests = {};
  let votes: Array<{
    fullName: string;
    vote: number;
    facets: string[];
    votedAt?: Date | string;
  }> = [];
  if (store.starInterests)
    try {
      const saved = await store.starInterests();
      interests = combinedInterests(saved.picked, saved.votes);
      votes = saved.votes;
    } catch (error) {
      failures.push(failureText("interests", error));
    }
  const disliked = new Set(
    votes
      .filter((vote) => vote.vote < 0)
      .map((vote) => vote.fullName.toLowerCase()),
  );
  const kept = stars.filter(
    (star) => !disliked.has(star.fullName.toLowerCase()),
  );
  const found = await findNew(
    store,
    kept,
    { interests, votes },
    ownerId,
    now,
    random,
    finders,
    failures,
  );
  const fitting = Object.values(interests).some((weight) => weight > 0)
    ? pickInterestingStar(kept, interests, now, random)
    : null;
  const forgotten = fitting
    ? [fitting]
    : pickForgottenStars(kept, now, random)
        .slice(0, found ? 1 : 2)
        .map((repo) => ({ repo, reason: "" }));
  return [...forgotten, ...(found ? [found] : [])];
}

/**
 * Runs often and does nothing outside its moment: from 09:00 Asia/Seoul until the
 * day's message is claimed. A failed read keeps what is stored and still reminds
 * from it. Claimed before sending, so dying mid-send loses the day's message rather
 * than sending it twice. Only a send Discord definitely refused is released and
 * tried again on a later run. Returns the failures.
 */
export async function remindStars(input: {
  store: ReminderStore;
  delivery: Pick<DiscordGateway, "send">;
  ownerId: string;
  readStars: () => Promise<{ stars: GitHubStar[]; complete: boolean }>;
  // Follows seed repositories out to the people and projects around them.
  digTrails?: (seeds: string[]) => Promise<DigTrail[]>;
  // Reads the stars of neighbors kept from earlier digs.
  followNeighbors?: (
    logins: string[],
  ) => Promise<Array<Omit<KeptNeighbor, "shared">>>;
  // A GitHub search for new repositories that fit the owner's interests.
  searchRepos?: (queries: string[]) => Promise<GitHubStar[]>;
  // The owner's GitHub login, whose own repositories are never suggested.
  githubLogin?: string;
  // Told when Discord refuses the DM outright, so the owner can be paused.
  onUndeliverable?: (reason: string) => Promise<void>;
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
          {
            dig: input.digTrails,
            follow: input.followNeighbors,
            search: input.searchRepos,
            self: input.githubLogin,
          },
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
          .saveStarSuggestion(
            {
              ...pick.repo,
              starredAt: pick.repo.starredAt.toISOString(),
              pushedAt: isoOrNull(pick.repo.pushedAt),
              createdAt: isoOrNull(pick.repo.createdAt),
            },
            pick.dig,
          )
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
      `star-reminder:${ownerId}:${day}`,
    );
    messageId = sent.providerId;
  } catch (error) {
    failures.push(failureText("send", error));
    // Discord answers 403 to a DM that person does not take.
    if (
      input.onUndeliverable &&
      error instanceof Error &&
      /\b403\b/.test(error.message)
    )
      await input
        .onUndeliverable("DM을 받을 수 없음")
        .catch((pauseError: unknown) =>
          failures.push(failureText("pause", pauseError)),
        );
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
