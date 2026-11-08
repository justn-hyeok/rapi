import { createHmac, timingSafeEqual } from "node:crypto";
import {
  CONNECTION_PROVIDERS,
  type ConnectionProviderId,
  type ConnectionStore,
  type OAuthProvider,
  type SecretBox,
  type UserConnection,
  isConnectionProvider,
} from "./ports/index.js";
import { type DiscordIdentity } from "@rapi/domain";

// The link to the provider works this long after it is given.
const CONNECT_MINUTES = 15;
const DISCORD_ID = /^\d{1,25}$/;
const FEATURE = /^[a-z][a-z0-9_-]{0,31}$/;

// What each provider's grant can do, said before anyone opens the link.
const GRANT_NOTES: Record<ConnectionProviderId, string> = {
  github:
    "공개 정보만 읽는 권한입니다. 비공개 저장소나 쓰기 권한은 받지 않습니다.",
};

/** A feature that reads through someone's connection, e.g. star reminders. */
export interface ConnectionUser {
  /**
   * After someone connects. `asked` is true when the link came from this
   * feature. Returns a line for the page they land on, if any.
   */
  connected?(
    connection: UserConnection,
    asked: boolean,
    now: Date,
  ): Promise<string | undefined>;
  /** After the connection is gone: they cut it, or the provider refused the token. */
  disconnected?(userId: string): Promise<void>;
}

/** The accounts people connect, and the features that use them. */
export interface ConnectionService {
  store: ConnectionStore;
  /** The OAuth apps this deployment has; a provider without one cannot be connected. */
  providers: Partial<Record<ConnectionProviderId, OAuthProvider>>;
  box: SecretBox;
  /** Signs the state that says who went to the provider. */
  secret: string;
  /**
   * The features reading through each provider's connections, by name; a
   * link started from one carries its name back.
   */
  users: Partial<Record<ConnectionProviderId, Record<string, ConnectionUser>>>;
}

const label = (provider: ConnectionProviderId) =>
  CONNECTION_PROVIDERS[provider];

const stateKey = (secret: string) =>
  createHmac("sha256", secret).update("rapi connection state").digest();

const sign = (secret: string, body: string) =>
  createHmac("sha256", stateKey(secret)).update(body).digest("base64url");

/** The state the provider carries back: which service, who, for what, until when, signed. */
export function connectState(
  secret: string,
  provider: ConnectionProviderId,
  userId: string,
  feature: string | undefined,
  now: Date,
): string {
  const expires = Math.floor((now.getTime() + CONNECT_MINUTES * 60_000) / 1000);
  const body = `${provider}.${userId}.${feature ?? "-"}.${expires}`;
  return `${body}.${sign(secret, body)}`;
}

/** Who the state is for, or null when it is not ours, not this provider's, or expired. */
export function readConnectState(
  secret: string,
  provider: ConnectionProviderId,
  state: string | null,
  now: Date,
): { userId: string; feature: string | undefined } | null {
  const parts = (state ?? "").split(".");
  if (parts.length !== 5) return null;
  const [given, userId, feature, expiresText, signature] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  const expires = Number(expiresText);
  if (
    given !== provider ||
    !DISCORD_ID.test(userId) ||
    !(feature === "-" || FEATURE.test(feature)) ||
    !Number.isInteger(expires) ||
    expires * 1000 < now.getTime()
  )
    return null;
  const expected = Buffer.from(sign(secret, parts.slice(0, 4).join(".")));
  const actual = Buffer.from(signature);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    return null;
  return { userId, feature: feature === "-" ? undefined : feature };
}

/**
 * What to tell someone who asked to connect: the link and what it grants, or
 * why there is none. `feature` is told once they come back.
 */
export function connectMessage(
  service: ConnectionService | undefined,
  userId: string,
  provider: ConnectionProviderId,
  feature: string | undefined,
  now: Date,
): string {
  const app = service?.providers[provider];
  if (!service || !app)
    return `이 라피에는 아직 ${label(provider)} 연결이 설정되지 않았습니다. 운영자에게 알려 주세요.`;
  const url = app.authorizeUrl(
    connectState(service.secret, provider, userId, feature, now),
  );
  return [
    `${label(provider)}로 연결하기 (${CONNECT_MINUTES}분 안에 열어 주세요): ${url}`,
    `${GRANT_NOTES[provider]} \`/연결 끊기\`로 언제든 끊을 수 있습니다.`,
  ].join("\n");
}

/** Their token for the provider, or null when they have not connected it. */
export async function connectionToken(
  service: ConnectionService | undefined,
  userId: string,
  provider: ConnectionProviderId,
): Promise<{ token: string; accountName: string } | null> {
  const connection = await service?.store.connection(userId, provider);
  if (!service || !connection) return null;
  try {
    return {
      token: service.box.open(connection.sealedToken),
      accountName: connection.accountName,
    };
  } catch {
    // Sealed under another key: as good as not connected.
    return null;
  }
}

async function tellDisconnected(
  service: ConnectionService,
  userId: string,
  provider: ConnectionProviderId,
): Promise<void> {
  for (const user of Object.values(service.users[provider] ?? {}))
    await user.disconnected?.(userId).catch(() => undefined);
}

/** The provider refused their token: it was taken back there, so forget it here too. */
export async function connectionRefused(
  service: ConnectionService,
  userId: string,
  provider: ConnectionProviderId,
): Promise<void> {
  if (await service.store.removeConnection(userId, provider))
    await tellDisconnected(service, userId, provider);
}

/**
 * Where the provider sends someone back after they granted the app: checks
 * the state, trades the code for their token, saves it sealed under the
 * account the token belongs to, and lets the features that use it know.
 * What it answers is shown on the page they land on.
 */
export async function finishConnect(
  service: ConnectionService | undefined,
  provider: string,
  query: URLSearchParams,
  now = new Date(),
): Promise<{ ok: boolean; message: string }> {
  const app = isConnectionProvider(provider)
    ? service?.providers[provider]
    : undefined;
  if (!service || !app || !isConnectionProvider(provider))
    return { ok: false, message: "이 라피에 설정되지 않은 연결입니다." };
  const again = "Discord에서 `/연결 추가`를 다시 해 주세요.";
  const state = readConnectState(
    service.secret,
    provider,
    query.get("state"),
    now,
  );
  if (!state)
    return { ok: false, message: `연결 링크가 만료됐습니다. ${again}` };
  if (query.get("error"))
    return { ok: false, message: `${label(provider)} 연결을 취소했습니다.` };
  const code = query.get("code");
  if (!code || code.length > 200)
    return {
      ok: false,
      message: `${label(provider)}가 연결 코드를 주지 않았습니다. ${again}`,
    };
  let grant;
  try {
    grant = await app.finish(code);
  } catch {
    return {
      ok: false,
      message: `${label(provider)}에서 연결을 확인하지 못했습니다. ${again}`,
    };
  }
  const before = await service.store.connection(state.userId, provider);
  // Another account's grant stays on that account unless it is taken back.
  if (before && before.accountId !== grant.accountId)
    await app
      .revoke(service.box.open(before.sealedToken))
      .catch(() => undefined);
  const connection = {
    userId: state.userId,
    provider,
    accountId: grant.accountId,
    accountName: grant.accountName,
    sealedToken: service.box.seal(grant.token),
    scopes: grant.scopes,
  };
  await service.store.saveConnection(connection);
  const lines = [`${label(provider)} ${grant.accountName} 연결했습니다.`];
  for (const [name, user] of Object.entries(service.users[provider] ?? {})) {
    const line = await user
      .connected?.(
        { ...connection, connectedAt: now },
        name === state.feature,
        now,
      )
      .catch(() => undefined);
    if (line) lines.push(line);
  }
  lines.push("이 창은 닫아도 됩니다.");
  return { ok: true, message: lines.join(" ") };
}

/** Takes the grant back on the provider's side, forgets the token, and stops what used it. */
export async function disconnect(
  service: ConnectionService | undefined,
  userId: string,
  provider: ConnectionProviderId,
): Promise<string> {
  const connection = await service?.store.connection(userId, provider);
  if (!service || !connection)
    return `${label(provider)}는 연결돼 있지 않습니다.`;
  let revoked = true;
  try {
    const app = service.providers[provider];
    if (!app) throw new Error("no app");
    await app.revoke(service.box.open(connection.sealedToken));
  } catch {
    revoked = false;
  }
  await service.store.removeConnection(userId, provider);
  await tellDisconnected(service, userId, provider);
  return [
    `${label(provider)} ${connection.accountName} 연결을 끊고 토큰을 지웠습니다. 이 연결을 쓰던 기능도 멈췄습니다.`,
    revoked
      ? ""
      : `${label(provider)} 쪽 권한은 회수하지 못했습니다. ${label(provider)} 설정의 Applications에서 라피를 직접 지워 주세요.`,
  ]
    .filter(Boolean)
    .join("\n");
}

const KST_DAY = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul" });

/** /연결: 추가 gives a link to grant the app, 끊기 cuts it, 보기 lists what is connected. */
export async function connectCommand(
  service: ConnectionService | undefined,
  identity: DiscordIdentity,
  options: Record<string, unknown>,
  now = new Date(),
): Promise<string> {
  const action = typeof options.action === "string" ? options.action : "보기";
  const provider = options["서비스"] ?? "github";
  if (action !== "보기" && !isConnectionProvider(provider))
    throw new Error("지원하지 않는 서비스입니다.");
  switch (action) {
    case "추가":
      return connectMessage(
        service,
        identity.userId,
        provider as ConnectionProviderId,
        undefined,
        now,
      );
    case "끊기":
      return disconnect(
        service,
        identity.userId,
        provider as ConnectionProviderId,
      );
    case "보기": {
      const connections =
        (await service?.store.connections(identity.userId)) ?? [];
      if (!connections.length)
        return "연결한 서비스가 없습니다. `/연결 추가`로 연결할 수 있습니다.";
      return [
        "연결한 서비스:",
        ...connections.map(
          (connection) =>
            `- ${label(connection.provider)} **${connection.accountName}** (${KST_DAY.format(connection.connectedAt)}부터)`,
        ),
      ].join("\n");
    }
    default:
      throw new Error("지원하지 않는 연결 동작입니다.");
  }
}
