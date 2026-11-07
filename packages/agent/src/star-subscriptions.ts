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
// With the shared token's 5000 requests an hour, everyone still gets a morning DM.
const MAX_SUBSCRIBERS = 300;
const LOGIN = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;

type Reads = {
  lastDay?: string;
  picks?: { day: string; picks: ReminderPick[] };
};

/** Star reminders for everyone who connected a GitHub login. */
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
  github: {
    userExists(login: string): Promise<boolean>;
    readStars(
      login: string,
    ): Promise<{ stars: GitHubStar[]; complete: boolean }>;
    digTrails?: (seeds: string[]) => Promise<DigTrail[]>;
    followNeighbors?: (
      logins: string[],
    ) => Promise<Array<{ login: string; starred: GitHubStar[] }>>;
    searchRepos?: (queries: string[]) => Promise<GitHubStar[]>;
  };
  // The interest pages, when the bot has a public address and a key to sign with.
  site?: StarInterestSite | undefined;
  // Each person's daily read and picks, kept between runs of the loop.
  reads: Map<string, Reads>;
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
    const reads = service.reads.get(subscriber.userId) ?? {};
    service.reads.set(subscriber.userId, reads);
    // Someone already chosen for today only needs the send tried again.
    if (reads.picks?.day !== day) {
      if (digs >= DIGS_PER_RUN) continue;
      digs += 1;
    }
    const { github } = service;
    const link = service.site && linkFor(service, subscriber.userId, now);
    const own = await remindStars({
      store,
      delivery: service.delivery,
      ownerId: subscriber.userId,
      readStars: () => github.readStars(subscriber.githubLogin),
      githubLogin: subscriber.githubLogin,
      ...(github.digTrails && { digTrails: github.digTrails }),
      ...(github.followNeighbors && {
        followNeighbors: github.followNeighbors,
      }),
      ...(github.searchRepos && { searchRepos: github.searchRepos }),
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

/**
 * /스타: 연결 connects a GitHub login and sends a first DM, which also shows
 * whether Discord lets the bot write to them. 관심사 gives a fresh link to the
 * interest page, 보기 says what is connected, and 끄기 stops the DM and
 * forgets everything kept for them.
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
    case "연결": {
      const login =
        typeof options.login === "string"
          ? options.login.trim().replace(/^@/, "")
          : "";
      if (!LOGIN.test(login))
        return "GitHub 아이디를 확인해 주세요. 예: /스타 연결 깃허브:octocat";
      if (
        !current &&
        (await service.store.starSubscribers()).length >= MAX_SUBSCRIBERS
      )
        return "지금은 스타 알림을 받는 사람이 꽉 찼습니다. 나중에 다시 해 주세요.";
      if (!(await service.github.userExists(login)))
        return `GitHub에서 ${login}을(를) 찾지 못했습니다.`;
      await service.store.saveStarSubscriber(userId, login);
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
      } catch (error) {
        if (error instanceof Error && /\b403\b/.test(error.message)) {
          await service.store.pauseStarSubscriber(userId, "DM을 받을 수 없음");
          return "연결은 했지만 DM을 보낼 수 없습니다. 이 서버의 개인정보 설정에서 다이렉트 메시지를 허용한 뒤 `/스타 연결`을 한 번 더 해 주세요.";
        }
        return `${login} 연결은 했지만 첫 DM을 보내지 못했습니다. 내일 아침 알림은 그대로 갑니다.`;
      }
      return [
        `${login} 연결했습니다. DM을 확인해 주세요.`,
        url ? `관심사를 고르면 더 잘 맞춥니다: ${url}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    }
    case "관심사": {
      if (!current) return "먼저 `/스타 연결`로 GitHub 아이디를 연결해 주세요.";
      const url = linkFor(service, userId, now);
      return url
        ? `관심사 고르기 (7일 동안 열림): ${url}`
        : "이 라피에는 관심사 페이지가 설정되지 않았습니다.";
    }
    case "끄기":
      return (await service.store.removeStarSubscriber(userId))
        ? "스타 알림을 껐습니다. 저장해 둔 스타, 관심사, 👍/👎 기록도 모두 지웠습니다."
        : "스타 알림을 받고 있지 않습니다.";
    case "보기":
      if (!current)
        return "스타 알림을 받고 있지 않습니다. `/스타 연결`로 GitHub 아이디를 연결하면 매일 아침 DM으로 보내 드립니다.";
      return [
        `GitHub **${current.githubLogin}** 스타 알림을 받고 있습니다. 매일 아침 9시(한국 시간) DM.`,
        current.pausedAt
          ? `멈춤: ${current.pausedReason ?? "이유 모름"}. \`/스타 연결\`을 다시 하면 이어서 받습니다.`
          : "",
      ]
        .filter(Boolean)
        .join("\n");
    default:
      throw new Error("지원하지 않는 스타 동작입니다.");
  }
}
