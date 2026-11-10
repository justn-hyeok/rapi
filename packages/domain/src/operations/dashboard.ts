import { escapeMarkdown } from "../discounts/cards.js";

export interface DashboardJob {
  name: string;
  running: boolean;
  lastStartedAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
}

export interface DashboardSource {
  kind: string;
  locator: string;
  state: string;
  lastSuccessAt: string | null;
  lastError: string | null;
  failureCount: number;
}

export interface DashboardCandidates {
  found7d: number;
  carded7d: number;
  waiting: number;
  published: number;
  discarded: number;
}

export interface DashboardModelRow {
  feature: string;
  model: string;
  calls: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  costMicroUsd: number;
  unpriced: number;
}

export interface DashboardGuild {
  name: string | null;
  status: string;
}

export interface DashboardNumbers {
  sources: DashboardSource[];
  candidates: DashboardCandidates;
  models: DashboardModelRow[];
  guilds: DashboardGuild[];
  starsActive: number;
  starsPaused: number;
  connections: number;
}

export interface DashboardView extends DashboardNumbers {
  jobs: DashboardJob[];
}

export const JOB_LABELS: Record<string, string> = {
  collection: "수집",
  curation: "소식 카드",
  candidates: "후보 수집",
  cards: "카드 보내기",
  stars: "스타 알림",
};

export function sourceFailing(source: DashboardSource): boolean {
  return source.lastError !== null || source.failureCount > 0;
}

export function usd(micro: number): string {
  return `$${(micro / 1_000_000).toFixed(2)}`;
}

export function dashboardSummary(view: DashboardView, link?: string): string {
  const failingJobs = view.jobs.filter((job) => job.lastError);
  const failingSources = view.sources.filter(sourceFailing);
  const calls = view.models.reduce((sum, row) => sum + row.calls, 0);
  const failures = view.models.reduce((sum, row) => sum + row.failures, 0);
  const cost = view.models.reduce((sum, row) => sum + row.costMicroUsd, 0);
  const unpriced = view.models.reduce((sum, row) => sum + row.unpriced, 0);
  const guilds = (status: string) =>
    view.guilds.filter((guild) => guild.status === status).length;
  const lines = [
    "**라피 대시보드**",
    `작업: ${view.jobs.length}개 중 실패 ${failingJobs.length}개`,
    ...failingJobs.map(
      (job) =>
        `- ${JOB_LABELS[job.name] ?? job.name}: ${escapeMarkdown(job.lastError ?? "")}`,
    ),
    `수집원: ${view.sources.length}개 중 실패 ${failingSources.length}개`,
    `후보: 7일간 찾음 ${view.candidates.found7d} · 카드 ${view.candidates.carded7d} · 대기 ${view.candidates.waiting} · 게시 ${view.candidates.published} · 버림 ${view.candidates.discarded}`,
    `모델 이번 달: 호출 ${calls} · 실패 ${failures} · ${usd(cost)}` +
      (unpriced > 0 ? ` · 가격 모름 ${unpriced}건` : ""),
    `서버: 승인 ${guilds("allowed")} · 대기 ${guilds("pending")} · 차단 ${guilds("blocked")}`,
    `스타 알림: ${view.starsActive}명 받는 중 · ${view.starsPaused}명 멈춤`,
  ];
  if (link)
    lines.push("", `자세히: <${link}>`, "링크는 24시간 동안 쓸 수 있어요.");
  return lines.join("\n");
}
