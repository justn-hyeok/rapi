import assert from "node:assert/strict";
import { test } from "node:test";
import { CommitLogRoute, isPlanOffer } from "@rapi/adapters";
import { loadDiscountSources } from "@rapi/agent";

test("a plan commit counts when it gives something, not when it takes it away", () => {
  for (const message of [
    "coding plan: 阿里云百炼 Token Plan 个人版新增新用户限时半价（19.5/39.5，至 2026-11-30）",
    "kb: Command Code 新增限时免费模型 Crouton Alpha（模型库 97→98 款）",
    "kb: Command Code Pro 档 DeepSeek V4.1 Flash 与 GLM-5.3 Flash 月额度由 $90 提高至 $110",
    "docs(coding_plan): OpenCode Go 提高 DeepSeek V4.1 Flash 月额度至 $100/$200",
  ])
    assert.ok(isPlanOffer(message), message);
  for (const message of [
    "kb: Command Code Ling 3.1 Flash 1019 限时免费结束，转为 $0.30/$0.90/$0.06 计费",
    "kb: Command Code 移除限时免费模型 Laguna S 2.1",
    "coding_plan: 阿里云百炼取消 qwen-image-2.0 系列免费额度",
    "kb: 商汤 SenseNova TokenPlan 新增 GLM-5.3（支持模型 8→9 款）",
    "Add more huawei chips",
  ])
    assert.ok(!isPlanOffer(message), message);
});

const commit = (sha: string, message: string, date: string) => ({
  sha,
  html_url: `https://github.com/o/kb/commit/${sha}`,
  commit: { message, committer: { date } },
});
function github(commits: unknown[], asked: string[]): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    asked.push(
      `${url} ${(init?.headers as Record<string, string>).Authorization ?? "-"}`,
    );
    return new Response(JSON.stringify(commits));
  }) as typeof fetch;
}

test("the first look records where the log stands and reports nothing", async () => {
  const asked: string[] = [];
  const result = await new CommitLogRoute(undefined, {
    fetch: github(
      [commit("a", "kb: 新增限时免费模型 X", "2026-11-05T01:00:00Z")],
      asked,
    ),
  }).collect({ repository: "o/kb" }, null);
  assert.deepEqual(result, { candidates: [], cursor: "2026-11-05T01:00:00Z" });
  assert.deepEqual(asked, [
    "https://api.github.com/repos/o/kb/commits?per_page=100 -",
  ]);
});

test("later runs ask from the last commit and keep offers only", async () => {
  const asked: string[] = [];
  const result = await new CommitLogRoute("read-token", {
    fetch: github(
      [
        commit(
          "b",
          "kb: Command Code 新增限时免费模型 Crouton Alpha\n\nbody",
          "2026-11-06T02:00:00Z",
        ),
        commit("c", "Bump dependencies", "2026-11-06T01:00:00Z"),
      ],
      asked,
    ),
  }).collect({ repository: "o/kb" }, "2026-11-05T01:00:00Z");
  assert.deepEqual(asked, [
    "https://api.github.com/repos/o/kb/commits?per_page=100&since=2026-11-05T01%3A00%3A00Z Bearer read-token",
  ]);
  assert.deepEqual(result, {
    candidates: [
      {
        kind: "discount",
        route: "commit_log",
        dedupeKey: "commit_log:o/kb@b",
        domain: null,
        title: "Command Code 新增限时免费模型 Crouton Alpha",
        url: "https://github.com/o/kb/commit/b",
        evidence: "o/kb 커밋",
        publishedAt: "2026-11-06T02:00:00Z",
      },
    ],
    cursor: "2026-11-06T02:00:00Z",
  });
});

test("the shipped plan log is jiegec/kb", async () => {
  const sources = await loadDiscountSources(process.cwd());
  assert.deepEqual(sources.commitLogs, [{ repository: "jiegec/kb" }]);
});
