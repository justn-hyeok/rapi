# AGENTS.md

Rapi는 Justn과 Justn 주변 사람들을 위한 Discord 봇이다. 개발 소식이든 니케 같은 게임이든, 나중에 들어갈 내부 게임이든 전부 Justn의 취향을 따른다.

화이트리스트로 운영한다. 승인된 서버에서만 동작하고, 돈을 벌 생각은 없다.

구조는 [docs/architecture.md](docs/architecture.md), 운영은 [docs/operations.md](docs/operations.md)를 본다. 커밋 전에 `npm run check`를 돌린다.

## 먼저 물어볼 것

코드, 테스트, 브랜치 커밋, PR은 알아서 한다. 아래는 Justn에게 묻고 답을 받은 뒤에 한다. main에 머지하면 5분 안에 운영에 나간다.

- PR 머지
- 운영 DB 수정
- 수집원 추가·삭제
- 모델이나 프로바이더 선택·변경
- 봇 프로필과 Discord·GitHub 앱 설정 변경

기준은 하나다. Justn만 아는 사정이나 취향에 달린 결정이면 묻는다. 요청받은 것 밖의 일은 하지 않는다.

## 운영 VM

- 접속은 `ssh rapi-agent`다.
- 셸에서 `tr`와 `wc`가 다른 명령으로 잡혀 있다. 대신 python을 쓴다.
- `.env`를 고치기 전에 `.env.bak-*`로 백업한다.

## 지킬 것

- 토큰과 키는 채팅, Git, 명령 출력에 남기지 않는다.
- 험한 별명은 저장소에도, 봇 문구에도 넣지 않는다.
