import type {
  CandidateForCard,
  CandidateForDecision,
  CandidateToVerify,
  CandidateVerification,
  DiscountCandidate,
  DiscountCandidateRoute,
  ProblemReportForCard,
} from "@rapi/domain";
import { UNVETTED_ROUTES } from "@rapi/domain";
import type { DiscountCandidateStore } from "@rapi/application";
import type { PostgresDatabase } from "./database.js";

// The moment the publication that is $1 places back leaves the hour, if there is one.
const PUBLICATION_RETRY_AT = `SELECT decided_at + interval '1 hour' AS "retryAt"
  FROM discount_candidates
  WHERE status = 'published' AND decided_at > now() - interval '1 hour'
  ORDER BY decided_at DESC OFFSET $1 LIMIT 1`;

/** Discount candidates, their checks and their cards. */
export class PostgresDiscountCandidateStore implements DiscountCandidateStore {
  constructor(private readonly db: PostgresDatabase) {}

  /** Re-seeing a candidate changes nothing; returns whether this one is new. */
  /**
   * Deals people reported since a time, each with when a route had first found
   * the same domain, or null. A report with no earlier find is one Rapi missed.
   */
  async reportedDeals(since: Date): Promise<
    Array<{
      domain: string;
      url: string;
      reportedAt: Date;
      foundAt: Date | null;
      foundBy: string | null;
    }>
  > {
    const { rows } = await this.db.pool.query<{
      domain: string;
      url: string;
      reported_at: Date;
      found_at: Date | null;
      found_by: string | null;
    }>(
      `SELECT r.domain, r.url, r.first_seen_at AS reported_at,
              found.first_seen_at AS found_at, found.route AS found_by
       FROM discount_candidates r
       LEFT JOIN LATERAL (
         SELECT c.first_seen_at, c.route FROM discount_candidates c
         WHERE c.route <> 'report' AND c.domain = r.domain
           AND c.first_seen_at <= r.first_seen_at
         ORDER BY c.first_seen_at LIMIT 1
       ) found ON true
       WHERE r.route = 'report' AND r.kind = 'discount' AND r.first_seen_at >= $1
       ORDER BY r.first_seen_at`,
      [since],
    );
    return rows.map((row) => ({
      domain: row.domain,
      url: row.url,
      reportedAt: row.reported_at,
      foundAt: row.found_at,
      foundBy: row.found_by,
    }));
  }

  /** Which of these keys are stored already. */
  async knownCandidateKeys(keys: readonly string[]): Promise<Set<string>> {
    const { rows } = await this.db.pool.query<{ dedupe_key: string }>(
      "SELECT dedupe_key FROM discount_candidates WHERE dedupe_key = ANY($1)",
      [[...keys]],
    );
    return new Set(rows.map((row) => row.dedupe_key));
  }

  async saveDiscountCandidate(candidate: DiscountCandidate): Promise<boolean> {
    const result = await this.db.pool.query(
      `INSERT INTO discount_candidates
         (kind, route, dedupe_key, domain, title, url, evidence, published_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [
        candidate.kind,
        candidate.route,
        candidate.dedupeKey,
        candidate.domain,
        candidate.title,
        candidate.url,
        candidate.evidence,
        candidate.publishedAt,
      ],
    );
    return result.rowCount === 1;
  }

  /** Oldest first. A row with a band has been decided, by the rules or the owner. */
  async unverifiedDiscountCandidates(
    limit: number,
    route?: DiscountCandidateRoute,
  ): Promise<CandidateToVerify[]> {
    const { rows } = await this.db.pool.query<CandidateToVerify>(
      `SELECT id, kind, route, domain, title, evidence FROM discount_candidates
       WHERE band IS NULL AND ($2::text IS NULL OR route = $2)
       ORDER BY first_seen_at, id LIMIT $1`,
      [limit, route ?? null],
    );
    return rows;
  }

  /**
   * Never overwrites a band, so a red set by hand stays red. A domain the owner
   * already decided against stays red for rows found after that decision.
   */
  async saveCandidateVerification(
    id: string,
    verification: CandidateVerification,
  ): Promise<void> {
    await this.db.pool.query(
      `UPDATE discount_candidates
       SET band = CASE WHEN EXISTS (
             SELECT 1 FROM problem_reports
             WHERE problem_reports.domain = discount_candidates.domain
               AND problem_reports.decision = 'red'
           ) THEN 'red' ELSE $2::text END,
           tags = $3, operator = $4, price_check = $5,
           terms_url = $6, terms_note = $7, verified_at = now()
       WHERE id = $1 AND band IS NULL`,
      [
        id,
        verification.band,
        verification.tags,
        verification.operator,
        verification.priceCheck,
        verification.termsUrl,
        verification.termsNote,
      ],
    );
  }

  /**
   * Newest first. The published date decides when there is one: a first collection
   * finds months-old changelog entries, and they are not news just because they
   * were first seen this week.
   */
  async candidatesForCards(limit: number): Promise<CandidateForCard[]> {
    const { rows } = await this.db.pool.query<CandidateForCard>(
      `SELECT id, kind, route, domain, title, url, evidence, band, tags, operator,
              price_check AS "priceCheck", terms_note AS "termsNote", memo
       FROM discount_candidates
       WHERE carded_at IS NULL AND band IN ('green', 'yellow')
         AND COALESCE(published_at, first_seen_at) >= now() - interval '7 days'
       ORDER BY COALESCE(published_at, first_seen_at) DESC, id LIMIT $1`,
      [limit],
    );
    return rows;
  }

  /** Sent ones only: a row claimed without a message was never seen by anyone. */
  async newServiceCardsInLastDay(): Promise<number> {
    const { rows } = await this.db.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM discount_candidates
       WHERE kind = 'new_service' AND route <> 'report'
         AND card_message_id IS NOT NULL
         AND carded_at > now() - interval '24 hours'`,
    );
    return rows[0]!.count;
  }

  /** Sent ones only, as for new services. */
  async unvettedCardsInLastDay(): Promise<number> {
    const { rows } = await this.db.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM discount_candidates
       WHERE route = ANY($1)
         AND card_message_id IS NOT NULL
         AND carded_at > now() - interval '24 hours'`,
      [[...UNVETTED_ROUTES]],
    );
    return rows[0]!.count;
  }

  /** Both kinds of card go to the same channel, and the limit is the channel's. */
  async cardsInLastHour(): Promise<number> {
    const { rows } = await this.db.pool.query<{ count: number }>(
      `SELECT ((SELECT count(*) FROM discount_candidates
                WHERE carded_at > now() - interval '1 hour')
             + (SELECT count(*) FROM problem_reports
                WHERE carded_at > now() - interval '1 hour')
             + (SELECT count(*) FROM discord_guilds
                WHERE carded_at > now() - interval '1 hour'))::int AS count`,
    );
    return rows[0]!.count;
  }

  /** Taken before sending. False when another run has it or the owner just made it red. */
  async claimCandidateCard(id: string): Promise<boolean> {
    const result = await this.db.pool.query(
      `UPDATE discount_candidates SET carded_at = now()
       WHERE id = $1 AND carded_at IS NULL AND band IN ('green', 'yellow')`,
      [id],
    );
    return result.rowCount === 1;
  }

  /** Only for a send Discord refused, so the card goes out on a later run. */
  async releaseCandidateCard(id: string): Promise<void> {
    await this.db.pool.query(
      `UPDATE discount_candidates SET carded_at = NULL
       WHERE id = $1 AND card_message_id IS NULL`,
      [id],
    );
  }

  async saveCandidateCardMessage(id: string, messageId: string): Promise<void> {
    await this.db.pool.query(
      `UPDATE discount_candidates SET card_message_id = $2 WHERE id = $1`,
      [id, messageId],
    );
  }

  async candidateForDecision(id: string): Promise<CandidateForDecision | null> {
    const { rows } = await this.db.pool.query<CandidateForDecision>(
      `SELECT id, kind, route, domain, title, url, evidence, band, tags, operator,
              price_check AS "priceCheck", terms_note AS "termsNote", status
       FROM discount_candidates WHERE id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  /** When another card can go out, or null while the last hour has room. */
  async publicationRetryAt(perHour: number): Promise<Date | null> {
    const { rows } = await this.db.pool.query<{ retryAt: Date }>(
      PUBLICATION_RETRY_AT,
      [perHour - 1],
    );
    return rows[0]?.retryAt ?? null;
  }

  /**
   * Taken before sending, so double clicks and two open tabs send once. The lock
   * keeps two different cards from both taking the hour's last place. Over the
   * limit nothing changes and `retryAt` says when to try.
   */
  async claimCandidatePublication(
    id: string,
    perHour: number,
  ): Promise<{ claimed: boolean; retryAt: Date | null }> {
    return this.db.transaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('discount_publication'))",
      );
      const { rows } = await client.query<{ retryAt: Date }>(
        PUBLICATION_RETRY_AT,
        [perHour - 1],
      );
      if (rows[0]) return { claimed: false, retryAt: rows[0].retryAt };
      const result = await client.query(
        `UPDATE discount_candidates SET status = 'published', decided_at = now()
         WHERE id = $1 AND status = 'new' AND band IN ('green', 'yellow')`,
        [id],
      );
      return { claimed: result.rowCount === 1, retryAt: null };
    });
  }

  /** Only for a send Discord refused, so the owner can press the button again. */
  async releaseCandidatePublication(id: string): Promise<void> {
    await this.db.pool.query(
      `UPDATE discount_candidates SET status = 'new', decided_at = NULL
       WHERE id = $1 AND status = 'published' AND public_message_id IS NULL`,
      [id],
    );
  }

  async saveCandidatePublicMessage(
    id: string,
    messageId: string,
  ): Promise<void> {
    await this.db.pool.query(
      `UPDATE discount_candidates SET public_message_id = $2 WHERE id = $1`,
      [id, messageId],
    );
  }

  async discardCandidate(id: string): Promise<boolean> {
    const result = await this.db.pool.query(
      `UPDATE discount_candidates SET status = 'discarded', decided_at = now()
       WHERE id = $1 AND status = 'new'`,
      [id],
    );
    return result.rowCount === 1;
  }

  /** Oldest first: each is a question waiting for the owner. */
  async problemReportsForCards(limit: number): Promise<ProblemReportForCard[]> {
    const { rows } = await this.db.pool.query<ProblemReportForCard>(
      `SELECT id, url, domain, reporter_id AS "reporterId", memo
       FROM problem_reports
       WHERE carded_at IS NULL AND decision IS NULL
       ORDER BY reported_at, id LIMIT $1`,
      [limit],
    );
    return rows;
  }

  async claimProblemCard(id: string): Promise<boolean> {
    const result = await this.db.pool.query(
      `UPDATE problem_reports SET carded_at = now()
       WHERE id = $1 AND carded_at IS NULL AND decision IS NULL`,
      [id],
    );
    return result.rowCount === 1;
  }

  async releaseProblemCard(id: string): Promise<void> {
    await this.db.pool.query(
      `UPDATE problem_reports SET carded_at = NULL
       WHERE id = $1 AND card_message_id IS NULL`,
      [id],
    );
  }

  async saveProblemCardMessage(id: string, messageId: string): Promise<void> {
    await this.db.pool.query(
      `UPDATE problem_reports SET card_message_id = $2 WHERE id = $1`,
      [id, messageId],
    );
  }
}
