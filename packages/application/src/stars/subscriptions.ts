import { type DiscordGateway } from "../discord/ports.js";
import { type GitHubGateway, type StarSubscriberStore } from "./ports.js";
import { type UserConnection } from "../connections/ports.js";
import { kstDateKey, kstReached, type DiscordIdentity } from "@rapi/domain";
import {
  interestPageOf,
  starInterestUrl,
  type StarInterestSite,
} from "./interests.js";
import {
  connectionRefused,
  connectionToken,
  connectMessage,
  type ConnectionService,
  type ConnectionUser,
} from "../connections/connections.js";
import { remindStars, type ReminderPick } from "./reminders.js";

const REMINDER_KST_HOUR = 9;
// A dig takes about twenty seconds and a hundred GitHub requests, so a run of
// the ten-minute loop digs for this many people and leaves the rest to the next.
const DIGS_PER_RUN = 4;
// Each person is read with their own token, so the limit is how long a morning takes.
const MAX_SUBSCRIBERS = 500;
// The name connect links started from /스타 켜기 carry back.
const FEATURE = "stars";

type Reads = {
  lastDay?: string;
  picks?: { day: string; picks: ReminderPick[] };
};

/** Star reminders for everyone who connected their GitHub account. */
export interface StarService {
  store: Pick<
    StarSubscriberStore,
    | "starsOf"
    | "starSubscribers"
    | "starSubscriber"
    | "saveStarSubscriber"
    | "pauseStarSubscriber"
    | "removeStarSubscriber"
  >;
  delivery: Pick<DiscordGateway, "send">;
  github: GitHubGateway;
  // Whose GitHub to read with; without it only the owner gets reminders.
  connections?: ConnectionService | undefined;
  // The configured owner, read with the deployment's token when not connected.
  owner?:
    | { userId: string; login?: string | undefined; token?: string | undefined }
    | undefined;
  // The interest pages, when the bot has a public address and a key to sign with.
  site?: StarInterestSite | undefined;
  // Each person's daily read and picks, kept between runs of the loop.
  reads: Map<string, Reads>;
}

/**
 * The token to read someone's GitHub with: the one their GitHub connection
 * holds, or for the configured owner the deployment's. Never the deployment's
 * for anyone else.
 */
async function tokenFor(
  service: StarService,
  userId: string,
): Promise<{ token: string | undefined; connected: boolean } | null> {
  const connected = await connectionToken(
    service.connections,
    userId,
    "github",
  );
  if (connected) return { token: connected.token, connected: true };
  return service.owner?.userId === userId
    ? { token: service.owner.token, connected: false }
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
    let access: Awaited<ReturnType<typeof tokenFor>>;
    try {
      access = await tokenFor(service, subscriber.userId);
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
      userId: subscriber.userId,
      readStars: async () => {
        try {
          return await github.readStars(subscriber.githubLogin, token);
        } catch (error) {
          // GitHub answers 401 to a token its person took back.
          if (
            access.connected &&
            service.connections &&
            error instanceof Error &&
            /\b401\b/.test(error.message)
          )
            await connectionRefused(
              service.connections,
              subscriber.userId,
              "github",
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
        subject: "스타 알림 켜기",
        text: "",
        html: "",
        itemIds: [],
        discord: {
          embeds: [],
          content: [
            `GitHub **${login}** 스타 알림을 켰습니다.`,
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

const FULL =
  "지금은 스타 알림을 받는 사람이 꽉 찼습니다. 나중에 다시 해 주세요.";

const full = async (service: StarService, userId: string) =>
  !(await service.store.starSubscriber(userId)) &&
  (await service.store.starSubscribers()).length >= MAX_SUBSCRIBERS;

async function turnOn(
  service: StarService,
  userId: string,
  login: string,
  now: Date,
): Promise<string> {
  await service.store.saveStarSubscriber(userId, login);
  return (await welcome(service, userId, login, now)) === "closed"
    ? "스타 알림은 켰지만 DM을 보낼 수 없습니다. 라피가 있는 서버의 개인정보 설정에서 다이렉트 메시지를 허용한 뒤 `/스타 켜기`를 한 번 더 해 주세요."
    : "스타 알림을 켰습니다. 매일 아침 9시(한국 시간)에 Discord DM으로 보내 드립니다.";
}

/**
 * How star reminders follow someone's GitHub connection: a link from /스타
 * 켜기 turns them on once connected, connecting again (or another account)
 * carries on with that account, and losing the connection pauses them.
 */
export function starConnectionUser(service: StarService): ConnectionUser {
  return {
    async connected(connection: UserConnection, asked: boolean, now: Date) {
      const current = await service.store.starSubscriber(connection.userId);
      if (!current && !asked) return undefined;
      if (await full(service, connection.userId)) return FULL;
      if (!current || current.pausedAt)
        return turnOn(service, connection.userId, connection.accountName, now);
      await service.store.saveStarSubscriber(
        connection.userId,
        connection.accountName,
      );
      return undefined;
    },
    async disconnected(userId) {
      // The owner can still be read with the deployment's token.
      if (service.owner?.userId === userId && service.owner.token) return;
      await service.store.pauseStarSubscriber(userId, "GitHub 연결이 끊김");
    },
  };
}

/**
 * /스타: 켜기 starts the morning DM with their GitHub connection, first
 * giving the link to connect when there is none. 관심사 gives a fresh link to
 * the interest page, 보기 says what is on, and 끄기 stops the DM and forgets
 * what was kept for it. The GitHub connection itself is /연결's.
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
    case "켜기": {
      if (current && !current.pausedAt)
        return `이미 GitHub **${current.githubLogin}** 스타 알림을 받고 있습니다.`;
      if (await full(service, userId)) return FULL;
      const connected = await connectionToken(
        service.connections,
        userId,
        "github",
      );
      if (connected) return turnOn(service, userId, connected.accountName, now);
      const owner = service.owner;
      if (owner?.userId === userId && owner.login && owner.token)
        return turnOn(service, userId, owner.login, now);
      return [
        connectMessage(service.connections, userId, "github", FEATURE, now),
        "GitHub를 연결하면 바로 스타 알림을 켭니다.",
      ].join("\n");
    }
    case "관심사": {
      if (!current) return "먼저 `/스타 켜기`로 스타 알림을 켜 주세요.";
      const url = linkFor(service, userId, now);
      return url
        ? `관심사 고르기 (7일 동안 열림): ${url}`
        : "이 라피에는 관심사 페이지가 설정되지 않았습니다.";
    }
    case "끄기": {
      if (!current) return "스타 알림을 받고 있지 않습니다.";
      await service.store.removeStarSubscriber(userId);
      return "스타 알림을 껐습니다. 저장해 둔 스타, 관심사, 👍/👎 기록을 모두 지웠습니다. GitHub 연결은 그대로 두었으니, 끊으려면 `/연결 끊기`를 해 주세요.";
    }
    case "보기":
      if (!current)
        return "스타 알림을 받고 있지 않습니다. `/스타 켜기`로 켜면 매일 아침 DM으로 보내 드립니다.";
      return [
        `GitHub **${current.githubLogin}** 스타 알림을 받고 있습니다. 매일 아침 9시(한국 시간) DM.`,
        current.pausedAt
          ? `멈춤: ${current.pausedReason ?? "이유 모름"}. \`/스타 켜기\`를 다시 하면 이어서 받습니다.`
          : "",
      ]
        .filter(Boolean)
        .join("\n");
    default:
      throw new Error("지원하지 않는 스타 동작입니다.");
  }
}
