import { finishConnect, type ConnectionService } from "@rapi/agent";

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );

const page = (ok: boolean, message: string) =>
  `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>라피 · 연결</title><style>body{font:16px/1.6 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#1f2328;background:#fff}h1{font-size:1.25rem}@media (prefers-color-scheme:dark){body{color:#e6edf3;background:#0d1117}}</style><h1>${ok ? "연결했습니다" : "연결하지 못했습니다"}</h1><p>${escapeHtml(message)}</p></html>`;

const CALLBACK = /^\/connect\/([a-z][a-z0-9_-]{1,31})\/callback$/;

/**
 * A provider's return from someone granting the app:
 * GET /connect/<provider>/callback. Other paths are not this page's, so it
 * answers null.
 */
export function connectPages(service: ConnectionService | undefined) {
  return async (
    method: string,
    url: URL,
  ): Promise<{ status: number; type: string; body: string } | null> => {
    const provider = CALLBACK.exec(url.pathname)?.[1];
    if (!provider) return null;
    if (method !== "GET")
      return {
        status: 404,
        type: "text/html",
        body: page(false, "없는 주소입니다."),
      };
    try {
      const { ok, message } = await finishConnect(
        service,
        provider,
        url.searchParams,
      );
      return {
        status: ok ? 200 : 400,
        type: "text/html",
        body: page(ok, message),
      };
    } catch (error) {
      process.stderr.write(
        `connect: ${error instanceof Error ? error.message.slice(0, 200) : "failed"}\n`,
      );
      return {
        status: 500,
        type: "text/html",
        body: page(false, "잠시 뒤 Discord에서 /연결 추가를 다시 해 주세요."),
      };
    }
  };
}
