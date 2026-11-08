# AGENTS.md

Rapi는 공개 Discord 봇이다. 승인된 서버에서만 동작하고, 운영 VM 한 대에서 돈다.

## 먼저 물어볼 것

코드, 테스트, 브랜치 커밋, PR은 알아서 한다. 아래는 저장소 주인에게 묻고 답을 받은 뒤에 한다.

- PR 머지
- 운영 DB 수정
- 수집원 추가·삭제 (`config/discount-sources.json`)
- 모델이나 프로바이더 선택·변경
- 봇 프로필과 Discord·GitHub 앱 설정 변경

기준은 하나다. 주인만 아는 사정이나 취향에 달린 결정이면 묻는다. 요청받은 것 밖의 일은 하지 않는다.

## 구조

[docs/architecture.md](docs/architecture.md)를 먼저 읽는다. domain, application, adapters, apps의 경계와 이름 규칙이 있고, `tests/architecture.test.ts`가 검사한다.

- 포트는 기능별 `ports.ts`에 둔다. 이름은 `*Store`와 `*Gateway`다.
- 마이그레이션을 추가하면 같은 이름의 롤백도 만든다. 없으면 릴리즈 전환이 거부된다.

## 검사

커밋 전에 `npm run check`를 돌린다. 형식, 타입, 린트, 테스트를 모두 본다.

## 운영

자세한 내용은 [docs/operations.md](docs/operations.md)에 있다.

- 접속: `ssh rapi-agent`. 체크아웃과 `.env`는 `/home/justn/rapi`에 있다.
- 배포: CI를 통과한 main을 타이머가 5분마다 가져가 배포한다. main에 머지하면 곧 운영에 나간다.
- 확인: `curl -s 127.0.0.1:4000/ready`의 `revision`이 배포한 SHA와 같아야 한다.
- DB: `docker exec rapi-postgres-1 psql -U rapi -d rapi`
- `ops/gateway/run.mjs`는 배포에 포함되지 않는다. 바꾸면 VM에 복사하고 `rapi-public-gateway`를 다시 시작한다.
- VM 셸에서는 `tr`와 `wc`가 다른 명령으로 잡혀 있다. 대신 python을 쓴다.

## 비밀값

- 토큰과 키는 채팅, Git, 명령 출력에 남기지 않는다.
- VM `.env`를 고치기 전에 `.env.bak-*`로 백업한다.

## 콘텐츠

- 도박, 계정·인증서 풀, 신분 대여를 내세우는 후보는 올리지 않는다. 규칙은 `isHazardous`에 있다.
- 험한 별명은 저장소에도, 봇 문구에도 넣지 않는다.
