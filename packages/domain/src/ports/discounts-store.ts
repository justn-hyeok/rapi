import type {
  CandidateToVerify,
  CandidateVerification,
} from "../domain/candidate-verification.js";
import type {
  DiscountCandidate,
  DiscountCandidateRoute,
  NewReport,
  ReportOutcome,
} from "../domain/discount-candidates.js";
import type {
  CandidateForCard,
  CandidateForDecision,
  ProblemDecision,
  ProblemReportForCard,
} from "../domain/discount-cards.js";

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
