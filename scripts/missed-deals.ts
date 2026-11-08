import { loadEnvironment } from "@rapi/config";
import { PostgresStore } from "@rapi/adapters";

// Deals reported with /제보 since a date, and whether a route had found the same
// domain first. A report nothing found first is a deal Rapi missed.
// Usage: npm run missed-deals -- 2026-11-07
const since = new Date(process.argv[2] ?? Date.now() - 14 * 86_400_000);
if (Number.isNaN(since.getTime()))
  throw new Error("날짜를 YYYY-MM-DD로 주세요.");
const config = loadEnvironment();
const store = new PostgresStore(config.DATABASE_URL, { max: 1 });
try {
  const reports = await store.reportedDeals(since);
  const missed = reports.filter((report) => !report.foundAt);
  for (const report of reports)
    console.log(
      [
        report.reportedAt.toISOString().slice(0, 10),
        report.foundAt ? `먼저 찾음(${report.foundBy})` : "놓침",
        report.domain,
        report.url,
      ].join("\t"),
    );
  console.log(
    `${since.toISOString().slice(0, 10)} 이후 제보 ${reports.length}건: 먼저 찾음 ${reports.length - missed.length}, 놓침 ${missed.length}`,
  );
} finally {
  await store.close();
}
