# 구조

Rapi는 헥사고날(포트와 어댑터) 구조를 따른다. 안쪽은 바깥을 모른다. 바깥이 안쪽의 포트를 구현하거나 호출한다.

```
   Discord 명령 · 웹 페이지 · 10분 주기 작업              apps/bot, apps/monitor   들어오는 쪽 + 조립
                  │ 호출
   ┌──────────────▼───────────────┐
   │ @rapi/application            │  유스케이스와 포트(*Store, *Gateway)
   │   ┌──────────────────────┐   │
   │   │ @rapi/domain         │   │  규칙과 계산, 메시지 모양
   │   └──────────────────────┘   │
   └──────────────▲───────────────┘
                  │ 포트 구현
   @rapi/adapters: postgres · discord · github · web · models · ...   나가는 쪽
```

## 계층

| 패키지 | 하는 일 | 가져와도 되는 것 |
| --- | --- | --- |
| `@rapi/domain` | 규칙, 순수 계산, 메시지 모양. 바깥이 없다고 생각하고 쓴다 | `zod`, `node:crypto` |
| `@rapi/application` | 유스케이스. 필요한 바깥 일은 포트로 적는다 | `@rapi/domain`, `node:crypto`, `zod`, `yaml` |
| `@rapi/adapters` | 포트 구현. Postgres(마이그레이션 포함), Discord, GitHub, 웹 수집, 모델 | `@rapi/domain`, `@rapi/application`, `pg`, Node I/O |
| `@rapi/config` | 환경 변수 읽기와 검증 | `zod` |
| `apps/*` | 들어오는 어댑터(Discord 명령, 웹 페이지, 주기 작업)와 조립(`run.ts`) | 전부 |

유스케이스는 `fetch`, 파일, `pg`를 직접 쓰지 않는다. `apps/bot/src/run.ts`가 어댑터를 만들어 유스케이스에 꽂는다. `tests/architecture.test.ts`가 import와 이름 규칙을 검사하고, 어기면 `npm run check`가 실패한다.

## 이름

| 무엇 | 규칙 | 예 |
| --- | --- | --- |
| 저장 포트 | `<대상>Store` | `GuildStore`, `StarStore`, `ConnectionStore` |
| 바깥 서비스 포트 | `<바깥>Gateway` | `DiscordGateway`, `GitHubGateway`, `SourceGateway`, `ModelGateway`, `OAuthGateway` |
| 구현 | 쓰는 기술을 앞에 붙인다 | `PostgresGuildStore`, `DiscordHttpGateway`, `WebSourceGateway`, `CodexModelGateway` |
| 유스케이스 클래스 | 파일 이름을 따른다 | `sources/collection.ts`의 `SourceCollection`, `discord/commands.ts`의 `DiscordCommands` |
| 사람 | Discord 사람은 어디서나 `userId`(DB는 `user_id`). `owner`는 봇 소유자에만 쓴다 | `starsOf(userId)`, `ownerIds` |
| 명령을 한 사람 | `actorId` | `setGuildFeature(…, actorId)` |

포트는 모두 그 기능의 `ports.ts`에 있다. 유스케이스가 포트의 일부만 쓸 때도 그 모양(`ReminderStore`, `CommunityFeedStore`)을 `ports.ts`에 둔다. `SecretBox`(토큰 봉인)는 바깥 서비스도 저장소도 아니라서 예외다. `Adapter`, `Repository`, `Manager` 같은 끝말은 새로 만들지 않는다.

Postgres는 `PostgresDatabase`(연결과 트랜잭션) 하나 위에 포트마다 저장소가 하나씩 있다. `postgresStores(db)`가 전부 만들고, 포트 두 개를 함께 쓰는 유스케이스에는 `run.ts`에서 `joinStores(…)`로 묶어 준다.

## 폴더

`domain`과 `application`은 같은 기능 이름으로 폴더를 나눈다. `adapters`는 상대하는 바깥으로 나눈다.

| 기능 | domain | application | 주로 쓰는 adapters |
| --- | --- | --- | --- |
| 스타 알림 | `stars/` 디깅, 관심사, 쉬는 규칙 | `stars/` 매일 알림, 관심사 페이지, 구독 | `postgres/star-*`, `github/stars.ts` |
| 외부 계정 연결 | | `connections/` | `postgres/connection-store.ts`, `github/oauth.ts`, `crypto/` |
| 할인 후보 | `discounts/` 후보, 확인, 카드 | `discounts/` 수집, 확인, 게시, 제보 | `postgres/discount-*`, `postgres/report-store.ts`, `discount-routes/` |
| 서버 | `guilds/` 기능, 채널 | `guilds/` 승인 요청, 기능, 알림 채널, 업데이트 알림 | `postgres/guild-store.ts`, `postgres/rapi-update-store.ts` |
| 수집원 | `sources/` 항목, HTML 규칙 | `sources/` 수집 | `postgres/source-store.ts`, `web/` |
| 큐레이션 | `community/` | `community/` | `postgres/community-store.ts` |
| Discord | `discord/` 권한, 카드, 메시지 모양 | `discord/` 명령, 도움말, 서버 구성 | `discord/` |
| 모델 | `models/` 예산, 사용량 | `models/` 포트 | `models/` |

domain의 `operations/`(상태 판단)와 `shared/`(공개 주소 규칙, 비밀 가리기)는 여러 기능이 같이 쓴다. apps/bot에서 `discord-http.ts`는 Discord 상호작용과 웹 페이지 서버, `connect-page.ts`·`star-page.ts`·`site-page.ts`는 웹 페이지, `run.ts`는 조립이다.

## 새로 붙일 때

- 기능: domain과 application에 같은 이름의 폴더를 만들고, 바깥이 필요한 일은 `application/src/<기능>/ports.ts`에 `Store`나 `Gateway`로 적는다. 구현은 adapters에서 상대하는 바깥 폴더에 두고, `run.ts`에서 꽂는다.
- 저장: `adapters/postgres/migrations/NNNN_*.sql`과 같은 이름의 `adapters/postgres/rollbacks/` 파일을 같이 만든다. 롤백이 없으면 릴리즈 전환이 거부된다.
- 외부 계정(OAuth): `CONNECTION_PROVIDERS`에 이름을 넣고 `OAuthGateway`를 구현해 `run.ts`의 `connections.providers`에 꽂는다. 명령, 콜백 주소, 게이트웨이, 저장, 회수는 손대지 않는다. 자세한 흐름은 [운영 문서](operations.md)의 "외부 계정 연결"에 있다.
