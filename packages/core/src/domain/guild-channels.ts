/**
 * What can be sent where with /알림채널. A server picks a channel for what is published;
 * review cards hold the owner's decisions, so only the owner places them, at home.
 */
export const NOTIFICATION_KINDS = [
  { key: "discount", label: "할인 소식", review: false },
  { key: "new_service", label: "새 서비스 소식", review: false },
  { key: "review_discount", label: "검토: 할인", review: true },
  { key: "review_new_service", label: "검토: 새 서비스", review: true },
  { key: "review_report", label: "검토: 제보", review: true },
  { key: "review_guild_request", label: "검토: 서버 요청", review: true },
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number]["key"];
export type PublicNotificationKind = "discount" | "new_service";

export function isNotificationKind(value: unknown): value is NotificationKind {
  return NOTIFICATION_KINDS.some((kind) => kind.key === value);
}

export function isReviewKind(kind: NotificationKind): boolean {
  return NOTIFICATION_KINDS.some(({ key, review }) => key === kind && review);
}

export function notificationKindLabel(kind: NotificationKind): string {
  return NOTIFICATION_KINDS.find(({ key }) => key === kind)?.label ?? kind;
}

/** What /알림채널 보기 answers. Review kinds are shown only where they can be set. */
export function describeNotificationChannels(
  saved: ReadonlyMap<string, string>,
  showReview: boolean,
): string {
  return [
    "이 서버의 알림 채널",
    ...NOTIFICATION_KINDS.filter(({ review }) => showReview || !review).map(
      ({ key, label }) => {
        const channelId = saved.get(key);
        return `${label}: ${channelId ? `<#${channelId}>` : "없음"}`;
      },
    ),
  ].join("\n");
}
