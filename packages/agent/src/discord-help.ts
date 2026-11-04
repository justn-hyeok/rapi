import { CARD_COLOR, discordEmbed, type DiscordCard } from "@redhood/core";

/** The pinned guide in #레드후드-도움말: what Redhood does and where to start. */
export function helpCards(): DiscordCard[] {
  return [
    {
      title: "레드후드 사용 안내",
      description: "레드후드는 AI·개발 소식을 모아 고르고, 카드로 올려 줍니다.",
      color: CARD_COLOR.info,
      fields: [
        {
          name: "채널 안내",
          value:
            "`#ai-블로그` 공식 블로그 소식 · `#무료-토큰` 무료 크레딧·티어 소식 · `#프로젝트-소식` `#세팅-추천레포` 개발자 큐레이션",
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
