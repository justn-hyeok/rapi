import type { DashboardView } from "@rapi/domain";
import {
  signedLinkToken,
  validSignedLinkToken,
} from "../shared/signed-link.js";

export const DASHBOARD_LINK_DAYS = 1;
const LINK_LABEL = "rapi dashboard link";

/** The /dashboard page: signed like the /help link, owner only, 24 hours. */
export interface DashboardSite {
  secret: string;
  baseUrl: string;
  ownerIds: readonly string[];
  view: () => Promise<DashboardView>;
}

/** The /dashboard address for the owner, valid for one day. */
export function dashboardUrl(
  site: Pick<DashboardSite, "secret" | "baseUrl">,
  userId: string,
  now: Date,
): string {
  const token = signedLinkToken(
    site.secret,
    LINK_LABEL,
    userId,
    DASHBOARD_LINK_DAYS,
    now,
  );
  return `${site.baseUrl.replace(/\/+$/, "")}/dashboard?u=${userId}&t=${token}`;
}

/** Owner only, and the token is that owner's and has not expired. */
export function validDashboardLink(
  site: Pick<DashboardSite, "secret" | "ownerIds">,
  userId: string | null,
  token: string | null,
  now: Date,
): boolean {
  return (
    !!userId &&
    site.ownerIds.includes(userId) &&
    validSignedLinkToken(site.secret, LINK_LABEL, userId, token, now)
  );
}
