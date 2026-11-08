# 구조

Rapi는 헥사고날(포트와 어댑터) 구조를 따른다. 안쪽은 바깥을 모른다. 바깥이 안쪽의 포트를 구현하거나 호출한다.

```
            Discord 명령 · 웹 페이지 · 10분 주기 작업        ← 들어오는 쪽 (apps/bot, apps/monitor)
                            │ 호출
                 ┌──────────▼──────────┐
                 │  @rapi/application        │  유스케이스: 기능의 흐름
                 │  ┌───────────────┐  │
                 │  │ @rapi/domain    │  │  도메인: 규칙과 계산 + 포트(인터페이스)
                 │  └───────────────┘  │
                 └──────────▲──────────┘
                            │ 포트 구현
      Postgres(@rapi/db) · GitHub · Discord · 모델 · 웹 수집(@rapi/adapters)   ← 나가는 쪽
```

## 패키지와 규칙

| 패키지 | 역할 | 가져와도 되는 것 |
| --- | --- | --- |
| `@rapi/domain` | 밖과 주고받는 데이터 모양 | 없음 |
| `@rapi/domain` | 도메인 규칙, 순수 계산, 포트(`src/ports`) | `@rapi/domain`, `node:crypto` |
| `@rapi/application` | 유스케이스. 포트만 보고 일한다 | `@rapi/domain`, `@rapi/domain`, `node:crypto`, 순수 라이브러리(`zod`, `yaml`) |
| `@rapi/db` | 저장소 포트를 Postgres로 구현 | `@rapi/domain`, `@rapi/domain` |
| `@rapi/adapters` | 외부 서비스 포트 구현(GitHub, Discord, 모델, 수집) | `@rapi/domain`, `@rapi/domain` |
| `@rapi/config` | 환경 변수 읽기와 검증 | 없음 |
| `apps/*` | 들어오는 어댑터와 조립(composition root) | 전부 |

- 유스케이스는 `PostgresStore`나 `fetch`를 직접 부르지 않는다. 필요한 일을 `@rapi/domain`의 포트로 적고, `apps/bot`이 실제 구현을 꽂는다.
- 포트가 주고받는 레코드 타입(예: `StarSubscriber`)은 `@rapi/domain`에 둔다. `@rapi/db`는 그 타입을 만들어 돌려줄 뿐이다.
- 파일, 네트워크, 프로세스 같은 Node I/O는 `@rapi/domain`와 `@rapi/application`에 두지 않는다.
- `tests/architecture.test.ts`가 위 규칙을 import 단위로 검사한다. 규칙을 어기면 `npm run check`가 실패한다.

## 기능 하나의 모양

기능은 네 군데에 나눠 산다. 스타 알림을 예로 든다.

| 자리 | 위치 | 예 |
| --- | --- | --- |
| 도메인 | `core/src/domain/star-*.ts` | 디깅 점수, 관심사, 쉬는 규칙 |
| 포트 | `core/src/ports/*.ts` | `StarStore`, `GitHubGateway` |
| 유스케이스 | `agent/src/star-*.ts` | 매일 알림, 투표, 구독 |
| 어댑터 | `db/src/star-owner-store.ts`, `adapters/src/github-stars.ts`, `apps/bot/src/star-page.ts` | Postgres, GitHub API, 관심사 페이지 |

## 외부 계정 연결

GitHub처럼 사용자가 자기 계정을 붙이는 서비스는 기능이 아니라 연결 계층이 맡는다. 기능은 "이 사람의 GitHub 연결"을 포트로 받아 쓰고 토큰을 직접 저장하지 않는다. 자세한 흐름은 [운영 문서](operations.md)의 연결 항목에 있다.
