/** Services someone can connect their own account of, with the name people see. */
export const CONNECTION_PROVIDERS = { github: "GitHub" } as const;
export type ConnectionProviderId = keyof typeof CONNECTION_PROVIDERS;

export const isConnectionProvider = (
  value: unknown,
): value is ConnectionProviderId =>
  typeof value === "string" && Object.hasOwn(CONNECTION_PROVIDERS, value);

/** One person's account on one service, granted to this deployment. */
export interface UserConnection {
  userId: string;
  provider: ConnectionProviderId;
  /** The service's stable id for the account. */
  accountId: string;
  /** What the account is called there, e.g. a GitHub login. */
  accountName: string;
  /** The token, sealed with the deployment's key. */
  sealedToken: string;
  scopes: string;
  connectedAt: Date;
}

export interface ConnectionStore {
  connection(
    userId: string,
    provider: ConnectionProviderId,
  ): Promise<UserConnection | null>;
  connections(userId: string): Promise<UserConnection[]>;
  /** Adds or replaces their connection to the provider. */
  saveConnection(
    connection: Omit<UserConnection, "connectedAt">,
  ): Promise<void>;
  /** True when there was one. */
  removeConnection(
    userId: string,
    provider: ConnectionProviderId,
  ): Promise<boolean>;
}

/** What a provider hands back once someone grants the app. */
export interface OAuthGrant {
  token: string;
  accountId: string;
  accountName: string;
  scopes: string;
}

/** One service's OAuth app, registered by the operator. */
export interface OAuthGateway {
  /** Where to send someone to grant the app, carrying `state` back. */
  authorizeUrl(state: string): string;
  /** Trades the code for a token and says whose account it is. Throws on refusal. */
  finish(code: string): Promise<OAuthGrant>;
  /** Takes the grant back on the service's side. A grant already gone is done. */
  revoke(token: string): Promise<void>;
}

/** Seals secrets kept in the database with the deployment's key. */
export interface SecretBox {
  seal(text: string): string;
  open(sealed: string): string;
}
