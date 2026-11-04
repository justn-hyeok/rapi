import { readFile } from "node:fs/promises";
import {
  ChangelogRoute,
  CodeSearchRoute,
  PullRequestRoute,
  readServicePage,
  type CandidateResult,
  type ChangelogSource,
  type ResolveHostname,
  type SourceHttpOptions,
} from "@rapi/adapters";
import { knownOperator, verifyCandidate, type KnownOperator } from "@rapi/core";
import type { PostgresStore } from "@rapi/db";

export interface DiscountSources {
  changelogs: ChangelogSource[];
  pullRequests: { repository: string };
  codeSearch: { queries: string[]; denylist: string[] };
  operators: KnownOperator[];
}

export async function loadDiscountSources(
  root: string,
): Promise<DiscountSources> {
  return JSON.parse(
    await readFile(`${root}/config/discount-sources.json`, "utf8"),
  ) as DiscountSources;
}

type CandidateStore = Pick<
  PostgresStore,
  | "createSource"
  | "saveCursor"
  | "recordSourceFailure"
  | "saveDiscountCandidate"
>;

const NO_TOKEN = "GITHUB_READ_TOKEN이 없어 건너뜀";

/**
 * One pass over every route, recording only: nothing is posted. Each source has
 * its own row in `sources`, so `/수집원` shows its last success and last error,
 * and one failing never stops the next. Returns the sources that failed.
 */
export async function collectDiscountCandidates(input: {
  store: CandidateStore;
  sources: DiscountSources;
  githubToken?: string | undefined;
  http?: SourceHttpOptions;
  now?: () => Date;
}): Promise<string[]> {
  const { store, sources, githubToken: token, http } = input;
  const changelog = new ChangelogRoute(http, input.now);
  const pullRequests = token && new PullRequestRoute(token, http);
  const codeSearch =
    token && new CodeSearchRoute(token, sources.codeSearch.denylist, http);
  const jobs: Array<{
    kind: string;
    locator: string;
    collect?: () => Promise<CandidateResult>;
  }> = [
    ...sources.changelogs.map((source) => ({
      kind: "candidate_changelog",
      locator: source.url,
      collect: () => changelog.collect(source),
    })),
    {
      kind: "candidate_pull_request",
      locator: sources.pullRequests.repository,
      ...(pullRequests && {
        collect: () => pullRequests.collect(sources.pullRequests.repository),
      }),
    },
    ...sources.codeSearch.queries.map((query) => ({
      kind: "candidate_code_search",
      locator: query,
      ...(codeSearch && { collect: () => codeSearch.collect(query) }),
    })),
  ];

  const failures: string[] = [];
  for (const job of jobs) {
    let sourceId: string | undefined;
    try {
      sourceId = await store.createSource(job.kind, job.locator, "public");
      if (!job.collect) {
        await store.recordSourceFailure(sourceId, NO_TOKEN);
        continue;
      }
      const { candidates, problem } = await job.collect();
      for (const candidate of candidates)
        await store.saveDiscountCandidate(candidate);
      if (problem) throw new Error(problem);
      await store.saveCursor(sourceId, new Date().toISOString(), null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "failed";
      failures.push(`${job.locator}: ${message}`);
      if (sourceId)
        await store.recordSourceFailure(sourceId, message).catch(() => {});
    }
  }
  return failures;
}

type VerificationStore = Pick<
  PostgresStore,
  "unverifiedDiscountCandidates" | "saveCandidateVerification"
>;

// Pages are read one at a time; anything past this waits for tomorrow's run.
const VERIFICATIONS_PER_RUN = 200;

/**
 * Decides the band and tags of every candidate without one. Nothing is posted. A
 * page that cannot be read is a result, recorded as such; only a row that could
 * not be checked or saved is a failure, and it is tried again on the next run.
 */
export async function verifyDiscountCandidates(input: {
  store: VerificationStore;
  operators: readonly KnownOperator[];
  http?: SourceHttpOptions & { resolve?: ResolveHostname };
}): Promise<string[]> {
  const { store, operators, http } = input;
  const failures: string[] = [];
  let candidates;
  try {
    candidates = await store.unverifiedDiscountCandidates(
      VERIFICATIONS_PER_RUN,
    );
  } catch (error) {
    return [
      `verification: ${error instanceof Error ? error.message : "failed"}`,
    ];
  }
  for (const candidate of candidates) {
    try {
      const page = candidate.domain
        ? await readServicePage(candidate.domain, http)
        : null;
      await store.saveCandidateVerification(
        candidate.id,
        verifyCandidate(
          candidate,
          knownOperator(candidate.domain, operators),
          page,
        ),
      );
    } catch (error) {
      failures.push(
        `${candidate.domain ?? candidate.id}: ${error instanceof Error ? error.message : "failed"}`,
      );
    }
  }
  return failures;
}
