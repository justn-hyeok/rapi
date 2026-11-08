import { type StarStore, type StarSubscriber } from "@rapi/application";
import { PostgresStarStore } from "./star-store.js";
import type { StarSubscriberStore } from "@rapi/application";
import type { PostgresDatabase } from "./database.js";

// Tables keyed by owner besides interests and votes, which were per owner from the start.
const STAR_LOGIN_TABLES = [
  "github_stars",
  "star_reminder_days",
  "star_suggestions",
  "star_neighbors",
] as const;

/** Who gets star reminders, and each person's star store. */
export class PostgresStarSubscriberStore implements StarSubscriberStore {
  constructor(private readonly db: PostgresDatabase) {}

  /** One person's stars and everything learned from them. */
  starsOf(userId: string): StarStore {
    return new PostgresStarStore(
      this.db.pool,
      (work) => this.db.transaction(work),
      userId,
    );
  }

  /** Everyone who gets the daily DM, earliest first. */
  async starSubscribers(): Promise<StarSubscriber[]> {
    const { rows } = await this.db.pool.query<StarSubscriber>(
      `SELECT user_id AS "userId", github_login AS "githubLogin",
              subscribed_at AS "subscribedAt", paused_at AS "pausedAt",
              paused_reason AS "pausedReason"
       FROM star_subscribers ORDER BY subscribed_at, user_id`,
    );
    return rows;
  }

  async starSubscriber(userId: string): Promise<StarSubscriber | null> {
    const { rows } = await this.db.pool.query<StarSubscriber>(
      `SELECT user_id AS "userId", github_login AS "githubLogin",
              subscribed_at AS "subscribedAt", paused_at AS "pausedAt",
              paused_reason AS "pausedReason"
       FROM star_subscribers WHERE user_id = $1`,
      [userId],
    );
    return rows[0] ?? null;
  }

  /**
   * Turns reminders on for someone, or changes whose stars they read. A new
   * login drops the stars and neighbors read for the old one; the interests
   * they picked, their thumbs and what they were shown stay. Saving again
   * unpauses.
   */
  async saveStarSubscriber(userId: string, githubLogin: string): Promise<void> {
    await this.db.transaction(async (client) => {
      const before = await client.query<{ github_login: string }>(
        "SELECT github_login FROM star_subscribers WHERE user_id = $1 FOR UPDATE",
        [userId],
      );
      const old = before.rows[0]?.github_login;
      // What was read from the old login goes; what they were shown and when stays,
      // so nothing comes twice and today is not sent again.
      if (old !== undefined && old.toLowerCase() !== githubLogin.toLowerCase())
        for (const table of ["github_stars", "star_neighbors"])
          await client.query(`DELETE FROM ${table} WHERE user_id = $1`, [
            userId,
          ]);
      await client.query(
        `INSERT INTO star_subscribers (user_id, github_login) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET github_login = EXCLUDED.github_login,
           paused_at = NULL, paused_reason = NULL`,
        [userId, githubLogin],
      );
    });
  }

  /** Adds the configured owner once; a login they connected themselves wins. */
  async addStarSubscriber(userId: string, githubLogin: string): Promise<void> {
    await this.db.pool.query(
      `INSERT INTO star_subscribers (user_id, github_login) VALUES ($1, $2)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId, githubLogin],
    );
  }

  async pauseStarSubscriber(userId: string, reason: string): Promise<void> {
    await this.db.pool.query(
      `UPDATE star_subscribers SET paused_at = now(), paused_reason = $2
       WHERE user_id = $1 AND paused_at IS NULL`,
      [userId, reason.slice(0, 200)],
    );
  }

  /** Stops the DM and forgets everything about them. True when they were connected. */
  async removeStarSubscriber(userId: string): Promise<boolean> {
    return this.db.transaction(async (client) => {
      for (const table of [
        ...STAR_LOGIN_TABLES,
        "star_interests",
        "star_votes",
      ])
        await client.query(`DELETE FROM ${table} WHERE user_id = $1`, [userId]);
      const removed = await client.query(
        "DELETE FROM star_subscribers WHERE user_id = $1",
        [userId],
      );
      return removed.rowCount === 1;
    });
  }

  /** Hands the rows from before stars had owners to the configured owner. */
  async adoptOwnerlessStars(userId: string): Promise<number> {
    return this.db.transaction(async (client) => {
      let moved = 0;
      for (const table of STAR_LOGIN_TABLES)
        moved +=
          (
            await client.query(
              `UPDATE ${table} SET user_id = $1 WHERE user_id = ''`,
              [userId],
            )
          ).rowCount ?? 0;
      return moved;
    });
  }
}
