import { readSource, type SourceHttpOptions } from "./sources.js";

/** Rapi's own newest release. The repository is public, so no token is needed. */
export async function readLatestRapiRelease(
  options: SourceHttpOptions = {},
): Promise<{ tag: string; url: string; body: string }> {
  const { body } = await readSource(
    "https://api.github.com/repos/justn-hyeok/rapi/releases/latest",
    { Accept: "application/vnd.github+json", "User-Agent": "rapi" },
    options,
  );
  const release = JSON.parse(body) as {
    tag_name?: unknown;
    html_url?: unknown;
    body?: unknown;
  };
  if (
    typeof release.tag_name !== "string" ||
    typeof release.html_url !== "string"
  )
    throw new Error("GitHub release response has no tag");
  return {
    tag: release.tag_name,
    url: release.html_url,
    body: typeof release.body === "string" ? release.body : "",
  };
}
