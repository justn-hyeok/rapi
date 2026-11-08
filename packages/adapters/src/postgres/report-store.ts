import type { NewReport, ProblemDecision, ReportOutcome } from "@rapi/domain";
import type { ReportStore } from "@rapi/application";
import type { PostgresDatabase } from "./database.js";

/** What people report with /제보. */
export class PostgresReportStore implements ReportStore {
  constructor(private readonly db: PostgresDatabase) {}

  /**
   * The limit and the insert share a lock per reporter, so sending six at once
   * still saves five. A link already reported saves nothing and does not count.
   */
  async saveReport(report: NewReport, perHour: number): Promise<ReportOutcome> {
    return this.db.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `report:${report.reporterId}`,
      ]);
      const { rows } = await client.query<{ count: number }>(
        `SELECT ((SELECT count(*) FROM discount_candidates
                  WHERE reporter_id = $1 AND first_seen_at > now() - interval '1 hour')
               + (SELECT count(*) FROM problem_reports
                  WHERE reporter_id = $1 AND reported_at > now() - interval '1 hour'))::int AS count`,
        [report.reporterId],
      );
      if (rows[0]!.count >= perHour) return "limited";
      const { url, domain, reporterId, memo } = report;
      const result =
        report.kind === "problem"
          ? await client.query(
              `INSERT INTO problem_reports (url, domain, reporter_id, memo)
               VALUES ($1, $2, $3, $4)
               ON CONFLICT (url) WHERE decision IS NULL DO NOTHING`,
              [url, domain, reporterId, memo],
            )
          : await client.query(
              `INSERT INTO discount_candidates
                 (kind, route, dedupe_key, domain, title, url, evidence, reporter_id, memo)
               VALUES ($1, 'report', $2, $3, $3, $4, '', $5, $6)
               ON CONFLICT (dedupe_key) DO NOTHING`,
              [report.kind, `report:${url}`, domain, url, reporterId, memo],
            );
      return result.rowCount === 1 ? "saved" : "duplicate";
    });
  }

  /**
   * Null when it was already decided. Red turns every row of the domain red at
   * once, and says how many of them had already gone to the public channel.
   */
  async decideProblemReport(
    id: string,
    decision: ProblemDecision,
    decidedBy: string,
  ): Promise<{
    url: string;
    domain: string;
    turnedRed: number;
    alreadyPublished: number;
  } | null> {
    return this.db.transaction(async (client) => {
      const { rows } = await client.query<{ url: string; domain: string }>(
        `UPDATE problem_reports
         SET decision = $2, decided_by = $3, decided_at = now()
         WHERE id = $1 AND decision IS NULL
         RETURNING url, domain`,
        [id, decision, decidedBy],
      );
      const report = rows[0];
      if (!report) return null;
      if (decision !== "red")
        return { ...report, turnedRed: 0, alreadyPublished: 0 };
      const red = await client.query<{ status: string }>(
        `UPDATE discount_candidates SET band = 'red' WHERE domain = $1 RETURNING status`,
        [report.domain],
      );
      return {
        ...report,
        turnedRed: red.rows.length,
        alreadyPublished: red.rows.filter((row) => row.status === "published")
          .length,
      };
    });
  }
}
