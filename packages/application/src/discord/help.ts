import { CARD_COLOR, discordEmbed, type DiscordCard } from "@rapi/domain";

/** The pinned guide in #라피-도움말: what Rapi does and where to start. */
export function helpCards(): DiscordCard[] {
  return [
    {
      title: "라피 사용 안내",
      description: "라피는 AI·개발 소식을 모아 고르고, 카드로 올려 줍니다.",
      color: CARD_COLOR.info,
      fields: [
        {
          name: "채널 안내",
          value:
            "`#ai-블로그` 공식 블로그 소식 · `#무료-토큰` 무료 크레딧·티어 소식 · `#프로젝트-소식` `#세팅-추천레포` 개발자 큐레이션",
        },
        {
          name: "스타 알림",
          value:
            "`/스타 켜기`로 GitHub 계정을 연결하면 매일 아침 DM으로 잊고 있던 스타와 새로 파낸 저장소를 보내 드립니다. `/스타 끄기`로 멈추고, 연결은 `/연결`에서 보고 끊습니다.",
        },
        {
          name: "AI 할인 알림",
          value:
            "서버 관리자가 `/ai-할인-알림 켜기`로 채널을 정하면 운영자가 확인한 카드가 그 채널에 올라옵니다. 새 AI 서비스 소식은 `/새-서비스-알림 켜기`로 받습니다. 쓸 수 있는 명령은 `/도움말`에서 봅니다.",
        },
      ],
    },
  ];
}

/** What /도움말 answers: every command, grouped by who may run it. */
export function helpText(siteUrl?: string): string {
  const lines = [
    "**라피 사용법**",
    "기능은 서버마다 꺼져 있을 수 있어요.",
    "",
    "**누구나**",
    "`/스타 켜기` GitHub를 연결하면 잊고 있던 스타와 새로 찾은 저장소를 매일 아침 DM으로 보내 줍니다.",
    "`/연결 보기` 연결한 계정을 봅니다. `/연결 끊기`로 끊습니다.",
    "`/제보` AI 할인이나 새 서비스 링크를 운영자에게 알립니다.",
    "",
    "**서버 관리자**",
    "`/ai-할인-알림 켜기` AI 할인 카드를 받을 채널을 정합니다.",
    "`/새-서비스-알림 켜기` 새 AI 서비스 소식을 받을 채널을 정합니다.",
    "`/라피-업데이트-알림 켜기` 라피 새 버전 소식을 받을 채널을 정합니다.",
  ];
  if (siteUrl) lines.push("", `소개와 개인정보 안내: ${siteUrl}`);
  return lines.join("\n");
}

export function helpMessageBody(): string {
  return JSON.stringify({
    embeds: helpCards().map((card) => discordEmbed(card)),
    allowed_mentions: { parse: [] },
  });
}
