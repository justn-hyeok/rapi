/**
 * Each alert has its own command. A server picks a channel for what is published;
 * review cards hold the owner's decisions, so only the owner places them, at home.
 */
export const ALERT_COMMANDS = [
  {
    name: "ai-할인-알림",
    kind: "discount",
    label: "AI 할인",
    about: "AI 할인 소식",
  },
  {
    name: "새-서비스-알림",
    kind: "new_service",
    label: "새 서비스",
    about: "새로 나온 AI 서비스 소식",
  },
  {
    name: "라피-업데이트-알림",
    kind: "rapi_update",
    label: "라피 업데이트",
    about: "라피 새 버전 소식",
  },
] as const;

export const REVIEW_ALERT_COMMAND = "검토-알림";

export const REVIEW_ALERT_KINDS = [
  { key: "review_discount", label: "검토: 할인" },
  { key: "review_new_service", label: "검토: 새 서비스" },
  { key: "review_report", label: "검토: 제보" },
  { key: "review_guild_request", label: "검토: 서버 요청" },
] as const;

export type PublicAlertKind = (typeof ALERT_COMMANDS)[number]["kind"];
export type ReviewAlertKind = (typeof REVIEW_ALERT_KINDS)[number]["key"];
export type AlertKind = PublicAlertKind | ReviewAlertKind;

export function isReviewAlertKind(value: unknown): value is ReviewAlertKind {
  return REVIEW_ALERT_KINDS.some(({ key }) => key === value);
}

export function isAlertKind(value: unknown): value is AlertKind {
  return (
    isReviewAlertKind(value) ||
    ALERT_COMMANDS.some(({ kind }) => kind === value)
  );
}

export function alertLabel(kind: AlertKind): string {
  return (
    ALERT_COMMANDS.find((command) => command.kind === kind)?.label ??
    REVIEW_ALERT_KINDS.find(({ key }) => key === kind)?.label ??
    kind
  );
}

/**
 * What a server sees of a release: the opening line and what changed. Release notes
 * also say how it was checked and what is left, which is for the owner.
 */
export function releaseSummary(body: string): string {
  const [intro = "", ...sections] = body.split(/^## /m);
  const changed = sections.find((section) => /^바뀐 것\s*\n/.test(section));
  return [intro.trim(), changed?.replace(/^바뀐 것\s*\n/, "").trim()]
    .filter(Boolean)
    .join("\n\n");
}
