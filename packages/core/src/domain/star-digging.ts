import {
  aboutLiked,
  interestFit,
  interestReason,
  type Interests,
  type RepoFacts,
} from "./star-interests.js";
import type { GitHubStar, StarPick } from "./star-reminders.js";

/** How a neighbor came to the seed. Forking is often copying, so it says less. */
export type NeighborRole = "issue" | "fork" | "star";

/** Where one seed repository leads: the people around it and what they made or starred. */
export interface DigTrail {
  seed: string;
  // People who use the seed lately and their own latest stars.
  neighbors: Array<{
    login: string;
    role?: NeighborRole;
    starred: GitHubStar[];
  }>;
  // The seed owner's other repositories.
  maker: GitHubStar[];
  // The seed's top contributors besides its owner, and what they made.
  contributors: Array<{ login: string; repos: GitHubStar[] }>;
  // For a seed with few people around it: whom its maker follows, and what they made.
  followed?: Array<{ login: string; repos: GitHubStar[] }>;
}

/** A neighbor kept from an earlier dig because they share many of the owner's stars. */
export interface KeptNeighbor {
  login: string;
  shared: number;
  // Their stars since they were kept, and older ones past what a dig reads.
  starred: GitHubStar[];
}

/** Which way a dug repository mostly came, which the owner's thumbs score. */
export type DigKind = "people" | "kept" | "maker" | "contributor" | "followed";

const DAY_MS = 86_400_000;
// Who stars a giant says nothing about taste; a repository with a handful of
// stars has no stargazers to follow.
const SEED_MIN_STARS = 20;
const SEED_MAX_STARS = 30_000;
// A dug repository is meant to be found, not one everyone has heard of.
const DUG_MIN_STARS = 10;
const DUG_MAX_STARS = 50_000;
const DUG_STALE_DAYS = 730;
// Someone's home page, notes or settings is theirs, not a find.
const PERSONAL =
  /(?:^|[-_.])(?:portfolio|homepage|dotfiles|resume|cv|blog|website)(?:$|[-_.])|\.github\.io$/i;
const PERSONAL_ABOUT =
  /^(?:my )?(?:personal (?:website|site|blog|page)|portfolio)/i;
const RECENT_NEIGHBOR_STAR_DAYS = 90;
// A neighbor with this many of the owner's stars is worth keeping and following.
export const KEEP_NEIGHBOR_SHARED = 3;
// Fewer shared stars than this and one person's star vouches for nothing.
const TRUSTED_SHARED = 2;
// A kept neighbor this close vouches alone.
const CLOSE_KEPT_SHARED = 6;
// Strangers rarely share more than this part of their stars with the owner.
const CLOSE_SHARE = 0.15;
// Each kind offers this many, from different seeds, to draw from.
const KIND_WINDOW = 5;
// A kind takes part only when its best scores this part of the day's best.
const KIND_FLOOR = 0.4;
// A thumbed-down repository's maker and seed rest this long.
const DISLIKE_REST_DAYS = 30;
// Nothing by the same maker twice within this.
const SAME_OWNER_DAYS = 14;

const lower = (name: string) => name.toLowerCase();
const asTime = (value: Date | string | null | undefined) =>
  value ? new Date(value).getTime() : NaN;
const ownerOf = (fullName: string) => lower(fullName.split("/")[0] ?? "");

/**
 * How close a neighbor's taste is, from 0.2 to 2: the part of their stars the
 * owner shares, shrunk toward nothing when they have few stars to judge by.
 */
export function neighborTaste(shared: number, others: number): number {
  return 0.2 + 1.8 * Math.min(1, (shared + 1) / (others + 20) / CLOSE_SHARE);
}

/**
 * Up to `count` repositories to dig from, drawn at random with weights: one the
 * owner thumbed up counts most, then a star that fits their interests, then a
 * recent star, which says what they are into now. A giant or a tiny repository
 * is no seed, and one that led to a thumbed-down find lately counts half.
 */
export function digSeeds(input: {
  stars: ReadonlyArray<RepoFacts & { starredAt: Date | string }>;
  liked: readonly RepoFacts[];
  interests: Interests;
  now: Date;
  random?: (() => number) | undefined;
  count?: number;
  resting?: ReadonlySet<string>;
}): string[] {
  const random = input.random ?? Math.random;
  const usable = (repo: RepoFacts) =>
    repo.stars >= SEED_MIN_STARS && repo.stars <= SEED_MAX_STARS;
  const weights = new Map<string, { name: string; weight: number }>();
  const add = (repo: RepoFacts, weight: number) => {
    if (!usable(repo)) return;
    const entry = weights.get(lower(repo.fullName)) ?? {
      name: repo.fullName,
      weight: 0,
    };
    entry.weight += weight;
    weights.set(lower(repo.fullName), entry);
  };
  for (const repo of input.liked) add(repo, 3);
  if (Object.values(input.interests).some((weight) => weight > 0))
    for (const { repo } of input.stars
      .map((repo) => ({
        repo,
        ...interestFit(repo, input.interests, input.now),
      }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 12))
      add(repo, 2);
  for (const repo of [...input.stars]
    .sort((a, b) => asTime(b.starredAt) - asTime(a.starredAt))
    .slice(0, 12))
    add(repo, 1);
  const pool = [...weights.entries()].map(([key, entry]) => ({
    name: entry.name,
    weight: input.resting?.has(key) ? entry.weight / 2 : entry.weight,
  }));
  const seeds: string[] = [];
  while (pool.length > 0 && seeds.length < (input.count ?? 3)) {
    const total = pool.reduce((sum, entry) => sum + entry.weight, 0);
    let roll = random() * total;
    const index = Math.max(
      0,
      pool.findIndex((entry) => (roll -= entry.weight) < 0),
    );
    seeds.push(pool.splice(index, 1)[0]!.name);
  }
  return seeds;
}

/**
 * How much a find is worth by its stars: most from ★100 to ★3천, which a
 * search rarely surfaces and someone still keeps up, less for a handful of
 * stars, and less again as it gets famous.
 */
export function notability(stars: number): number {
  if (stars < 100) return Math.log10(Math.max(stars, 1)) / 2;
  if (stars <= 3000) return 1;
  return 1 / (1 + Math.log10(stars / 3000));
}

/** A repository a dig reached, how strongly, and by which ways. */
export interface DugRepo extends StarPick<GitHubStar> {
  score: number;
  trail: string;
  kind: DigKind;
  // The seed, or "@login" for a kept neighbor, it mostly came from.
  seed: string;
}

interface Reach {
  repo: GitHubStar;
  // Neighbors who starred it, with how much their taste counts.
  people: Map<string, number>;
  // Of those, the ones who share enough of the owner's stars to vouch.
  trusted: Set<string>;
  tasteful: Set<string>;
  seeds: Set<string>;
  // The seeds whose neighbors starred it.
  peopleSeeds: Set<string>;
  kept: Map<string, number>;
  closeKept?: boolean;
  maker?: string;
  contributor?: { seed: string; login: string };
  followed?: { seed: string; login: string };
}

const shortName = (fullName: string) => fullName.split("/")[1] ?? fullName;

function trailText(reach: Reach): string {
  const parts: string[] = [];
  if (reach.people.size > 0) {
    const seeds = [...reach.peopleSeeds].map(shortName).slice(0, 2).join(", ");
    const count = reach.people.size;
    const close = reach.tasteful.size;
    parts.push(
      `${seeds} 쓰는 사람 ${count}명이 스타 누름${
        close === 0
          ? ""
          : count === 1
            ? " (내 스타와 많이 겹치는 사람)"
            : close === count
              ? " (모두 내 스타와 많이 겹침)"
              : ` (그중 ${close}명은 내 스타와 많이 겹침)`
      }`,
    );
  }
  if (reach.kept.size > 0)
    parts.push(
      `취향 이웃 ${[...reach.kept.keys()].slice(0, 2).join(", ")}의 스타`,
    );
  if (reach.maker)
    parts.push(`${shortName(reach.maker)} 만든 사람의 다른 저장소`);
  if (reach.contributor)
    parts.push(
      `${shortName(reach.contributor.seed)} 기여자 ${reach.contributor.login}의 저장소`,
    );
  if (reach.followed)
    parts.push(
      `${shortName(reach.followed.seed)} 만든 사람이 팔로우하는 ${reach.followed.login}의 저장소`,
    );
  return parts.join(" · ");
}

const sum = (values: Iterable<number>) =>
  [...values].reduce((total, value) => total + value, 0);

/** The way that brought the most, and the seed it came from. */
function strongestWay(reach: Reach): { kind: DigKind; seed: string } {
  const ways: Array<[DigKind, number, string]> = [
    ["people", sum(reach.people.values()), [...reach.peopleSeeds][0] ?? ""],
    ["kept", sum(reach.kept.values()), `@${[...reach.kept.keys()][0] ?? ""}`],
    ["maker", reach.maker ? 1.5 : 0, reach.maker ?? ""],
    ["contributor", reach.contributor ? 1 : 0, reach.contributor?.seed ?? ""],
    ["followed", reach.followed ? 0.8 : 0, reach.followed?.seed ?? ""],
  ];
  const [kind, , seed] = ways.reduce((best, way) =>
    way[1] > best[1] ? way : best,
  );
  return { kind, seed };
}

/**
 * Every repository the trails reach that the owner has not seen, best first.
 *
 * A neighbor's star counts by how much of the owner's taste they share, spread
 * thinner the more they star, less from a fork than an issue, and less when
 * they starred what the owner thumbed down. Kept neighbors bring their newer
 * and older stars, counted a little less. The seed's maker, contributors and the people its maker follows are
 * ways of their own, and reaching one from two seeds counts extra. Famous
 * repositories are pulled down, so a dig turns up what a search would not.
 *
 * A find needs two trusted people, or one with another way, or a kept neighbor
 * who shares six of the owner's stars, or another way and a field the owner
 * likes. Any net dislike, or a maker resting after a thumb
 * down or shown in the last two weeks, rules one out.
 */
export function rankDug(input: {
  trails: readonly DigTrail[];
  kept?: readonly KeptNeighbor[];
  ownStars: ReadonlyArray<Pick<RepoFacts, "fullName">>;
  seen: ReadonlySet<string>;
  disliked?: ReadonlySet<string>;
  restingOwners?: ReadonlySet<string>;
  self?: string | undefined;
  interests: Interests;
  now: Date;
}): DugRepo[] {
  const own = new Set(input.ownStars.map((star) => lower(star.fullName)));
  const disliked = input.disliked ?? new Set<string>();
  const self = input.self ? lower(input.self) : null;
  const reaches = new Map<string, Reach>();
  const reach = (repo: GitHubStar, seed: string) => {
    const key = lower(repo.fullName);
    const entry = reaches.get(key) ?? {
      repo,
      people: new Map<string, number>(),
      trusted: new Set<string>(),
      tasteful: new Set<string>(),
      seeds: new Set<string>(),
      peopleSeeds: new Set<string>(),
      kept: new Map<string, number>(),
    };
    entry.seeds.add(seed);
    reaches.set(key, entry);
    return entry;
  };
  const dislikePenalty = (starred: readonly GitHubStar[]) => {
    const count = starred.filter((repo) =>
      disliked.has(lower(repo.fullName)),
    ).length;
    return count >= 2 ? 0.5 : count === 1 ? 0.75 : 1;
  };
  for (const trail of input.trails) {
    const seed = lower(trail.seed);
    for (const neighbor of trail.neighbors) {
      const others = neighbor.starred.filter(
        (repo) => lower(repo.fullName) !== seed,
      );
      if (others.length === 0) continue;
      const shared = others.filter((repo) =>
        own.has(lower(repo.fullName)),
      ).length;
      const taste =
        (neighborTaste(shared, others.length) /
          Math.sqrt(Math.max(1, others.length / 30))) *
        (neighbor.role === "fork" ? 0.6 : 1) *
        dislikePenalty(others);
      for (const repo of others) {
        const age = input.now.getTime() - asTime(repo.starredAt);
        const entry = reach(repo, trail.seed);
        entry.peopleSeeds.add(trail.seed);
        entry.people.set(
          neighbor.login,
          Math.max(
            entry.people.get(neighbor.login) ?? 0,
            taste * (age < RECENT_NEIGHBOR_STAR_DAYS * DAY_MS ? 1 : 0.6),
          ),
        );
        if (shared >= TRUSTED_SHARED) entry.trusted.add(neighbor.login);
        if (shared >= KEEP_NEIGHBOR_SHARED) entry.tasteful.add(neighbor.login);
      }
    }
    for (const repo of trail.maker)
      if (lower(repo.fullName) !== seed)
        reach(repo, trail.seed).maker ??= trail.seed;
    for (const { login, repos } of trail.contributors)
      for (const repo of repos)
        reach(repo, trail.seed).contributor ??= { seed: trail.seed, login };
    for (const { login, repos } of trail.followed ?? [])
      for (const repo of repos)
        reach(repo, trail.seed).followed ??= { seed: trail.seed, login };
  }
  for (const neighbor of input.kept ?? []) {
    // Read days after they were kept and deeper than a dig, so a little less,
    // and spread over all they starred, like any neighbor.
    const taste =
      (0.8 *
        neighborTaste(neighbor.shared, 100) *
        dislikePenalty(neighbor.starred)) /
      Math.sqrt(Math.max(1, neighbor.starred.length / 30));
    for (const repo of neighbor.starred) {
      const entry = reach(repo, `@${neighbor.login}`);
      entry.kept.set(neighbor.login, taste);
      entry.trusted.add(neighbor.login);
      if (neighbor.shared >= CLOSE_KEPT_SHARED) entry.closeKept = true;
    }
  }
  const dug: DugRepo[] = [];
  for (const [key, entry] of reaches) {
    const { repo } = entry;
    if (input.seen.has(key) || own.has(key) || disliked.has(key)) continue;
    const [owner = "", name = ""] = repo.fullName.split("/");
    if (self && lower(owner) === self) continue;
    if (input.restingOwners?.has(lower(owner))) continue;
    if (
      repo.archived ||
      repo.stars < DUG_MIN_STARS ||
      repo.stars > DUG_MAX_STARS
    )
      continue;
    if (input.now.getTime() - asTime(repo.pushedAt) > DUG_STALE_DAYS * DAY_MS)
      continue;
    if (
      !repo.description.trim() ||
      PERSONAL.test(name) ||
      // A profile repository, such as alice/alice or alice/alice.v2.
      new RegExp(`^${owner.replace(/[.-]/g, "\\$&")}(?:$|[.-])`, "i").test(
        name,
      ) ||
      PERSONAL_ABOUT.test(repo.description.trim())
    )
      continue;
    const fit = interestFit(repo, input.interests, input.now);
    if (fit.score < 0) continue;
    const otherWay = Boolean(
      entry.maker || entry.contributor || entry.followed,
    );
    const people = entry.people.size + entry.kept.size;
    const vouched =
      entry.closeKept === true ||
      entry.trusted.size >= 2 ||
      (entry.trusted.size === 1 && (people >= 2 || otherWay));
    // One stranger's star alone is chance, and a maker's other work needs
    // someone to vouch for it or to be about something the owner likes.
    if (!vouched && !(otherWay && aboutLiked(fit.liked))) continue;
    const ways =
      sum(entry.people.values()) +
      sum(entry.kept.values()) +
      (entry.maker ? 1.5 : 0) +
      (entry.contributor ? 1 : 0) +
      (entry.followed ? 0.8 : 0) +
      0.75 * (entry.seeds.size - 1);
    dug.push({
      repo,
      score: ways * notability(repo.stars) + fit.score * 0.5,
      trail: trailText(entry),
      reason: interestReason(fit.liked),
      ...strongestWay(entry),
    });
  }
  return dug.sort((a, b) => b.score - a.score || a.repo.stars - b.repo.stars);
}

/** The neighbors worth keeping: those who share many of the owner's stars. */
export function closeNeighbors(
  trails: readonly DigTrail[],
  ownStars: ReadonlyArray<Pick<RepoFacts, "fullName">>,
): Array<{ login: string; shared: number; from: string }> {
  const own = new Set(ownStars.map((star) => lower(star.fullName)));
  const close = new Map<
    string,
    { login: string; shared: number; from: string }
  >();
  for (const trail of trails)
    for (const neighbor of trail.neighbors) {
      const shared = neighbor.starred.filter(
        (repo) =>
          own.has(lower(repo.fullName)) &&
          lower(repo.fullName) !== lower(trail.seed),
      ).length;
      if (
        shared >= KEEP_NEIGHBOR_SHARED &&
        shared > (close.get(lower(neighbor.login))?.shared ?? 0)
      )
        close.set(lower(neighbor.login), {
          login: neighbor.login,
          shared,
          from: trail.seed,
        });
    }
  return [...close.values()];
}

/**
 * A draw from Beta(a, b) for whole a and b: the a-th smallest of a + b - 1
 * uniform draws. Counts are capped, so a long history stays cheap.
 */
export function betaDraw(
  a: number,
  b: number,
  random: () => number = Math.random,
): number {
  const scale = Math.min(1, 40 / (a + b));
  const left = Math.max(1, Math.round(a * scale));
  const right = Math.max(1, Math.round(b * scale));
  const draws = Array.from({ length: left + right - 1 }, () => random()).sort(
    (x, y) => x - y,
  );
  return draws[left - 1]!;
}

/** What became of an earlier dug repository. */
export interface DigOutcome {
  fullName: string;
  kind: string | null;
  seed: string | null;
  suggestedAt: Date | string;
  vote: number | null;
  votedAt: Date | string | null;
}

/**
 * Which makers and seeds rest today: a maker shown in the last two weeks, and
 * the maker and seed of a find thumbed down in the last month.
 */
export function restingFromHistory(
  history: readonly DigOutcome[],
  now: Date,
): { owners: Set<string>; seeds: Set<string> } {
  const owners = new Set<string>();
  const seeds = new Set<string>();
  const within = (date: Date | string | null, days: number) =>
    date !== null && now.getTime() - asTime(date) < days * DAY_MS;
  for (const outcome of history) {
    if (within(outcome.suggestedAt, SAME_OWNER_DAYS))
      owners.add(ownerOf(outcome.fullName));
    if (
      outcome.vote !== null &&
      outcome.vote < 0 &&
      within(outcome.votedAt, DISLIKE_REST_DAYS)
    ) {
      owners.add(ownerOf(outcome.fullName));
      if (outcome.seed) seeds.add(lower(outcome.seed));
    }
  }
  return { owners, seeds };
}

/**
 * One dug repository for today. Each way the dig can come is scored by the
 * owner's thumbs on what it brought before, drawn once from Beta(1 + 👍, 1 + 👎),
 * so a way that keeps pleasing comes more often and an untried one still gets
 * its turns, as long as its best is not far below the day's best. Within the
 * drawn way, one of the best few, at most one a seed.
 */
export function pickDug(
  ranked: readonly DugRepo[],
  options: {
    random?: (() => number) | undefined;
    history?: readonly DigOutcome[];
  } = {},
): DugRepo | null {
  const random = options.random ?? Math.random;
  // A way whose best is far below the day's best is not worth a turn.
  const floor = (ranked[0]?.score ?? 0) * KIND_FLOOR;
  const kinds = [
    ...new Set(
      ranked.filter((dug) => dug.score >= floor).map((dug) => dug.kind),
    ),
  ];
  if (kinds.length === 0) return null;
  const tally = (kind: DigKind, sign: 1 | -1) =>
    (options.history ?? []).filter(
      (outcome) =>
        outcome.kind === kind &&
        outcome.vote !== null &&
        Math.sign(outcome.vote) === sign,
    ).length;
  const kind = kinds
    .map((name) => ({
      name,
      draw: betaDraw(1 + tally(name, 1), 1 + tally(name, -1), random),
    }))
    .reduce((best, next) => (next.draw > best.draw ? next : best)).name;
  const window: DugRepo[] = [];
  const seeds = new Set<string>();
  for (const dug of ranked) {
    if (dug.kind !== kind || seeds.has(lower(dug.seed))) continue;
    seeds.add(lower(dug.seed));
    window.push(dug);
    if (window.length === KIND_WINDOW) break;
  }
  return window[Math.floor(random() * window.length)]!;
}
