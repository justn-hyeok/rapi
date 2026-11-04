/**
 * What can be switched per server. Discount cards and star reminders go to the
 * owner's own channel and DM, so they are not on this list.
 */
export const GUILD_FEATURES = [
  { key: "status", label: "상태", uses: "/상태, /수집원", on: true },
  { key: "report", label: "제보", uses: "/제보", on: false },
  {
    key: "server_config",
    label: "서버 구성",
    uses: "/서버구성, 인증 버튼",
    on: false,
  },
  {
    key: "curation",
    label: "소식 카드",
    uses: "AI 블로그, 무료 토큰 채널",
    on: false,
  },
] as const;

export type GuildFeature = (typeof GUILD_FEATURES)[number]["key"];

export interface GuildFeatureSetting {
  feature: string;
  enabled: boolean;
}

export function isGuildFeature(value: unknown): value is GuildFeature {
  return GUILD_FEATURES.some((feature) => feature.key === value);
}

export function allGuildFeatures(): Set<GuildFeature> {
  return new Set(GUILD_FEATURES.map((feature) => feature.key));
}

/** A saved setting wins; a feature without one stays at its default. */
export function enabledGuildFeatures(
  settings: readonly GuildFeatureSetting[],
): Set<GuildFeature> {
  const saved = new Map(settings.map((row) => [row.feature, row.enabled]));
  return new Set(
    GUILD_FEATURES.filter(({ key, on }) => saved.get(key) ?? on).map(
      ({ key }) => key,
    ),
  );
}

function featureLabel(feature: GuildFeature): string {
  return GUILD_FEATURES.find(({ key }) => key === feature)?.label ?? feature;
}

/** Shown to anyone using a feature that is off in this server. */
export function guildFeatureRefusal(feature: GuildFeature): string {
  return `이 서버에서는 ${featureLabel(feature)} 기능이 꺼져 있습니다. 라피 운영자가 켜면 쓸 수 있어요.`;
}

/** What /기능 answers: one line per feature. */
export function describeGuildFeatures(
  enabled: ReadonlySet<GuildFeature>,
  home: boolean,
): string {
  return [
    home
      ? "이 서버의 기능 (홈 서버는 항상 모두 켜져 있습니다)"
      : "이 서버의 기능",
    ...GUILD_FEATURES.map(
      ({ key, label, uses }) =>
        `${enabled.has(key) ? "켜짐" : "꺼짐"} · ${label} (${uses})`,
    ),
  ].join("\n");
}

export function guildFeatureChanged(
  feature: GuildFeature,
  enabled: boolean,
): string {
  return `${featureLabel(feature)} 기능을 ${enabled ? "켰습니다" : "껐습니다"}.`;
}
