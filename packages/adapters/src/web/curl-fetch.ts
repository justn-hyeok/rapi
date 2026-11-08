import { execFile } from "node:child_process";

const MAX_BYTES = 2_000_000;
const STATUS_MARK = "\n__rapi_status__:";

/**
 * A fetch that asks curl instead of Node. Some sites challenge Node's own HTTP
 * client but answer curl; the request still says it is rapi. Only GET, only
 * https, and the URL is passed as an argument, never through a shell.
 */
export function curlFetch(binary = "curl"): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    if (url.protocol !== "https:")
      throw new Error("curlFetch reads https only");
    const headers = Object.entries(
      (init?.headers ?? {}) as Record<string, string>,
    ).flatMap(([name, value]) => ["-H", `${name}: ${value}`]);
    const body = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        binary,
        [
          "-sS",
          "--compressed",
          "--proto",
          "=https",
          "--max-time",
          "15",
          "--max-filesize",
          String(MAX_BYTES),
          ...headers,
          "-w",
          `${STATUS_MARK}%{http_code}`,
          "--",
          url.href,
        ],
        { maxBuffer: MAX_BYTES + 1024, encoding: "utf8" },
        (error, stdout) =>
          error ? reject(new Error(error.message)) : resolve(stdout),
      );
      init?.signal?.addEventListener("abort", () => child.kill());
    });
    const at = body.lastIndexOf(STATUS_MARK);
    if (at < 0) throw new Error("curl gave no status");
    const status = Number(body.slice(at + STATUS_MARK.length));
    return new Response(body.slice(0, at), { status });
  }) as typeof fetch;
}
