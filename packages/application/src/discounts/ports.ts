import type {
  CandidateForCard,
  CandidateForDecision,
  CandidateToVerify,
  CandidateVerification,
  DiscountCandidate,
  DiscountCandidateRoute,
  NewReport,
  ProblemDecision,
  ProblemReportForCard,
  ReportOutcome,
  ServicePage,
} from "@rapi/domain";

export interface DiscountCandidateStore {
  knownCandidateKeys(keys: readonly string[]): Promise<Set<string>>;
  saveDiscountCandidate(candidate: DiscountCandidate): Promise<boolean>;
  unverifiedDiscountCandidates(
    limit: number,
    route?: DiscountCandidateRoute,
  ): Promise<CandidateToVerify[]>;
  saveCandidateVerification(
    id: string,
    verification: CandidateVerification,
  ): Promise<void>;
  candidatesForCards(limit: number): Promise<CandidateForCard[]>;
  newServiceCardsInLastDay(): Promise<number>;
  unvettedCardsInLastDay(): Promise<number>;
  cardsInLastHour(): Promise<number>;
  claimCandidateCard(id: string): Promise<boolean>;
  releaseCandidateCard(id: string): Promise<void>;
  saveCandidateCardMessage(id: string, messageId: string): Promise<void>;
  candidateForDecision(id: string): Promise<CandidateForDecision | null>;
  publicationRetryAt(perHour: number): Promise<Date | null>;
  claimCandidatePublication(
    id: string,
    perHour: number,
  ): Promise<{ claimed: boolean; retryAt: Date | null }>;
  releaseCandidatePublication(id: string): Promise<void>;
  saveCandidatePublicMessage(id: string, messageId: string): Promise<void>;
  discardCandidate(id: string): Promise<boolean>;
  problemReportsForCards(limit: number): Promise<ProblemReportForCard[]>;
  claimProblemCard(id: string): Promise<boolean>;
  releaseProblemCard(id: string): Promise<void>;
  saveProblemCardMessage(id: string, messageId: string): Promise<void>;
}

export interface ReportStore {
  saveReport(report: NewReport, perHour: number): Promise<ReportOutcome>;
  decideProblemReport(
    id: string,
    decision: ProblemDecision,
    decidedBy: string,
  ): Promise<{
    url: string;
    domain: string;
    turnedRed: number;
    alreadyPublished: number;
  } | null>;
}

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
export interface ServicePageGateway {
  read(domain: string): Promise<ServicePage | null>;
  offer(
    domain: string,
    page: ServicePage | null,
  ): Promise<DiscountCandidate | null>;
}
