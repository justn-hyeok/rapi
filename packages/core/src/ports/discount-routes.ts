import type { DiscountCandidate } from "../domain/discount-candidates.js";
import type { ServicePage } from "../domain/candidate-verification.js";

export interface CandidateResult {
  candidates: DiscountCandidate[];
  // Set when part of a source failed but the rest is still worth keeping.
  problem?: string;
  // What the next run compares against, for a source that says nothing about what changed.
  cursor?: string;
}

/** One place discount candidates are looked for: a feed, a repository, a search. */
export interface CandidateJob {
  kind: string;
  locator: string;
  /** Absent when the route cannot run; `skipped` says why. */
  collect?: (cursor: () => Promise<string | null>) => Promise<CandidateResult>;
  skipped?: string;
}

/** A service's own pages, read to check a candidate. */
export interface ServicePages {
  read(domain: string): Promise<ServicePage | null>;
  offer(
    domain: string,
    page: ServicePage | null,
  ): Promise<DiscountCandidate | null>;
}
