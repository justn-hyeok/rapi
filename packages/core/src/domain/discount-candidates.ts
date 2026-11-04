export type DiscountCandidateKind = "new_service" | "discount";
export type DiscountCandidateRoute =
  | "code_search"
  | "pull_request"
  | "changelog";

export interface DiscountCandidate {
  kind: DiscountCandidateKind;
  route: DiscountCandidateRoute;
  dedupeKey: string;
  domain: string | null;
  title: string;
  url: string;
  evidence: string;
  publishedAt: string | null;
}

export const DISCOUNT_EVIDENCE_MAX_CHARS = 600;
