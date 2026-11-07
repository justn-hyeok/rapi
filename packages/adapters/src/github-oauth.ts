import { readSource, type SourceHttpOptions } from "./sources.js";

/** A GitHub OAuth app this deployment owns. It asks for no scope: public data only. */
export interface GitHubOAuthApp {
  clientId: string;
  clientSecret: string;
  // Where GitHub sends the person back, registered on the app.
  redirectUri: string;
}

const LOGIN = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;

/** Where to send someone to grant the app, with the state that names them. */
export function githubAuthorizeUrl(app: GitHubOAuthApp, state: string): string {
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", app.clientId);
  url.searchParams.set("redirect_uri", app.redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("allow_signup", "false");
  return url.toString();
}

/**
 * Trades the code GitHub sent back for the person's token, then asks GitHub
 * whose it is. Throws when GitHub refuses either, so nothing is saved.
 */
export async function finishGitHubOAuth(
  app: GitHubOAuthApp,
  code: string,
  options: SourceHttpOptions = {},
): Promise<{ token: string; login: string }> {
  const fetcher = options.fetch ?? fetch;
  const exchanged = await fetcher(
    "https://github.com/login/oauth/access_token",
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "rapi",
      },
      body: JSON.stringify({
        client_id: app.clientId,
        client_secret: app.clientSecret,
        code,
        redirect_uri: app.redirectUri,
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    },
  );
  const grant = (await exchanged.json().catch(() => ({}))) as {
    access_token?: unknown;
    error?: unknown;
  };
  if (!exchanged.ok || typeof grant.access_token !== "string")
    throw new Error(
      `GitHub did not grant a token${typeof grant.error === "string" ? `: ${grant.error.slice(0, 60)}` : ""}`,
    );
  const { body } = await readSource(
    "https://api.github.com/user",
    {
      Accept: "application/vnd.github+json",
      "User-Agent": "rapi",
      Authorization: `Bearer ${grant.access_token}`,
    },
    { maxBodyBytes: 100_000, ...options },
  );
  const login = (JSON.parse(body) as { login?: unknown }).login;
  if (typeof login !== "string" || !LOGIN.test(login))
    throw new Error("GitHub did not say whose token it is");
  return { token: grant.access_token, login };
}

/**
 * Takes the app's grant back from GitHub, so the token stops working there
 * too. A grant already gone counts as done.
 */
export async function revokeGitHubGrant(
  app: GitHubOAuthApp,
  token: string,
  options: SourceHttpOptions = {},
): Promise<void> {
  const response = await (options.fetch ?? fetch)(
    `https://api.github.com/applications/${encodeURIComponent(app.clientId)}/grant`,
    {
      method: "DELETE",
      headers: {
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "rapi",
        Authorization: `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString("base64")}`,
      },
      body: JSON.stringify({ access_token: token }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    },
  );
  await response.arrayBuffer();
  if (!response.ok && response.status !== 404 && response.status !== 422)
    throw new Error(`GitHub returned ${response.status}`);
}
