import {
  allGuildFeatures,
  enabledGuildFeatures,
  type GuildFeature,
} from "@rapi/domain";
import { type GuildStore } from "./ports/index.js";

export interface GuildFeatureSwitch {
  enabled(guildId: string): Promise<ReadonlySet<GuildFeature>>;
  set(
    guildId: string,
    feature: GuildFeature,
    enabled: boolean,
    actorId: string,
  ): Promise<void>;
}

const logFailure = (error: unknown) =>
  process.stderr.write(
    `guild features: ${error instanceof Error ? error.message.slice(0, 200) : "failed"}\n`,
  );

/**
 * Read on every use, so a change counts from the next interaction. A failed read
 * refuses instead of guessing, and the home guild never needs the database.
 */
export function createGuildFeatures(input: {
  store: Pick<GuildStore, "guildFeatureSettings" | "setGuildFeature">;
  homeGuildId: string | undefined;
}): GuildFeatureSwitch {
  return {
    async enabled(guildId) {
      if (guildId === input.homeGuildId) return allGuildFeatures();
      try {
        return enabledGuildFeatures(
          await input.store.guildFeatureSettings(guildId),
        );
      } catch (error) {
        logFailure(error);
        throw new Error(
          "이 서버의 기능 설정을 확인하지 못했습니다. 잠시 뒤 다시 시도해 주세요.",
          { cause: error },
        );
      }
    },
    async set(guildId, feature, enabled, actorId) {
      if (guildId === input.homeGuildId)
        throw new Error("홈 서버는 항상 모두 켜져 있어 바꿀 수 없습니다.");
      try {
        await input.store.setGuildFeature(guildId, feature, enabled, actorId);
      } catch (error) {
        logFailure(error);
        throw new Error(
          "기능 설정을 저장하지 못했습니다. 잠시 뒤 다시 시도해 주세요.",
          { cause: error },
        );
      }
    },
  };
}
