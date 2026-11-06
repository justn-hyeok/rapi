import { plainText, type DiscountCandidate } from "@rapi/core";
import type { CandidateResult } from "./discount-candidates.js";
import { readSource, type SourceHttpOptions } from "./sources.js";

/** A repository whose commit messages record plan and price changes. */
export interface CommitLogSource {
  repository: string;
}

// jiegec/kb writes plan changes as "kb: ..." or "coding plan: ..."; its other
// commits are about chips, cooking and dependencies.
const PLAN_COMMIT = /^(?:kb|coding[ _-]plan|docs\(coding[ _-]plan\))\s*:/i;
// Something given or made cheaper.
const GIVES =
  /限时免费|免费额度|免费模型|免费|半价|\d+(?:\.\d+)?\s*折|折扣|降价|优惠|赠送|提高.{0,40}额度|额度.{0,6}提高|free|half price|discount|% off/i;
// Something taken away, which the same words also describe.
const TAKES =
  /结束|取消|移除|下线|不再|停止|到期|ends?\b|ended|drops?\b|removed?/i;

export function isPlanOffer(message: string): boolean {
  return (
    PLAN_COMMIT.test(message) && GIVES.test(message) && !TAKES.test(message)
  );
}

const COMMITS_PER_RUN = 100;

/**
 * New commits since the last run whose message records something given away or
 * made cheaper. The card links the commit, a stranger's record, so its row has
 * no domain. The first run only records where the log stands.
 */
export class CommitLogRoute {
  constructor(
    private readonly token: string | undefined,
    private readonly options: SourceHttpOptions = {},
  ) {}

  async collect(
    source: CommitLogSource,
    cursor: string | null,
  ): Promise<CandidateResult> {
    const params = new URLSearchParams({ per_page: String(COMMITS_PER_RUN) });
    if (cursor) params.set("since", cursor);
    const { body } = await readSource(
      `https://api.github.com/repos/${source.repository}/commits?${params}`,
      {
        Accept: "application/vnd.github+json",
        "User-Agent": "rapi",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
      this.options,
    );
    const commits = JSON.parse(body) as Array<{
      sha: string;
      html_url: string;
      commit: { message: string; committer?: { date?: string } | null };
    }>;
    const newest = commits
      .map((commit) => commit.commit.committer?.date ?? "")
      .filter(Boolean)
      .sort()
      .at(-1);
    const next = newest ?? cursor ?? new Date().toISOString();
    if (!cursor) return { candidates: [], cursor: next };
    const candidates: DiscountCandidate[] = commits.flatMap((commit) => {
      const message = commit.commit.message.split("\n")[0] ?? "";
      if (!isPlanOffer(message)) return [];
      return [
        {
          kind: "discount",
          route: "commit_log",
          dedupeKey: `commit_log:${source.repository}@${commit.sha}`,
          domain: null,
          title: plainText(message.replace(PLAN_COMMIT, ""), 300),
          url: commit.html_url,
          evidence: `${source.repository} 커밋`,
          publishedAt: commit.commit.committer?.date ?? null,
        },
      ];
    });
    return { candidates, cursor: next };
  }
}
