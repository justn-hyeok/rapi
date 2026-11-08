import { type OAuthGrant, type OAuthGateway } from "@rapi/application";
import { readSource, type SourceHttpOptions } from "../web/sources.js";

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
): Promise<OAuthGrant> {
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
    scope?: unknown;
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
  const user = JSON.parse(body) as { id?: unknown; login?: unknown };
  if (
    typeof user.login !== "string" ||
    !LOGIN.test(user.login) ||
    typeof user.id !== "number"
  )
    throw new Error("GitHub did not say whose token it is");
  return {
    token: grant.access_token,
    accountId: String(user.id),
    accountName: user.login,
    scopes: typeof grant.scope === "string" ? grant.scope.slice(0, 200) : "",
  };
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

/** The app as the connections port sees it. */
export function githubOAuthGateway(
  app: GitHubOAuthApp,
  options: SourceHttpOptions = {},
): OAuthGateway {
  return {
    authorizeUrl: (state) => githubAuthorizeUrl(app, state),
    finish: (code) => finishGitHubOAuth(app, code, options),
    revoke: (token) => revokeGitHubGrant(app, token, options),
  };
}
