import type { DashboardNumbers } from "@rapi/domain";

export interface DashboardStore {
  dashboardNumbers(now: Date): Promise<DashboardNumbers>;
}
