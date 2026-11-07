import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  saveStarInterestChoices,
  starInterestData,
  validStarToken,
  type StarInterestPage,
} from "@rapi/agent";

const PAGE = fileURLToPath(new URL("./star-page.html", import.meta.url));
const MAX_BODY_BYTES = 200_000;

const json = (status: number, body: unknown) => ({
  status,
  type: "application/json",
  body: JSON.stringify(body),
});

/**
 * The owner's interest page: GET /stars, GET /stars/data and POST
 * /stars/interests, each only with a valid token in ?t=. Other paths are not
 * this page's, so it answers null.
 */
export function starPages(page: StarInterestPage) {
  return async (
    method: string,
    url: URL,
    body: () => Promise<Buffer>,
  ): Promise<{ status: number; type: string; body: string } | null> => {
    if (url.pathname !== "/stars" && !url.pathname.startsWith("/stars/"))
      return null;
    const now = new Date();
    if (!validStarToken(page, url.searchParams.get("t"), now))
      return url.pathname === "/stars"
        ? {
            status: 401,
            type: "text/html",
            body: "<!doctype html><meta charset=utf-8><title>라피</title><p>링크가 만료됐습니다. 최근 스타 알림 DM의 '관심사 고르기'를 눌러 주세요.</p>",
          }
        : json(401, { error: "expired" });
    try {
      if (method === "GET" && url.pathname === "/stars")
        return {
          status: 200,
          type: "text/html",
          body: await readFile(PAGE, "utf8"),
        };
      if (method === "GET" && url.pathname === "/stars/data")
        return json(200, await starInterestData(page, now));
      if (method === "POST" && url.pathname === "/stars/interests") {
        const raw = await body();
        if (raw.length > MAX_BODY_BYTES)
          return json(413, { error: "too large" });
        const saved = await saveStarInterestChoices(
          page,
          JSON.parse(raw.toString("utf8")) as unknown,
        );
        return json(200, { saved, at: now.toISOString() });
      }
      return json(404, { error: "not found" });
    } catch (error) {
      process.stderr.write(
        `star page: ${error instanceof Error ? error.message.slice(0, 200) : "failed"}\n`,
      );
      return json(400, { error: "could not handle the request" });
    }
  };
}
