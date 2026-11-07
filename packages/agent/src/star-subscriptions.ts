import { createHmac, timingSafeEqual } from "node:crypto";
import {
  kstDateKey,
  kstReached,
  type DeliveryAdapter,
  type DigTrail,
  type DiscordIdentity,
  type GitHubStar,
} from "@rapi/core";
import type { PostgresStore } from "@rapi/db";
import {
  interestPageOf,
  starInterestUrl,
  type StarInterestSite,
} from "./star-interests.js";
import { remindStars, type ReminderPick } from "./star-reminders.js";

const REMINDER_KST_HOUR = 9;
// A dig takes about twenty seconds and a hundred GitHub requests, so a run of
// the ten-minute loop digs for this many people and leaves the rest to the next.
const DIGS_PER_RUN = 4;
// Each person is read with their own token, so the limit is how long a morning takes.
const MAX_SUBSCRIBERS = 500;
// The link to GitHub works this long after /스타 깃허브-연결.
const CONNECT_MINUTES = 15;

type Reads = {
  lastDay?: string;
  picks?: { day: string; picks: ReminderPick[] };
};

/** What reads GitHub, each time with the token of the person it is for. */
export interface StarGitHub {
  readStars(
    login: string,
    token: string | undefined,
  ): Promise<{ stars: GitHubStar[]; complete: boolean }>;
  digTrails?: (
    seeds: string[],
    token: string | undefined,
  ) => Promise<DigTrail[]>;
  followNeighbors?: (
    logins: string[],
    token: string | undefined,
  ) => Promise<Array<{ login: string; starred: GitHubStar[] }>>;
  searchRepos?: (
    queries: string[],
    token: string | undefined,
  ) => Promise<GitHubStar[]>;
}

/** This deployment's GitHub OAuth app, which asks for public data only. */
export interface StarOAuth {
  authorizeUrl(state: string): string;
  finish(code: string): Promise<{ token: string; login: string }>;
  revoke(token: string): Promise<void>;
  encrypt(token: string): string;
  decrypt(value: string): string;
  // Signs the state that says who went to GitHub.
  secret: string;
}

/** Star reminders for everyone who connected their GitHub account. */
export interface StarService {
  store: Pick<
    PostgresStore,
    | "starsOf"
    | "starSubscribers"
    | "starSubscriber"
    | "saveStarSubscriber"
    | "pauseStarSubscriber"
    | "removeStarSubscriber"
  >;
  delivery: Pick<DeliveryAdapter, "send">;
  github: StarGitHub;
  oauth?: StarOAuth | undefined;
  // The configured owner, connected without OAuth and read with the deployment's token.
  owner?: { userId: string; token?: string | undefined } | undefined;
  // The interest pages, when the bot has a public address and a key to sign with.
  site?: StarInterestSite | undefined;
  // Each person's daily read and picks, kept between runs of the loop.
  reads: Map<string, Reads>;
}

/**
 * The token to read someone's GitHub with: the one they granted, or for the
 * configured owner the deployment's. Never the deployment's for anyone else.
 */
function tokenFor(
  service: StarService,
  subscriber: { userId: string; githubToken: string | null },
): { token: string | undefined } | null {
  if (subscriber.githubToken)
    return service.oauth
      ? { token: service.oauth.decrypt(subscriber.githubToken) }
      : null;
  return service.owner?.userId === subscriber.userId
    ? { token: service.owner.token }
    : null;
}

const linkFor = (service: StarService, userId: string, now: Date) => {
  const page = service.site && interestPageOf(service.site, userId);
  return page ? starInterestUrl(page, now) : undefined;
};

/**
 * One run of the loop for everyone who is not paused. A person already sent
 * today costs one query; at most a few people get dug for a run, so one slow
 * morning spreads over the next runs instead of holding the loop. Returns the
 * failures, each with whose it was.
 */
export async function remindEveryone(
  service: StarService,
  now = new Date(),
  random?: () => number,
): Promise<string[]> {
  if (!kstReached(now, REMINDER_KST_HOUR)) return [];
  const day = kstDateKey(now);
  const failures: string[] = [];
  let digs = 0;
  for (const subscriber of await service.store.starSubscribers()) {
    if (subscriber.pausedAt) continue;
    const store = service.store.starsOf(subscriber.userId);
    try {
      if (await store.starReminderClaimed(day)) continue;
    } catch (error) {
      failures.push(
        `${subscriber.userId}: ${error instanceof Error ? error.message : "failed"}`,
      );
      continue;
    }
    let access: { token: string | undefined } | null;
    try {
      access = tokenFor(service, subscriber);
    } catch {
      access = null;
    }
    // Paused rather than read with someone else's token, and not retried each run.
    if (!access) {
      failures.push(`${subscriber.userId}: no GitHub token`);
      await service.store
        .pauseStarSubscriber(subscriber.userId, "GitHub 연결이 필요함")
        .catch(() => undefined);
      continue;
    }
    const reads = service.reads.get(subscriber.userId) ?? {};
    service.reads.set(subscriber.userId, reads);
    // Someone already chosen for today only needs the send tried again.
    if (reads.picks?.day !== day) {
      if (digs >= DIGS_PER_RUN) continue;
      digs += 1;
    }
    const { token } = access;
    const { github } = service;
    const link = service.site && linkFor(service, subscriber.userId, now);
    const own = await remindStars({
      store,
      delivery: service.delivery,
      ownerId: subscriber.userId,
      readStars: async () => {
        try {
          return await github.readStars(subscriber.githubLogin, token);
        } catch (error) {
          // GitHub answers 401 to a token its person took back.
          if (
            subscriber.githubToken &&
            error instanceof Error &&
            /\b401\b/.test(error.message)
          )
            await service.store.pauseStarSubscriber(
              subscriber.userId,
              "GitHub 연결이 끊김",
            );
          throw error;
        }
      },
      githubLogin: subscriber.githubLogin,
      ...(github.digTrails && {
        digTrails: (seeds: string[]) => github.digTrails!(seeds, token),
      }),
      ...(github.followNeighbors && {
        followNeighbors: (logins: string[]) =>
          github.followNeighbors!(logins, token),
      }),
      ...(github.searchRepos && {
        searchRepos: (queries: string[]) => github.searchRepos!(queries, token),
      }),
      ...(link && {
        interestUrl: (at: Date) => linkFor(service, subscriber.userId, at)!,
      }),
      onUndeliverable: (reason) =>
        service.store.pauseStarSubscriber(subscriber.userId, reason),
      reads,
      now,
      ...(random && { random }),
    });
    failures.push(...own.map((failure) => `${subscriber.userId}: ${failure}`));
  }
  return failures;
}

const linkButton = (url: string) => ({
  type: 1,
  components: [{ type: 2, style: 5, label: "관심사 고르기", url }],
});

const stateKey = (secret: string) =>
  createHmac("sha256", secret).update("rapi github oauth state").digest();

const stateSignature = (secret: string, userId: string, expires: number) =>
  createHmac("sha256", stateKey(secret))
    .update(`${userId}.${expires}`)
    .digest("base64url");

/** The state GitHub carries back: who asked, until when, signed. */
export function connectState(
  oauth: Pick<StarOAuth, "secret">,
  userId: string,
  now: Date,
): string {
  const expires = Math.floor((now.getTime() + CONNECT_MINUTES * 60_000) / 1000);
  return `${userId}.${expires}.${stateSignature(oauth.secret, userId, expires)}`;
}

/** Whose state it is, or null when it is not ours or has expired. */
export function stateOwner(
  oauth: Pick<StarOAuth, "secret">,
  state: string | null,
  now: Date,
): string | null {
  const [userId = "", expiresText = "", given = ""] = (state ?? "").split(".");
  const expires = Number(expiresText);
  if (
    !/^\d{1,25}$/.test(userId) ||
    !Number.isInteger(expires) ||
    expires * 1000 < now.getTime()
  )
    return null;
  const expected = Buffer.from(stateSignature(oauth.secret, userId, expires));
  const actual = Buffer.from(given);
  return actual.length === expected.length && timingSafeEqual(actual, expected)
    ? userId
    : null;
}

async function welcome(
  service: StarService,
  userId: string,
  login: string,
  now: Date,
): Promise<"sent" | "closed" | "failed"> {
  const url = linkFor(service, userId, now);
  try {
    await service.delivery.send(
      { channel: "discord_dm", recipientId: userId },
      {
        subject: "스타 알림 연결",
        text: "",
        html: "",
        itemIds: [],
        discord: {
          embeds: [],
          content: [
            `GitHub **${login}** 스타 알림을 연결했습니다.`,
            "매일 아침 9시(한국 시간)에 잊고 있던 스타 하나와, 비슷한 취향의 사람들을 따라가 찾은 새 저장소 하나를 보냅니다.",
            "카드의 👍/👎를 누르면 점점 취향에 맞춰집니다. 그만 받으려면 서버에서 `/스타 끄기`.",
          ].join("\n"),
          ...(url && { components: [linkButton(url)] }),
        },
      },
      `star-welcome:${userId}:${login}`,
    );
    return "sent";
  } catch (error) {
    if (error instanceof Error && /\b403\b/.test(error.message)) {
      await service.store.pauseStarSubscriber(userId, "DM을 받을 수 없음");
      return "closed";
    }
    return "failed";
  }
}

/**
 * Where GitHub sends someone back after they granted the app: checks the
 * state, trades the code for their token, saves it encrypted under the GitHub
 * login the token belongs to, and sends the first DM. What it answers is shown
 * on the page they land on.
 */
export async function finishStarConnect(
  service: StarService,
  query: URLSearchParams,
  now = new Date(),
): Promise<{ ok: boolean; message: string }> {
  const oauth = service.oauth;
  if (!oauth)
    return {
      ok: false,
      message: "이 라피에는 GitHub 연결이 설정되지 않았습니다.",
    };
  const userId = stateOwner(oauth, query.get("state"), now);
  if (!userId)
    return {
      ok: false,
      message:
        "연결 링크가 만료됐습니다. Discord에서 /스타 깃허브-연결을 다시 해 주세요.",
    };
  if (query.get("error"))
    return { ok: false, message: "GitHub 연결을 취소했습니다." };
  const code = query.get("code");
  if (!code || code.length > 200)
    return { ok: false, message: "GitHub가 연결 코드를 주지 않았습니다." };
  if (
    !(await service.store.starSubscriber(userId)) &&
    (await service.store.starSubscribers()).length >= MAX_SUBSCRIBERS
  )
    return {
      ok: false,
      message:
        "지금은 스타 알림을 받는 사람이 꽉 찼습니다. 나중에 다시 해 주세요.",
    };
  let granted: { token: string; login: string };
  try {
    granted = await oauth.finish(code);
  } catch {
    return {
      ok: false,
      message:
        "GitHub에서 연결을 확인하지 못했습니다. Discord에서 /스타 깃허브-연결을 다시 해 주세요.",
    };
  }
  await service.store.saveStarSubscriber(
    userId,
    granted.login,
    oauth.encrypt(granted.token),
  );
  const sent = await welcome(service, userId, granted.login, now);
  return {
    ok: true,
    message:
      sent === "closed"
        ? `GitHub ${granted.login} 연결은 했지만 DM을 보낼 수 없습니다. 라피가 있는 서버의 개인정보 설정에서 다이렉트 메시지를 허용한 뒤 /스타 깃허브-연결을 한 번 더 해 주세요.`
        : `GitHub ${granted.login} 연결했습니다. 매일 아침 9시에 Discord DM으로 보내 드립니다. 이 창은 닫아도 됩니다.`,
  };
}

/**
 * /스타: 연결 gives a link to grant the app on GitHub, which reads public
 * data only and proves whose account it is. 관심사 gives a fresh link to the
 * interest page, 보기 says what is connected, and 끄기 stops the DM, takes the
 * grant back from GitHub and forgets everything kept for them.
 */
export async function starCommand(
  service: StarService,
  identity: DiscordIdentity,
  options: Record<string, unknown>,
  now = new Date(),
): Promise<string> {
  const action = typeof options.action === "string" ? options.action : "보기";
  const userId = identity.userId;
  const current = await service.store.starSubscriber(userId);
  switch (action) {
    case "깃허브-연결": {
      if (!service.oauth || !service.site)
        return "이 라피에는 아직 GitHub 연결이 설정되지 않았습니다. 운영자에게 알려 주세요.";
      if (
        !current &&
        (await service.store.starSubscribers()).length >= MAX_SUBSCRIBERS
      )
        return "지금은 스타 알림을 받는 사람이 꽉 찼습니다. 나중에 다시 해 주세요.";
      return [
        `GitHub로 연결하기 (${CONNECT_MINUTES}분 안에 열어 주세요): ${service.oauth.authorizeUrl(connectState(service.oauth, userId, now))}`,
        "공개 정보만 읽는 권한입니다. 비공개 저장소나 쓰기 권한은 받지 않고, `/스타 끄기`로 언제든 끊을 수 있습니다.",
      ].join("\n");
    }
    case "관심사": {
      if (!current) return "먼저 `/스타 깃허브-연결`로 GitHub를 연결해 주세요.";
      const url = linkFor(service, userId, now);
      return url
        ? `관심사 고르기 (7일 동안 열림): ${url}`
        : "이 라피에는 관심사 페이지가 설정되지 않았습니다.";
    }
    case "끄기": {
      if (!current) return "스타 알림을 받고 있지 않습니다.";
      let revoked = true;
      if (current.githubToken && service.oauth)
        try {
          await service.oauth.revoke(
            service.oauth.decrypt(current.githubToken),
          );
        } catch {
          revoked = false;
        }
      await service.store.removeStarSubscriber(userId);
      return [
        "스타 알림을 껐습니다. 저장해 둔 스타, 관심사, 👍/👎 기록과 GitHub 토큰을 모두 지웠습니다.",
        revoked
          ? ""
          : "GitHub 쪽 권한은 회수하지 못했습니다. GitHub 설정 → Applications에서 라피를 직접 지워 주세요.",
      ]
        .filter(Boolean)
        .join("\n");
    }
    case "보기":
      if (!current)
        return "스타 알림을 받고 있지 않습니다. `/스타 깃허브-연결`로 GitHub를 연결하면 매일 아침 DM으로 보내 드립니다.";
      return [
        `GitHub **${current.githubLogin}** 스타 알림을 받고 있습니다. 매일 아침 9시(한국 시간) DM.`,
        current.pausedAt
          ? `멈춤: ${current.pausedReason ?? "이유 모름"}. \`/스타 깃허브-연결\`을 다시 하면 이어서 받습니다.`
          : "",
      ]
        .filter(Boolean)
        .join("\n");
    default:
      throw new Error("지원하지 않는 스타 동작입니다.");
  }
}
