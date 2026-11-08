import type { DigTrail, GitHubStar, StoredStar } from "@rapi/domain";

export interface StarSubscriber {
  userId: string;
  /** Whose stars are read; their GitHub connection, or the owner's configured login. */
  githubLogin: string;
  subscribedAt: Date;
  pausedAt: Date | null;
  pausedReason: string | null;
}

export interface StarStore {
  saveStars(stars: readonly GitHubStar[], complete: boolean): Promise<void>;
  currentStars(): Promise<StoredStar[]>;
  starInterests(): Promise<{
    picked: Record<string, number>;
    votes: {
      fullName: string;
      vote: number;
      facets: string[];
      votedAt: Date;
    }[];
  }>;
  saveStarInterests(facets: Record<string, number>): Promise<void>;
  saveStarVote(
    fullName: string,
    vote: 1 | -1,
    facets: readonly string[],
  ): Promise<void>;
  starRepo(fullName: string): Promise<GitHubStar | null>;
  saveStarSuggestion(
    repo: GitHubStar,
    trail?: { kind: string; seed: string },
  ): Promise<void>;
  starDigHistory(): Promise<
    {
      fullName: string;
      kind: string | null;
      seed: string | null;
      suggestedAt: Date;
      vote: number | null;
      votedAt: Date | null;
    }[]
  >;
  saveStarNeighbors(
    neighbors: readonly { login: string; shared: number; from: string }[],
  ): Promise<void>;
  starNeighbors(limit: number): Promise<{ login: string; shared: number }[]>;
  markStarNeighborsFollowed(logins: readonly string[]): Promise<void>;
  seenStarRepos(): Promise<Set<string>>;
  starReminderClaimed(day: string): Promise<boolean>;
  claimStarReminder(
    day: string,
    stars: readonly StoredStar[],
  ): Promise<boolean>;
  releaseStarReminder(day: string, stars: readonly StoredStar[]): Promise<void>;
  saveStarReminderMessage(day: string, messageId: string): Promise<void>;
}

export interface StarSubscriberStore {
  starsOf(userId: string): StarStore;
  starSubscribers(): Promise<StarSubscriber[]>;
  starSubscriber(userId: string): Promise<StarSubscriber | null>;
  saveStarSubscriber(userId: string, githubLogin: string): Promise<void>;
  pauseStarSubscriber(userId: string, reason: string): Promise<void>;
  removeStarSubscriber(userId: string): Promise<boolean>;
}

/** What reads GitHub, each time with the token of the person it is for. */
export interface GitHubGateway {
  readStars(
    login: string,
    token: string | undefined,
  ): Promise<{ stars: GitHubStar[]; complete: boolean }>;
  digTrails?: (
    seeds: string[],
    token: string | undefined,
  ) => Promise<DigTrail[]>;
  followNeighbors?: (
    logins: string[],
    token: string | undefined,
  ) => Promise<Array<{ login: string; starred: GitHubStar[] }>>;
  searchRepos?: (
    queries: string[],
    token: string | undefined,
  ) => Promise<GitHubStar[]>;
}

/** What the daily reminder needs of one person's star store; digging is optional. */
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
