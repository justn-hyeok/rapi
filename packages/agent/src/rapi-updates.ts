import {
  CARD_COLOR,
  discordEmbed,
  releaseSummary,
  type DeliveryAdapter,
} from "@rapi/core";
import type { PostgresStore } from "@rapi/db";
import { messageBody } from "./community-feeds.js";

export interface RapiRelease {
  tag: string;
  url: string;
  body: string;
}

const failureText = (id: string, error: unknown) =>
  `${id}: ${error instanceof Error ? error.message : "failed"}`;

/**
 * Tells the servers that chose a channel about a new release. The first run only
 * remembers the current one, and a channel that fails is not asked again, so an
 * outage in one server cannot repeat the notice in the others.
 */
export async function announceRapiUpdate(input: {
  store: Pick<PostgresStore, "rapiUpdateNoticed" | "claimRapiUpdate">;
  delivery: Pick<DeliveryAdapter, "send">;
  channelIds: () => Promise<readonly string[]>;
  latestRelease: () => Promise<RapiRelease>;
}): Promise<string[]> {
  const { store, delivery } = input;
  let release: RapiRelease;
  let channelIds: readonly string[];
  try {
    release = await input.latestRelease();
    const first = !(await store.rapiUpdateNoticed());
    if (!(await store.claimRapiUpdate(release.tag)) || first) return [];
    channelIds = await input.channelIds();
  } catch (error) {
    return [failureText("rapi update", error)];
  }
  const failures: string[] = [];
  for (const channelId of channelIds) {
    try {
      await delivery.send(
        { channel: "discord_channel", recipientId: channelId },
        {
          subject: release.tag,
          text: release.tag,
          html: "",
          itemIds: [],
          discord: messageBody([
            discordEmbed({
              title: `라피 ${release.tag}`,
              url: release.url,
              description: releaseSummary(release.body),
              color: CARD_COLOR.info,
            }),
          ]),
        },
        `rapi-update:${release.tag}:${channelId}`,
      );
    } catch (error) {
      failures.push(failureText(`rapi update ${channelId}`, error));
    }
  }
  return failures;
}
