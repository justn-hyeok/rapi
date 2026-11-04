import {
  clip,
  plainLine,
  STAR_DESCRIPTION_MAX_CHARS,
  type GitHubStar,
} from "@rapi/core";
import {
  readSource,
  type ExternalItem,
  type SourceHttpOptions,
} from "./sources.js";

export interface StarredRepository {
  fullName: string;
  owner: string;
  description: string;
  stars: number;
  topics: string[];
  starredAt: string | null;
  fork: boolean;
  archived: boolean;
}

export interface StarRecommendationInput {
  user: string;
  mine: StarredRepository[];
  neighbors: Array<{ login: string; starred: StarredRepository[] }>;
  topicCandidates: StarredRepository[];
  exclude: ReadonlySet<string>;
  now: Date;
  limit: number;
}

// Repositories every developer stars say nothing about this user's taste.
const MAX_STARS = 100_000;
const NEIGHBOR_WINDOW_MS = 14 * 86_400_000;

export function topTopics(mine: StarredRepository[], count: number): string[] {
  const counts = new Map<string, number>();
  for (const repo of mine)
    for (const topic of repo.topics)
      counts.set(topic, (counts.get(topic) ?? 0) + 1);
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, count)
    .map(([topic]) => topic);
}

export function rankStarRecommendations(
  input: StarRecommendationInput,
): ExternalItem[] {
  const user = input.user.toLowerCase();
  const seen = new Set(input.mine.map((repo) => repo.fullName.toLowerCase()));
  for (const id of input.exclude) seen.add(id.toLowerCase());
  const eligible = (repo: StarredRepository) =>
    !seen.has(repo.fullName.toLowerCase()) &&
    repo.owner.toLowerCase() !== user &&
    !repo.fork &&
    !repo.archived &&
    repo.stars < MAX_STARS;
  const interests = new Set(topTopics(input.mine, 15));
  const overlap = (repo: StarredRepository) =>
    repo.topics.filter((topic) => interests.has(topic));
  const candidates = new Map<
    string,
    { repo: StarredRepository; by: Set<string>; topics: string[] }
  >();
  for (const neighbor of input.neighbors)
    for (const repo of neighbor.starred) {
      if (
        !eligible(repo) ||
        repo.owner.toLowerCase() === neighbor.login.toLowerCase() ||
        !repo.starredAt ||
        input.now.getTime() - Date.parse(repo.starredAt) > NEIGHBOR_WINDOW_MS
      )
        continue;
      const key = repo.fullName.toLowerCase();
      const entry = candidates.get(key) ?? {
        repo,
        by: new Set<string>(),
        topics: overlap(repo),
      };
      entry.by.add(neighbor.login);
      candidates.set(key, entry);
    }
  for (const repo of input.topicCandidates) {
    const key = repo.fullName.toLowerCase();
    const topics = overlap(repo);
    if (!eligible(repo) || candidates.has(key) || topics.length < 2) continue;
    candidates.set(key, { repo, by: new Set(), topics });
  }
  return [...candidates.values()]
    .filter((entry) => entry.by.size >= 2 || entry.topics.length >= 2)
    .sort(
      (a, b) =>
        b.by.size * 2 + b.topics.length - (a.by.size * 2 + a.topics.length) ||
        b.repo.stars - a.repo.stars,
    )
    .slice(0, input.limit)
    .map(({ repo, by, topics }) => {
      const names = [...by].sort();
      const reason = [
        names.length > 0
          ? `최근 star: ${names.slice(0, 3).join(", ")}${names.length > 3 ? ` 외 ${names.length - 3}명` : ""}`
          : "",
        topics.length > 0 ? `관심 topic: ${topics.slice(0, 3).join(", ")}` : "",
      ]
        .filter(Boolean)
        .join(" · ");
      return {
        externalId: repo.fullName.toLowerCase(),
        url: `https://github.com/${repo.fullName}`,
        title: `⭐ GitHub 추천 · ${repo.fullName}`,
        body: [reason, `★${repo.stars}`, repo.description]
          .filter(Boolean)
          .join(" · "),
        author: repo.owner,
        publishedAt: input.now.toISOString(),
        metadata: {
          repository: repo.fullName,
          stars: repo.stars,
          neighbors: names,
          topics,
          eventType: "star_recommendation",
        },
      };
    });
}

type JsonGetter = (path: string) => Promise<unknown>;

function toRepository(value: unknown): StarredRepository | null {
  const record = value as Record<string, unknown> | null;
  const repo = (record?.repo ?? record) as Record<string, unknown> | undefined;
  const fullName = typeof repo?.full_name === "string" ? repo.full_name : "";
  const owner = (repo?.owner as Record<string, unknown> | undefined)?.login;
  if (!fullName || typeof owner !== "string") return null;
  return {
    fullName,
    owner,
    description: typeof repo?.description === "string" ? repo.description : "",
    stars: Number(repo?.stargazers_count ?? 0),
    topics: Array.isArray(repo?.topics)
      ? repo.topics.filter((t): t is string => typeof t === "string")
      : [],
    starredAt:
      typeof record?.starred_at === "string" ? record.starred_at : null,
    fork: repo?.fork === true,
    archived: repo?.archived === true,
  };
}

const repositories = (value: unknown) =>
  (Array.isArray(value) ? value : [])
    .map(toRepository)
    .filter((repo): repo is StarredRepository => repo !== null);

export class GitHubStarRecommender {
  private readonly getJson: JsonGetter;

  constructor(
    token?: string,
    options: SourceHttpOptions = {},
    getJson?: JsonGetter,
  ) {
    this.getJson =
      getJson ??
      (async (path) => {
        const { body } = await readSource(
          `https://api.github.com/${path}`,
          {
            Accept: "application/vnd.github.star+json",
            "User-Agent": "rapi",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          options,
        );
        return JSON.parse(body) as unknown;
      });
  }

  async recommend(
    user: string,
    exclude: ReadonlySet<string>,
    limit = 5,
    now = new Date(),
  ): Promise<ExternalItem[]> {
    const mine: StarredRepository[] = [];
    for (let page = 1; page <= 3; page += 1) {
      const batch = repositories(
        await this.getJson(
          `users/${encodeURIComponent(user)}/starred?per_page=100&page=${page}`,
        ),
      );
      mine.push(...batch);
      if (batch.length < 100) break;
    }
    if (mine.length === 0) return [];
    const owners: string[] = [];
    for (const repo of [...mine].sort((a, b) =>
      (b.starredAt ?? "").localeCompare(a.starredAt ?? ""),
    )) {
      const owner = repo.owner;
      if (owner.toLowerCase() !== user.toLowerCase() && !owners.includes(owner))
        owners.push(owner);
      if (owners.length === 30) break;
    }
    // A neighbor with private stars or a transient error must not drop the day.
    const neighbors = await Promise.all(
      owners.map(async (login) => ({
        login,
        starred: await this.getJson(
          `users/${encodeURIComponent(login)}/starred?per_page=30`,
        ).then(repositories, () => []),
      })),
    );
    const since = new Date(now.getTime() - 30 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const topicCandidates: StarredRepository[] = [];
    for (const topic of topTopics(mine, 4)) {
      const result = (await this.getJson(
        `search/repositories?q=${encodeURIComponent(`topic:${topic} created:>${since}`)}&sort=stars&order=desc&per_page=10`,
      ).catch(() => null)) as { items?: unknown } | null;
      topicCandidates.push(...repositories(result?.items));
    }
    return rankStarRecommendations({
      user,
      mine,
      neighbors,
      topicCandidates,
      exclude,
      now,
      limit,
    });
  }
}

// 100 a page: enough for the owner's stars without spending the unauthenticated limit.
const OWN_STAR_PAGES = 10;
const FULL_NAME = /^[\w.-]+\/[\w.-]+$/;

function toOwnStar(value: unknown): GitHubStar {
  const record = value as Record<string, unknown> | null;
  const repo = record?.repo as Record<string, unknown> | undefined;
  const fullName = repo?.full_name;
  if (typeof fullName !== "string" || !FULL_NAME.test(fullName))
    throw new Error("GitHub star has no repository name");
  if (typeof record?.starred_at !== "string")
    throw new Error("GitHub star has no starred_at");
  return {
    fullName,
    url: `https://github.com/${fullName}`,
    description:
      typeof repo?.description === "string"
        ? clip(plainLine(repo.description), STAR_DESCRIPTION_MAX_CHARS)
        : "",
    language:
      typeof repo?.language === "string"
        ? clip(plainLine(repo.language), 50)
        : null,
    stars: Number(repo?.stargazers_count ?? 0),
    archived: repo?.archived === true,
    starredAt: record.starred_at,
  };
}

/**
 * The owner's stars, oldest first, because a bounded read should not lose the old
 * ones. Any failed page or odd answer throws, so a bad day never looks like the
 * owner removing their stars. `complete` says whether the last page was reached.
 */
export async function readOwnStars(
  login: string,
  token?: string,
  options: SourceHttpOptions = {},
): Promise<{ stars: GitHubStar[]; complete: boolean }> {
  // A star added between two pages can show the same repository twice.
  const stars = new Map<string, GitHubStar>();
  for (let page = 1; page <= OWN_STAR_PAGES; page += 1) {
    const { response, body } = await readSource(
      `https://api.github.com/users/${encodeURIComponent(login)}/starred?direction=asc&per_page=100&page=${page}`,
      {
        Accept: "application/vnd.github.star+json",
        "User-Agent": "rapi",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      options,
    );
    const batch = JSON.parse(body) as unknown;
    if (!Array.isArray(batch))
      throw new Error("GitHub stars response is not a list");
    for (const star of batch.map(toOwnStar)) stars.set(star.fullName, star);
    if (!response.headers.get("link")?.includes('rel="next"')) {
      if (stars.size === 0) throw new Error("GitHub returned no stars");
      return { stars: [...stars.values()], complete: true };
    }
  }
  return { stars: [...stars.values()], complete: false };
}
