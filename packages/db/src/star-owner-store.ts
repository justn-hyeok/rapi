import type { Pool, PoolClient } from "pg";
import { type StarOwnerStore } from "@rapi/application";
import type { GitHubStar, StoredStar } from "@rapi/domain";

/**
 * One person's GitHub stars and everything learned from them: what they picked
 * on the interest page, their thumbs, what they were shown, the neighbors kept
 * for them and the days they got a DM. Every query is bound to them.
 */
export class PostgresStarOwnerStore implements StarOwnerStore {
  constructor(
    private readonly pool: Pool,
    private readonly transaction: <T>(
      work: (client: PoolClient) => Promise<T>,
    ) => Promise<T>,
    readonly ownerId: string,
  ) {}

  /**
   * Today's list from GitHub. What the owner removed stops being reminded, only when
   * the whole list was read; the history stays in case they star it again.
   */
  async saveStars(
    stars: readonly GitHubStar[],
    complete: boolean,
  ): Promise<void> {
    await this.transaction(async (client) => {
      await client.query(
        `INSERT INTO github_stars
           (owner_id, full_name, url, description, language, stars_count, archived, starred_at,
            topics, pushed_at, repo_created_at, owner_type, license)
         SELECT $13, full_name, url, description, language, stars_count, archived, starred_at,
                string_to_array(topics, ' '), pushed_at, repo_created_at, owner_type, license
         FROM unnest($1::text[], $2::text[], $3::text[], $4::text[],
                     $5::int[], $6::boolean[], $7::timestamptz[], $8::text[],
                     $9::timestamptz[], $10::timestamptz[], $11::text[], $12::text[])
              AS s(full_name, url, description, language, stars_count, archived,
                   starred_at, topics, pushed_at, repo_created_at, owner_type, license)
         ON CONFLICT (owner_id, full_name) DO UPDATE
         SET url = EXCLUDED.url, description = EXCLUDED.description,
             language = EXCLUDED.language, stars_count = EXCLUDED.stars_count,
             archived = EXCLUDED.archived, starred_at = EXCLUDED.starred_at,
             topics = EXCLUDED.topics, pushed_at = EXCLUDED.pushed_at,
             repo_created_at = EXCLUDED.repo_created_at,
             owner_type = EXCLUDED.owner_type, license = EXCLUDED.license,
             unstarred_at = NULL`,
        [
          stars.map((star) => star.fullName),
          stars.map((star) => star.url),
          stars.map((star) => star.description),
          stars.map((star) => star.language),
          stars.map((star) => star.stars),
          stars.map((star) => star.archived),
          stars.map((star) => star.starredAt),
          // GitHub topics never hold a space.
          stars.map((star) => (star.topics ?? []).join(" ")),
          stars.map((star) => star.pushedAt ?? null),
          stars.map((star) => star.createdAt ?? null),
          stars.map((star) => star.ownerType ?? null),
          stars.map((star) => star.license ?? null),
          this.ownerId,
        ],
      );
      if (complete)
        await client.query(
          `UPDATE github_stars SET unstarred_at = now()
           WHERE owner_id = $2 AND unstarred_at IS NULL
             AND NOT full_name = ANY($1::text[])`,
          [stars.map((star) => star.fullName), this.ownerId],
        );
    });
  }

  async currentStars(): Promise<StoredStar[]> {
    const { rows } = await this.pool.query<StoredStar>(
      `SELECT full_name AS "fullName", url, description, language,
              stars_count AS stars, archived, starred_at AS "starredAt",
              last_reminded_at AS "lastRemindedAt", topics,
              pushed_at AS "pushedAt", repo_created_at AS "createdAt",
              owner_type AS "ownerType", license
       FROM github_stars WHERE owner_id = $1 AND unstarred_at IS NULL`,
      [this.ownerId],
    );
    return rows;
  }

  /** What the owner picked on the interest page, and every vote on a card. */
  async starInterests(): Promise<{
    picked: Record<string, number>;
    votes: Array<{
      fullName: string;
      vote: number;
      facets: string[];
      votedAt: Date;
    }>;
  }> {
    const [picked, votes] = await Promise.all([
      this.pool.query<{ facets: Record<string, number> }>(
        "SELECT facets FROM star_interests WHERE owner_id = $1",
        [this.ownerId],
      ),
      this.pool.query<{
        fullName: string;
        vote: number;
        facets: string[];
        votedAt: Date;
      }>(
        `SELECT full_name AS "fullName", vote, facets, voted_at AS "votedAt"
         FROM star_votes WHERE owner_id = $1 ORDER BY voted_at, full_name`,
        [this.ownerId],
      ),
    ]);
    return { picked: picked.rows[0]?.facets ?? {}, votes: votes.rows };
  }

  async saveStarInterests(facets: Record<string, number>): Promise<void> {
    await this.pool.query(
      `INSERT INTO star_interests (owner_id, facets) VALUES ($1, $2)
       ON CONFLICT (owner_id) DO UPDATE SET facets = EXCLUDED.facets, updated_at = now()`,
      [this.ownerId, JSON.stringify(facets)],
    );
  }

  /** A second vote on the same repository replaces the first. */
  async saveStarVote(
    fullName: string,
    vote: 1 | -1,
    facets: readonly string[],
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO star_votes (owner_id, full_name, vote, facets) VALUES ($1, $2, $3, $4)
       ON CONFLICT (owner_id, full_name) DO UPDATE
       SET vote = EXCLUDED.vote, facets = EXCLUDED.facets, voted_at = now()`,
      [this.ownerId, fullName, vote, facets],
    );
  }

  /** A repository the owner was shown: one of their stars, or one a dig or search found. */
  async starRepo(fullName: string): Promise<GitHubStar | null> {
    const { rows } = await this.pool.query<GitHubStar>(
      `SELECT full_name AS "fullName", url, description, language,
              stars_count AS stars, archived, starred_at::text AS "starredAt", topics,
              pushed_at::text AS "pushedAt", repo_created_at::text AS "createdAt",
              owner_type AS "ownerType", license
       FROM github_stars WHERE owner_id = $2 AND full_name = $1
       UNION ALL
       SELECT full_name, repo->>'url', repo->>'description', repo->>'language',
              (repo->>'stars')::int, false, suggested_at::text,
              ARRAY(SELECT jsonb_array_elements_text(COALESCE(repo->'topics', '[]'))),
              repo->>'pushedAt', repo->>'createdAt', repo->>'ownerType', repo->>'license'
       FROM star_suggestions WHERE owner_id = $2 AND full_name = $1
       LIMIT 1`,
      [fullName, this.ownerId],
    );
    return rows[0] ?? null;
  }

  async saveStarSuggestion(
    repo: GitHubStar,
    trail?: { kind: string; seed: string },
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO star_suggestions (owner_id, full_name, repo, trail_kind, trail_seed)
       VALUES ($5, $1, $2, $3, $4)
       ON CONFLICT (owner_id, full_name) DO NOTHING`,
      [
        repo.fullName,
        JSON.stringify(repo),
        trail?.kind ?? null,
        trail?.seed ?? null,
        this.ownerId,
      ],
    );
  }

  /** Every repository a dig or search showed, with the way it came and the owner's thumb. */
  async starDigHistory(): Promise<
    Array<{
      fullName: string;
      kind: string | null;
      seed: string | null;
      suggestedAt: Date;
      vote: number | null;
      votedAt: Date | null;
    }>
  > {
    const { rows } = await this.pool.query<{
      fullName: string;
      kind: string | null;
      seed: string | null;
      suggestedAt: Date;
      vote: number | null;
      votedAt: Date | null;
    }>(
      `SELECT s.full_name AS "fullName", s.trail_kind AS kind, s.trail_seed AS seed,
              s.suggested_at AS "suggestedAt", v.vote, v.voted_at AS "votedAt"
       FROM star_suggestions s
       LEFT JOIN star_votes v ON v.full_name = s.full_name AND v.owner_id = s.owner_id
       WHERE s.owner_id = $1
       ORDER BY s.suggested_at`,
      [this.ownerId],
    );
    return rows;
  }

  /** Keeps neighbors who share many stars; a known one keeps when it was followed. */
  async saveStarNeighbors(
    neighbors: ReadonlyArray<{ login: string; shared: number; from: string }>,
  ): Promise<void> {
    for (const neighbor of neighbors)
      await this.pool.query(
        `INSERT INTO star_neighbors (owner_id, login, shared, found_from)
         VALUES ($4, $1, $2, $3)
         ON CONFLICT (owner_id, login) DO UPDATE SET
           shared = GREATEST(star_neighbors.shared, EXCLUDED.shared),
           found_from = EXCLUDED.found_from, found_at = now()`,
        [neighbor.login, neighbor.shared, neighbor.from, this.ownerId],
      );
  }

  /** The kept neighbors to follow next: never followed first, then longest ago, closest first. */
  async starNeighbors(
    limit: number,
  ): Promise<Array<{ login: string; shared: number }>> {
    const { rows } = await this.pool.query<{ login: string; shared: number }>(
      `SELECT login, shared FROM star_neighbors WHERE owner_id = $2
       ORDER BY followed_at NULLS FIRST, shared DESC, login LIMIT $1`,
      [limit, this.ownerId],
    );
    return rows;
  }

  async markStarNeighborsFollowed(logins: readonly string[]): Promise<void> {
    if (logins.length === 0) return;
    await this.pool.query(
      `UPDATE star_neighbors SET followed_at = now()
       WHERE owner_id = $2 AND login = ANY($1)`,
      [logins, this.ownerId],
    );
  }

  /** Names a dig or search must not suggest: shown before, or any of the owner's stars. */
  async seenStarRepos(): Promise<Set<string>> {
    const { rows } = await this.pool.query<{ name: string }>(
      `SELECT lower(full_name) AS name FROM star_suggestions WHERE owner_id = $1
       UNION SELECT lower(full_name) FROM github_stars WHERE owner_id = $1`,
      [this.ownerId],
    );
    return new Set(rows.map((row) => row.name));
  }

  async starReminderClaimed(day: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      "SELECT 1 FROM star_reminder_days WHERE owner_id = $2 AND day = $1",
      [day, this.ownerId],
    );
    return rowCount === 1;
  }

  /** Taken before sending, with the stars marked. False when today is already taken. */
  async claimStarReminder(
    day: string,
    stars: readonly StoredStar[],
  ): Promise<boolean> {
    const names = stars.map((star) => star.fullName);
    return this.transaction(async (client) => {
      const claimed = await client.query(
        `INSERT INTO star_reminder_days (owner_id, day, repos) VALUES ($3, $1, $2)
         ON CONFLICT (owner_id, day) DO NOTHING`,
        [day, names, this.ownerId],
      );
      if (claimed.rowCount !== 1) return false;
      await client.query(
        `UPDATE github_stars
         SET last_reminded_at = now(), reminded_count = reminded_count + 1
         WHERE owner_id = $2 AND full_name = ANY($1::text[])`,
        [names, this.ownerId],
      );
      return true;
    });
  }

  /** Only for a send Discord refused: today is free again and the stars as they were. */
  async releaseStarReminder(
    day: string,
    stars: readonly StoredStar[],
  ): Promise<void> {
    await this.transaction(async (client) => {
      const freed = await client.query(
        `DELETE FROM star_reminder_days
         WHERE owner_id = $2 AND day = $1 AND message_id IS NULL`,
        [day, this.ownerId],
      );
      if (freed.rowCount !== 1) return;
      await client.query(
        `UPDATE github_stars SET last_reminded_at = earlier.last_at,
                reminded_count = reminded_count - 1
         FROM unnest($1::text[], $2::timestamptz[]) AS earlier(repo, last_at)
         WHERE owner_id = $3 AND full_name = earlier.repo`,
        [
          stars.map((star) => star.fullName),
          stars.map((star) => star.lastRemindedAt?.toISOString() ?? null),
          this.ownerId,
        ],
      );
    });
  }

  async saveStarReminderMessage(day: string, messageId: string): Promise<void> {
    await this.pool.query(
      "UPDATE star_reminder_days SET message_id = $2 WHERE owner_id = $3 AND day = $1",
      [day, messageId, this.ownerId],
    );
  }
}
