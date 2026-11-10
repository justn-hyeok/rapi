import { validDashboardLink, type DashboardSite } from "@rapi/application";
import {
  JOB_LABELS,
  sourceFailing,
  usd,
  type DashboardView,
} from "@rapi/domain";
import { page } from "./site-page.js";

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const pad = (value: number) => String(value).padStart(2, "0");

/** KST as YYYY-MM-DD HH:mm; a missing or unreadable time is "-". */
const kst = (value: string | null | undefined): string => {
  const time = value ? new Date(value) : undefined;
  if (!time || !Number.isFinite(time.getTime())) return "-";
  const seoul = new Date(time.getTime() + 9 * 3_600_000);
  return (
    `${seoul.getUTCFullYear()}-${pad(seoul.getUTCMonth() + 1)}-${pad(seoul.getUTCDate())} ` +
    `${pad(seoul.getUTCHours())}:${pad(seoul.getUTCMinutes())}`
  );
};

const GUILD_STATES: Record<string, string> = {
  allowed: "승인",
  pending: "대기",
  blocked: "차단",
  rejected: "거절",
  left: "나감",
};

const table = (head: string[], rows: string[][]) =>
  `<div class="scroll"><table><tr>${head.map((cell) => `<th>${cell}</th>`).join("")}</tr>${rows
    .map((cells) => `<tr>${cells.join("")}</tr>`)
    .join("")}</table></div>`;

const cell = (value: string, cls?: string) =>
  `<td${cls ? ` class="${cls}"` : ""}>${escapeHtml(value)}</td>`;

const STYLE =
  `<style>body{max-width:60rem;margin:2rem auto}table{border-collapse:collapse;width:100%;font-size:.9rem}` +
  `th,td{border-bottom:1px solid #8884;padding:.35rem .5rem;text-align:left;vertical-align:top}` +
  `.scroll{overflow-x:auto}.bad{font-weight:600}td.err{word-break:break-word}</style>`;

function dashboardBody(view: DashboardView, now: Date): string {
  const jobs = table(
    ["작업", "상태", "최근 시작", "최근 성공", "오류"],
    view.jobs.map((job) => {
      const status = job.lastError
        ? `<td class="bad">실패</td>`
        : job.running
          ? cell("실행 중")
          : job.lastSuccessAt
            ? cell("정상")
            : cell("아직 안 돌았어요");
      return [
        cell(JOB_LABELS[job.name] ?? job.name),
        status,
        cell(kst(job.lastStartedAt)),
        cell(kst(job.lastSuccessAt)),
        cell(job.lastError ?? "", "err"),
      ];
    }),
  );
  const failing = view.sources.filter(sourceFailing).length;
  const sources = table(
    ["종류", "주소", "상태", "최근 성공", "실패 횟수", "오류"],
    [
      ...view.sources.filter(sourceFailing),
      ...view.sources.filter((source) => !sourceFailing(source)),
    ].map((source) => [
      cell(source.kind),
      cell(source.locator),
      cell(source.state),
      cell(kst(source.lastSuccessAt)),
      cell(String(source.failureCount)),
      cell(source.lastError ?? "", "err"),
    ]),
  );
  const candidates = `<ul>${[
    `7일간 찾음 ${view.candidates.found7d}`,
    `7일간 카드 ${view.candidates.carded7d}`,
    `검토 대기 ${view.candidates.waiting}`,
    `게시 ${view.candidates.published}`,
    `버림 ${view.candidates.discarded}`,
  ]
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join("")}</ul>`;
  const models = view.models.length
    ? table(
        ["기능", "모델", "호출", "실패", "입력 토큰", "출력 토큰", "비용"],
        view.models.map((row) => [
          cell(row.feature),
          cell(row.model),
          cell(String(row.calls)),
          cell(String(row.failures)),
          cell(String(row.inputTokens)),
          cell(String(row.outputTokens)),
          cell(
            usd(row.costMicroUsd) +
              (row.unpriced > 0 ? ` (가격 모름 ${row.unpriced}건)` : ""),
          ),
        ]),
      )
    : `<p>이번 달 사용 기록이 없어요.</p>`;
  const guilds = view.guilds.length
    ? table(
        ["이름", "상태"],
        view.guilds.map((guild) => [
          cell(guild.name ?? "이름 없음"),
          cell(GUILD_STATES[guild.status] ?? guild.status),
        ]),
      )
    : `<p>등록된 서버가 없어요.</p>`;
  const people = `<ul>${[
    `스타 알림 받는 중 ${view.starsActive}명`,
    `스타 알림 멈춤 ${view.starsPaused}명`,
    `계정 연결 ${view.connections}명`,
  ]
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join("")}</ul>`;
  return (
    STYLE +
    `<h1>라피 대시보드</h1>` +
    `<p>기준: ${kst(now.toISOString())} KST. 새로 보려면 새로고침하세요.</p>` +
    `<h2>작업</h2>${jobs}` +
    `<h2>수집원</h2><p>전체 ${view.sources.length}개, 실패 ${failing}개</p>${sources}` +
    `<h2>할인 후보</h2>${candidates}` +
    `<h2>모델 사용 (이번 달)</h2>${models}` +
    `<h2>서버</h2>${guilds}` +
    `<h2>사람</h2>${people}`
  );
}

/**
 * The owner's read-only /dashboard page, behind a 24-hour signed link like
 * /help's. Other paths and methods are not this page's, so it answers null.
 */
export function dashboardPages(site: DashboardSite | undefined) {
  return async (
    method: string,
    url: URL,
  ): Promise<{ status: number; type: string; body: string } | null> => {
    if (!site || method !== "GET" || url.pathname !== "/dashboard") return null;
    const now = new Date();
    if (
      !validDashboardLink(
        site,
        url.searchParams.get("u"),
        url.searchParams.get("t"),
        now,
      )
    )
      return {
        status: 401,
        type: "text/html",
        body: page(
          "라피 · 대시보드",
          "<p>링크가 만료됐습니다. Discord에서 /대시보드를 다시 해 주세요.</p>",
        ),
      };
    let view: DashboardView;
    try {
      view = await site.view();
    } catch (error) {
      process.stderr.write(
        `dashboard: ${error instanceof Error ? error.message.slice(0, 200) : "failed"}\n`,
      );
      return {
        status: 500,
        type: "text/html",
        body: page(
          "라피 · 대시보드",
          "<p>지금은 불러오지 못했습니다. 잠시 뒤 다시 해 주세요.</p>",
        ),
      };
    }
    return {
      status: 200,
      type: "text/html",
      body: page("라피 · 대시보드", dashboardBody(view, now)),
    };
  };
}
