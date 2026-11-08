import { CARD_COLOR, discordEmbed, type DiscordCard } from "@rapi/core";

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
      ],
    },
  ];
}

export function helpMessageBody(): string {
  return JSON.stringify({
    embeds: helpCards().map((card) => discordEmbed(card)),
    allowed_mentions: { parse: [] },
  });
}
