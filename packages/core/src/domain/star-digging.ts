import {
  interestFit,
  interestReason,
  type Interests,
  type RepoFacts,
} from "./star-interests.js";
import type { GitHubStar, StarPick } from "./star-reminders.js";

/** Where one seed repository leads: the people around it and what they made or starred. */
export interface DigTrail {
  seed: string;
  // People who use the seed lately and their own latest stars.
  neighbors: Array<{ login: string; starred: GitHubStar[] }>;
  // The seed owner's other repositories.
  maker: GitHubStar[];
  // The seed's top contributors besides its owner, and what they made.
  contributors: Array<{ login: string; repos: GitHubStar[] }>;
}

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
// The best few are shuffled, so the same trail does not win every morning.
const DUG_WINDOW = 3;

const lower = (name: string) => name.toLowerCase();
const asTime = (value: Date | string | null | undefined) =>
  value ? new Date(value).getTime() : NaN;

/**
 * Up to `count` repositories to dig from, drawn at random with weights: one the
 * owner thumbed up counts most, then a star that fits their interests, then a
 * recent star, which says what they are into now. A giant or a tiny repository
 * is no seed.
 */
export function digSeeds(input: {
  stars: ReadonlyArray<RepoFacts & { starredAt: Date | string }>;
  liked: readonly RepoFacts[];
  interests: Interests;
  now: Date;
  random?: (() => number) | undefined;
  count?: number;
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
  const pool = [...weights.values()];
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
}

interface Reach {
  repo: GitHubStar;
  // Neighbors who starred it, with how much their taste counts.
  people: Map<string, number>;
  tasteful: Set<string>;
  seeds: Set<string>;
  // The seeds whose neighbors starred it.
  peopleSeeds: Set<string>;
  maker?: string;
  contributor?: { seed: string; login: string };
}

const shortName = (fullName: string) => fullName.split("/")[1] ?? fullName;

function trailText(reach: Reach): string {
  const parts: string[] = [];
  if (reach.people.size > 0) {
    const seeds = [...reach.peopleSeeds].map(shortName).slice(0, 2).join(", ");
    parts.push(
      `${seeds} 쓰는 사람 ${reach.people.size}명이 스타 누름${
        reach.tasteful.size === 0
          ? ""
          : reach.tasteful.size === reach.people.size
            ? " (모두 내 스타와 많이 겹침)"
            : ` (그중 ${reach.tasteful.size}명은 내 스타와 많이 겹침)`
      }`,
    );
  }
  if (reach.maker)
    parts.push(`${shortName(reach.maker)} 만든 사람의 다른 저장소`);
  if (reach.contributor)
    parts.push(
      `${shortName(reach.contributor.seed)} 기여자 ${reach.contributor.login}의 저장소`,
    );
  return parts.join(" · ");
}

/**
 * Every repository the trails reach that the owner has not seen, best first.
 * A neighbor's star counts more the more of the owner's stars they share, and
 * more for what they starred lately. The same maker or a contributor of a seed
 * is a way of its own, and reaching one from two seeds counts extra. Famous
 * repositories are pulled down, so a dig turns up what a search would not, and
 * the owner's interests only tip the balance: any net dislike rules one out.
 */
export function rankDug(input: {
  trails: readonly DigTrail[];
  ownStars: ReadonlyArray<Pick<RepoFacts, "fullName">>;
  seen: ReadonlySet<string>;
  self?: string | undefined;
  interests: Interests;
  now: Date;
}): DugRepo[] {
  const own = new Set(input.ownStars.map((star) => lower(star.fullName)));
  const self = input.self ? lower(input.self) : null;
  const reaches = new Map<string, Reach>();
  const reach = (repo: GitHubStar, seed: string) => {
    const key = lower(repo.fullName);
    const entry = reaches.get(key) ?? {
      repo,
      people: new Map<string, number>(),
      tasteful: new Set<string>(),
      seeds: new Set<string>(),
      peopleSeeds: new Set<string>(),
    };
    entry.seeds.add(seed);
    reaches.set(key, entry);
    return entry;
  };
  for (const trail of input.trails) {
    const seed = lower(trail.seed);
    for (const neighbor of trail.neighbors) {
      const others = neighbor.starred.filter(
        (repo) => lower(repo.fullName) !== seed,
      );
      if (others.length === 0) continue;
      const shared = others.filter((repo) => own.has(lower(repo.fullName)));
      // 15% of their stars shared with the owner is as close as strangers get.
      const taste = 0.2 + Math.min(1.8, (shared.length / others.length) * 12);
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
        if (shared.length >= 3) entry.tasteful.add(neighbor.login);
      }
    }
    for (const repo of trail.maker)
      if (lower(repo.fullName) !== seed)
        reach(repo, trail.seed).maker ??= trail.seed;
    for (const { login, repos } of trail.contributors)
      for (const repo of repos)
        reach(repo, trail.seed).contributor ??= { seed: trail.seed, login };
  }
  const dug: DugRepo[] = [];
  for (const [key, entry] of reaches) {
    const { repo } = entry;
    if (input.seen.has(key) || own.has(key)) continue;
    const [owner = "", name = ""] = repo.fullName.split("/");
    if (self && lower(owner) === self) continue;
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
    // One stranger's star alone is chance, not a trail, and a maker's other
    // work needs someone else to vouch for it, or the owner's interests.
    const vouched =
      entry.people.size >= 2 ||
      (entry.people.size === 1 && (entry.maker || entry.contributor));
    if (!vouched && !((entry.maker || entry.contributor) && fit.score > 0))
      continue;
    const ways =
      [...entry.people.values()].reduce((sum, weight) => sum + weight, 0) +
      (entry.maker ? 1.5 : 0) +
      (entry.contributor ? 1 : 0) +
      0.75 * (entry.seeds.size - 1);
    dug.push({
      repo,
      score: ways * notability(repo.stars) + fit.score * 0.5,
      trail: trailText(entry),
      reason: interestReason(fit.liked),
    });
  }
  return dug.sort((a, b) => b.score - a.score || a.repo.stars - b.repo.stars);
}

/** One of the best few dug repositories, so the same trail does not win every day. */
export function pickDug(
  ranked: readonly DugRepo[],
  random: () => number = Math.random,
): DugRepo | null {
  const window = ranked.slice(0, DUG_WINDOW);
  return window.length ? window[Math.floor(random() * window.length)]! : null;
}
