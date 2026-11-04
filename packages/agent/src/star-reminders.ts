import { DiscordServerError, UncertainDeliveryError } from "@rapi/adapters";
import {
  discordEmbed,
  kstDateKey,
  kstReached,
  pickForgottenStars,
  starButton,
  starCard,
  type DeliveryAdapter,
  type DeliveryPayload,
  type GitHubStar,
  type StoredStar,
} from "@rapi/core";
import type { PostgresStore } from "@rapi/db";

const REMINDER_KST_HOUR = 9;

type StarStore = Pick<
  PostgresStore,
  | "saveStars"
  | "currentStars"
  | "starReminderClaimed"
  | "claimStarReminder"
  | "releaseStarReminder"
  | "saveStarReminderMessage"
>;

const failureText = (step: string, error: unknown) =>
  `${step}: ${error instanceof Error ? error.message : "failed"}`;

/** One message for the day: a card and a link button for each star. The adapter turns mentions off. */
export function starReminderPayload(
  stars: readonly StoredStar[],
): DeliveryPayload {
  const buttons = stars.flatMap((star) => starButton(star) ?? []);
  return {
    subject: "잊고 있던 스타",
    text: stars.map((star) => star.fullName).join("\n"),
    html: "",
    itemIds: [],
    discord: {
      embeds: stars.map((star) => discordEmbed(starCard(star))),
      components: buttons.length ? [{ type: 1, components: buttons }] : [],
    },
  };
}

/**
 * Runs often and does nothing outside its moment: from 09:00 Asia/Seoul until the
 * day's message is claimed. A failed read keeps what is stored and still reminds
 * from it. Claimed before sending, so dying mid-send loses the day's message rather
 * than sending it twice. Only a send Discord definitely refused is released and
 * tried again on a later run. Returns the failures.
 */
export async function remindStars(input: {
  store: StarStore;
  delivery: Pick<DeliveryAdapter, "send">;
  ownerId: string;
  readStars: () => Promise<{ stars: GitHubStar[]; complete: boolean }>;
  // The list is read once a day, even when the read fails or the send is tried again.
  // A restart forgets this, which costs a few requests at most.
  reads: { lastDay?: string };
  now?: Date;
  random?: () => number;
}): Promise<string[]> {
  const { store, delivery, ownerId, readStars, reads } = input;
  const now = input.now ?? new Date();
  if (!kstReached(now, REMINDER_KST_HOUR)) return [];
  const day = kstDateKey(now);
  const failures: string[] = [];
  let picked: StoredStar[];
  try {
    if (await store.starReminderClaimed(day)) return [];
    if (reads.lastDay !== day) {
      reads.lastDay = day;
      try {
        const { stars, complete } = await readStars();
        await store.saveStars(stars, complete);
      } catch (error) {
        failures.push(failureText("read", error));
      }
    }
    picked = pickForgottenStars(await store.currentStars(), now, input.random);
    if (picked.length === 0 || !(await store.claimStarReminder(day, picked)))
      return failures;
  } catch (error) {
    return [...failures, failureText("stars", error)];
  }
  let messageId: string;
  try {
    const sent = await delivery.send(
      { channel: "discord_dm", recipientId: ownerId },
      starReminderPayload(picked),
      `star-reminder:${day}`,
    );
    messageId = sent.providerId;
  } catch (error) {
    failures.push(failureText("send", error));
    // It may have reached the owner, and one more day without stars costs nothing.
    if (
      !(error instanceof UncertainDeliveryError) &&
      !(error instanceof DiscordServerError)
    )
      await store
        .releaseStarReminder(day, picked)
        .catch((releaseError: unknown) =>
          failures.push(failureText("release", releaseError)),
        );
    return failures;
  }
  await store
    .saveStarReminderMessage(day, messageId)
    .catch((saveError: unknown) =>
      failures.push(failureText("save", saveError)),
    );
  return failures;
}
