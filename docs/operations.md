# 운영, 권한, 보안

## 필요한 것

- Linux VM 한 대와 SSH 관리 권한
- Discord 앱과 봇. 토큰은 소유자가 VM에 직접 넣는다.
- 도메인과 Cloudflare Tunnel. Discord가 봇에 HTTP로 요청을 보내는 공개 경로다.
- 선택: 공개 저장소 읽기 권한의 GitHub 토큰(`GITHUB_READ_TOKEN`). 없으면 후보 경로 두 개를 건너뛴다.
- 선택: 모델 공급자 키. 아래 [모델 호출](#모델-호출-선택) 참고.

## 권한

| 주체 | 허용 | 금지 |
| --- | --- | --- |
| Discord 봇 | 카드를 보낼 채널의 보기, 메시지 보내기, 링크 첨부. `/서버구성`을 적용할 때만 채널과 역할 관리 | 개인 계정 토큰, self-bot |
| GitHub 토큰 | 공개 저장소 읽기 | 저장소 쓰기, 조직 관리 |

## 비밀값

저장소에는 값이 없는 `.env.example`만 둔다. 운영 값은 VM의 `/home/justn/rapi/.env`(권한 0600)에 둔다. 토큰 원문은 Discord나 Git 이력에 보내지 않고, 로그와 오류 보고에도 남기지 않는다.

## VM 구성

| 유닛 | 하는 일 |
| --- | --- |
| `rapi-bot` | Discord 상호작용 처리(HTTP, Gateway 연결 없음)와 주기 작업 |
| `rapi-monitor` | 독립 상태 감시와 장애·복구 알림 |
| `rapi-public-gateway` | 공개 요청 중 `POST /interactions`만 봇에 전달 |
| `rapi-tunnel` | Cloudflare Tunnel |
| `rapi-postgres` | Compose PostgreSQL 준비 확인 |
| `rapi-auto-deploy.timer` | 5분마다 CI를 통과한 `main` 확인 |
| `rapi-backup.timer` | 매일 03:00 UTC 백업 |
| `rapi-restore-smoke.timer` | 매주 일요일 04:00 UTC 복구 검증 |

## VM에 처음 올리기

옛 라피는 `/home/justn/archive/purple-rapi`로 보관했다. 아래 절차는 보관본을 건드리지 않는다.

| 항목 | 값 |
| --- | --- |
| systemd 유닛 | `rapi-*` |
| 소스, 릴리스 | `/home/justn/rapi`, `rapi-releases` |
| 상태 파일 | `/var/lib/rapi` |
| PostgreSQL | Compose 프로젝트 `rapi`, 5433 |
| 봇, 모니터 | 4000, 4300 |
| 게이트웨이, 터널 지표 | 4600, 4601, 4700 |
| 공개 주소 | `https://rapi.justn.me` |

소유자가 할 일은 Discord Developer Portal에서 새 앱과 봇을 만드는 것이다. 토큰은 VM의
`/home/justn/rapi/.env`에 직접 넣고 채팅이나 Git에는 남기지 않는다.

```bash
# 1. 소스와 상태 디렉터리
git clone https://github.com/justn-hyeok/rapi.git /home/justn/rapi
sudo groupadd --system rapi && sudo usermod -aG rapi justn
sudo install -d -o justn -g justn -m 0700 /var/lib/rapi
install -d -m 0700 /home/justn/rapi-releases /home/justn/rapi/backups

# 2. 환경 파일: .env.example을 복사해 값을 채운다. 권한은 0600.
#    RAPI_ENV=production, PORT=4000, MONITOR_PORT=4300
#    DATABASE_URL=postgresql://rapi:rapi-local-only@127.0.0.1:5433/rapi

# 3. 유닛 설치와 DB
sudo install -m 0644 ops/systemd/rapi-*.service ops/systemd/rapi-*.timer /etc/systemd/system/
sudo cp -r ops/systemd/rapi-bot.service.d /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now rapi-postgres.service
npm ci
DATABASE_URL=postgresql://rapi:rapi-local-only@127.0.0.1:5433/rapi ./scripts/migrate.sh

# 4. 첫 릴리스: 검증한 뒤 current를 직접 만들고 유닛을 연결한다.
sha=$(git rev-parse HEAD)
RAPI_RELEASE_SHA=$sha RAPI_RELEASE_ROOT=/home/justn/rapi-releases ./scripts/deploy-revision.sh
ln -s "$(ls -td /home/justn/rapi-releases/rapi-"${sha:0:12}"-* | head -1)" /home/justn/rapi-releases/current
sudo env RAPI_RELEASE_UNITS_APPROVED=true RAPI_RELEASE_UNITS_RECEIPT=/home/justn/rapi-releases/unit-wiring.json \
  RAPI_CURRENT_RELEASE=/home/justn/rapi-releases/current \
  RAPI_SERVICE_ENV_FILE=/home/justn/rapi/.env \
  RAPI_NODE_BINARY="$(command -v node)" node scripts/release-units.mjs --apply
sudo systemctl enable --now rapi-bot.service rapi-monitor.service

# 5. 이후 배포는 CI를 통과한 main을 5분마다 따라간다.
sudo systemctl enable --now rapi-auto-deploy.timer
```

확인: `curl -s 127.0.0.1:4000/ready`의 `revision`이 배포한 SHA와 같아야 한다.

## 배포 절차

릴리스 후보를 서비스 전환 없이 준비할 때는 깨끗한 후보 checkout에서 전체 SHA와
기존 스테이징 루트 디렉터리를 명시한다. `deploy-revision.sh`는 Git archive로
비밀값 없는 revision을 별도 디렉터리에 풀고, 새 `npm ci`와 check, proxy,
격리 E2E·restart·restore, audit를 모두 통과한 경우에만
`release-manifest.json`을 쓴다. 실패한 스테이징 디렉터리는 조사할 수 있도록 남긴다.
이 단계는 서비스를 교체하거나 재시작하지 않는다.

```bash
RAPI_RELEASE_SHA="$(git rev-parse HEAD)" \
RAPI_RELEASE_ROOT=/absolute/existing/staging-directory \
  ./scripts/deploy-revision.sh
```

manifest에는 원본·빌드 파일의 digest와 migration 목록도 들어간다.
`scripts/switch-release.mjs`는 후보와 이전 artifact를 검증하고, 현재 실행 중인
서비스만 중지·전환·재시작한다. `/ready`의 기동 시점 revision과 readiness가
일치해야 전환을 인정하며 실패하면 이전 artifact로 돌아가 같은 검사를 수행한다.

승인된 baseline/current pointer를 만든 뒤 `release-units.mjs --preview`로
unit 연결안을 확인한다. `--apply`는 기존 drop-in을 receipt에 보존하고 원자적으로
교체한 뒤 daemon-reload만 수행한다. 실패하면 이전 drop-in을 복구하며, 이 명령은
서비스를 재시작하지 않는다.

```bash
RAPI_CURRENT_RELEASE=/home/justn/rapi-releases/current \
RAPI_SERVICE_ENV_FILE=/home/justn/rapi/.env \
  node scripts/release-units.mjs --preview

# 운영 승인 후 root 권한으로 실행한다.
RAPI_RELEASE_UNITS_APPROVED=true \
RAPI_RELEASE_UNITS_RECEIPT=/absolute/evidence/unit-wiring.json \
RAPI_CURRENT_RELEASE=/home/justn/rapi-releases/current \
RAPI_SERVICE_ENV_FILE=/home/justn/rapi/.env \
  node scripts/release-units.mjs --apply
```

배포 전환에서는 monitor의 `/health`와 기동 revision을 검사한다. 봇은 `/ready`를
검사한다.

```bash
RAPI_SWITCH_APPROVED=true \
RAPI_CURRENT_RELEASE=/absolute/releases/current \
RAPI_CANDIDATE_RELEASE=/absolute/releases/candidate-directory \
RAPI_RELEASE_SHA=full-40-character-candidate-sha \
RAPI_SWITCH_RECEIPT=/absolute/evidence/switch-receipt.json \
RAPI_SERVICE_ENV_FILE=/home/justn/rapi/.env \
RAPI_SWITCH_SERVICES=bot,monitor \
  node scripts/switch-release.mjs
```

운영 승인을 받은 뒤에만 실행한다. current는 기존 symlink여야 하고, 이전
artifact에도 검증 manifest가 있어야 한다. 두 revision의 migration 목록이 다르면
자동 전환을 거부한다. 각 systemd unit의 WorkingDirectory가 current를 가리키고
ExecStart가 별도 보관한 운영 환경 파일을 읽도록 사전 설정해야 한다. 처음
도입하는 서버는 이전 코드의 실행 revision·호환성을 기록한 승인된 baseline
전환이 먼저 필요하다. 구 서비스에 manifest가 없다는 이유로 검사를 생략하지 않는다.

### 자동 배포

`rapi-auto-deploy.timer`가 5분마다 `scripts/auto-deploy.sh`를 실행한다. origin/main의
새 SHA에 대한 GitHub check run이 모두 성공하면, 그 SHA의 임시 worktree에서 위의
`deploy-revision.sh` 검증과 `switch-release.mjs` 전환을 그대로 수행하고 결과를
`OPERATIONS_CHANNEL_ID`로 알린다. CI나 검증·전환이 실패한 SHA는
`.auto-deploy-failed`에 기록하고 다음 SHA까지 다시 시도하지 않는다. 전환 실패 시
롤백은 `switch-release.mjs`가 수행한다. 성공하면 push되지 않은 커밋이 없는 경우에만
소스 체크아웃을 main으로 맞추고(로컬 수정 유지), 현재·직전 릴리스를 제외한 오래된
스테이징 디렉터리를 정리한다. 서비스에는 운영 환경 파일을 주입하지 않는다.

## 백업과 복구

백업은 `rapi-backup.timer`가 매일 만들고 30일이 지난 파일을 지운다(`BACKUP_RETENTION_DAYS`). `rapi-restore-smoke.timer`는 매주 격리된 임시 DB에 복원해 확인한다. 백업 생성 로그만으로 복구 가능성을 증명하지 않는다.

## 모니터링

`rapi-monitor`가 봇, 공개 게이트웨이, 터널의 준비 상태와 백업 상태, DB 크기(`DATABASE_SIZE_LIMIT_BYTES`)를 확인하고 운영 웹후크로 장애와 복구를 알린다.

## 운영 인수 체크리스트

- [ ] Discord 봇이 허용된 서버와 채널에서만 응답한다.
- [ ] self-bot 또는 개인 계정 토큰이 없다.
- [ ] 저장소와 빌드 산출물에 비밀값이 없다.
- [ ] HTTPS와 Discord 서명 검증이 적용됐다.
- [ ] 같은 후보와 알림을 재시도해도 중복되지 않는다.
- [ ] DB 백업을 별도 환경에서 실제 복원했다.

## 운영 명령

```bash
npm run bootstrap                  # 설치, DB, migration, 전체 검증
npm run db:migrate                 # 미적용 migration 적용
npm run discord:register-commands  # 슬래시 명령 등록
npm run backup                     # 백업 생성
npm run restore:smoke              # 격리된 임시 DB로 복구 검증
npm run restart:smoke              # PostgreSQL 재시작 전후 핵심 count 검증
npm run start:bot                  # 봇
npm run start:monitor              # 모니터
```

`npm run test:e2e`는 `compose.test.yaml`의 임시 PostgreSQL을 임의 로컬 포트에 기동하고 `rapi_test`만 사용한다. 운영 Compose나 DB에는 연결하지 않는다.

## 모델 호출 (선택)

`MODEL_API_BASE_URL`과 `MODEL_API_KEY`가 모두 있어야 켜진다. 없으면 모델 클라이언트를 만들지 않는다. 호출은 `model_usage`에 기록되고, `MODEL_MONTHLY_BUDGET_USD`를 넣으면 달력 월(Asia/Seoul) 기준 상한이 걸린다. 게이트웨이가 비용을 주지 않으면 `ops/model-prices.json`으로 계산한다. 요약은 기본이 Codex CLI이고, `SUMMARIZER_BACKEND=api`면 이 클라이언트를 쓴다. 할인 후보 검증은 모델을 부르지 않는다.

## html 수집원

`html` 수집원은 `collection_policy.html`에 `linkPattern`(경로 정규식, 200자 미만), `maxItems`(기본 20), `exclude`(경로 정규식 목록)를 둔다. 추가는 `createSource("html", url, "public", { html: {...} })`로 한다. `/수집원`은 상태 조회만 한다.

## 할인 후보 수집 (0.0.3)

봇이 시작 1분 뒤와 그 뒤 24시간마다 후보를 찾아 `discount_candidates`에 기록만 한다. Discord로 보내지 않는다. 출처 목록은 `config/discount-sources.json`에 있다.

| 경로 (`route`) | 찾는 것 | 출처 |
| --- | --- | --- |
| `changelog` | 할인 (`discount`) | OpenAI, Vercel, Cloudflare, AWS, Anthropic, DeepSeek, APIYI 공식 변경로그. 할인 문구가 있고 30일 안에 나온 항목만 |
| `pull_request` | 새 서비스 (`new_service`) | `anomalyco/models.dev`의 열린 PR 중 provider를 추가하는 것 |
| `code_search` | 새 서비스 (`new_service`) | GitHub 코드 검색. API 주소, 저장소, 파일 링크만 남기고 원문은 저장하지 않음. 대학, 정부, 회사 내부 주소는 `denylist`로 뺀다 |
| `catalog` | 새 서비스, 할인 | OpenRouter 제공사와 모델 목록을 전날과 비교해 새 제공사, 새 무료 모델, 20% 이상 내린 가격만. 첫 실행은 기준만 저장한다. 기준은 `source_cursors.cursor_value`에 있다 |
| `hacker_news` | 새 서비스, 할인 | 최근 7일 글의 제목만 검색. 할인은 AI API 낱말과 할인 문구가 함께 있어야 하고, 새 서비스는 `Show HN`이나 `alternative`가 있어야 한다 |
| `credit_feed` | 할인 | aifree.dev 무료 크레딧 피드에서 30일 안에 새로 등록된 항목만. 변경 감지와 재확인 항목은 뺀다 |
| `community` | 할인 | 중계 사이트가 홍보하는 게시판(`communities`): linux.do 福利羊毛과 V2EX 推广 노드, 3일 안의 글. 제목에 AI 낱말과 혜택 낱말이 함께 있어야 하고, 주거용 IP·대리 충전·계정 판매 글은 뺀다. 링크는 글 자체이고 도메인은 비워 둔다(빨강이 포럼 전체로 번지지 않게). linux.do는 Node 요청에 Cloudflare 검사를 걸어서(`cf-mitigated: challenge`) `client: "curl"`로 curl을 거쳐 읽는다. User-Agent는 그대로 `rapi`이고 하루 한 번이다 |
| `relay_list` | 할인 | 다른 사람이 GitHub에 관리하는 무료 중계 사이트(公益站) 목록 4개(`relayLists`). 전날과 비교해 새로 올라온 사이트와 좋아진 혜택만. 금액이 숫자로 적힌 목록은 금액이 오를 때만, 글로 적힌 목록은 문장부호를 뺀 글이 바뀌고 숫자나 지급 문구가 있을 때만 잡는다. 하루에 8건 넘게 바뀌면 목록을 고쳐 쓴 것으로 보고 기록만 한다. 첫 실행은 기준만 저장한다. 링크는 사이트 첫 화면이고 초대 코드는 뗀다 |
| `free_list` | 할인 | 업체 자체 무료 API 티어 목록 2개(`freeLists`: awesome-free-llm-apis, Free-LLM). 전날 없던 업체와 업체 밑에 새로 생긴 무료 모델만. 한도 문구는 늘었는지 줄었는지 알 수 없어서 바뀌어도 보지 않는다. OpenRouter처럼 다른 경로가 보는 곳은 `exclude`로 뺀다. 하루 8건 넘게 바뀌면 기록만 한다. 띠와 태그는 다른 공식 후보처럼 규칙으로 정한다 |
| `commit_log` | 할인 | AI 요금제 변경을 커밋으로 기록하는 저장소(`commitLogs`, 지금은 `jiegec/kb`). 마지막으로 본 커밋 이후의 `kb:`·`coding plan:` 커밋 중 기간 한정 무료, 반값, 무료 크레딧, 한도 상향처럼 무언가를 주는 것만. 끝남·취소·제거·종료는 뺀다. 링크는 커밋이고 도메인은 비워 둔다. 첫 실행은 위치만 저장한다 |
| `site_offer` | 할인 | 다른 경로가 찾은 새 서비스를 검증할 때 읽은 첫 화면에서 구체적인 혜택(크레딧 금액, % 할인, 가입 시 지급)을 찾으면 따로 후보로 올린다. "free tier"나 "100x cheaper" 같은 광고 문구는 보지 않는다. 첫 화면이 스크립트뿐이면(new-api 등) `/api/status`를 한 번 읽어 초대 가입 보너스를 본다. 감시 목록에 넣지는 않는다. 알려진 운영자는 건너뛴다. 서비스마다 한 번, 처음 검증할 때만 본다 |
| `promoclock` | 할인 | PromoClock(`promoclock.co/llms.txt`)의 AI 딜 목록. 전날 없던 딜만. 링크는 PromoClock이 확인한 공식 출처이고, 제휴 링크가 섞일 수 있는 PromoClock 페이지는 걸지 않는다. 일시 중지된 딜은 뺀다. 첫 실행은 기준만 저장한다. 딜 목록이라 할인 문구 검사 없이 끝난 날짜만 본다 |
| `relay_site` | 할인 | new-api로 만든 중계 사이트의 공개 `/api/status`·`/api/pricing`(`relaySites`). 전날과 비교해 커진 가입·초대 보너스, 20% 이상 내린 배율, 무료가 된 모델과 그룹, 무언가를 주는 새 공지만. "免费用户"(무료 사용자)처럼 원래 있던 요금제 이름이나 "倍率翻倍"(배율 두 배), "限量"(수량 제한)은 혜택으로 보지 않는다. 가격표에 로그인이 필요한 곳은 `pricing: false`로 상태만 본다. 하루 8건 넘게 바뀌면 기록만 한다. 봇 검사로 막는 사이트(AnyRouter)는 넣지 않는다 |

GitHub 경로 둘은 `GITHUB_READ_TOKEN`이 있어야 돈다. 없으면 건너뛰고 공식 변경로그만 돈다. 공개 저장소 읽기 권한이면 충분하다.

출처마다 `sources`에 `candidate_`로 시작하는 행이 있어 `/수집원`에서 최근 성공과 오류를 볼 수 있다. 토큰이 없어 건너뛴 것도 `last_error`에 남는다. 이 행들은 준비 상태(`/ready`)에 영향을 주지 않는다.

기록을 볼 때:

```sh
docker exec rapi-postgres-1 psql -U rapi -d rapi -c "SELECT route, kind, domain, left(title, 70) AS title, first_seen_at FROM discount_candidates ORDER BY first_seen_at DESC LIMIT 50"
```

## 할인 후보 검증 (0.0.4)

수집이 끝나면 띠 색이 없는 후보를 이어서 확인하고 같은 행에 적는다. 규칙만 쓰고 AI 모델은 부르지 않으며, Discord로 보내지 않는다. 기준은 [로드맵의 카드 규칙](../ROADMAP.md#정해진-카드-규칙)이다.

| 열 | 값 |
| --- | --- |
| `band` | `green`, `yellow`. `red`는 규칙이 절대 쓰지 않고 소유자만 정한다 |
| `tags` | `#직접호스팅`, `#오픈모델`, `#재판매` |
| `operator` | 확인한 운영 주체. 못 찾으면 비어 있음 |
| `price_check` | `below_list`(정가보다 쌈), `list_price`(정가라고 밝힘), `unknown` |
| `terms_url`, `terms_note` | 약관 링크, 또는 `확인 못 함`(페이지를 못 읽음), `링크 없음`(읽었지만 링크가 없음) |

- 운영 주체는 `config/discount-sources.json`의 `operators`에 있으면 그대로 쓴다. 없으면 후보 도메인의 첫 화면에서 법인 표기(`Inc.`, `주식회사` 등)를 찾는다.
- 초록은 아는 운영 주체이거나, 법인 표기가 있으면서 직접 호스팅, 정가 라우터, 공급처를 밝힌 오픈 모델 중계 중 하나일 때다. `official`이 아닌 곳이 비공개 모델을 할인하면 잘 알려진 곳이어도 노랑이고 `#재판매`다.
- 코드 검색 후보는 비공개 모델 이름 옆에서 찾은 주소라서 비공개 모델을 파는 것으로 본다.
- PR 후보는 서비스 주소를 모르므로 페이지를 읽지 않는다. 노랑, `확인 못 함`이다.
- 약관은 색을 바꾸지 않는다. 약관 내용은 읽지 않으며, 링크가 있다는 것만 적는다.
- 후보 하나를 못 읽어도 다음 후보로 넘어간다. 한 번 정한 색은 다시 정하지 않으며, 저장에 실패한 후보만 다음 실행에서 다시 확인한다. 한 번에 200건까지 본다.

후보 페이지는 낯선 사람의 파일에서 나온 주소라서 다음을 지킨다.

- HTTPS 443만 쓴다. IP 주소, `localhost`, 내부 이름, 사설 주소로 풀리는 이름은 연결하기 전에 거른다.
- 리디렉션은 3번까지 직접 따라가며 매번 같은 검사를 한다.
- 10초, 1 MB 제한을 둔다. 키나 쿠키를 보내지 않고, 페이지 원문을 저장하지 않는다.

결과를 볼 때:

```sh
docker exec rapi-postgres-1 psql -U rapi -d rapi -c "SELECT route, band, tags, operator, price_check, terms_note, domain, left(title, 50) AS title FROM discount_candidates ORDER BY verified_at DESC NULLS FIRST LIMIT 50"
```

빨강은 해당 도메인을 지목한 근거를 보고 소유자가 직접 정한다. 먹튀나 키 탈취가 확인된 곳을 올리지 않는 판단도 소유자가 한다.

```sh
docker exec rapi-postgres-1 psql -U rapi -d rapi -c "UPDATE discount_candidates SET band = 'red' WHERE domain = '도메인'"
```

## 할인 카드 (0.0.5)

`DISCOUNT_REVIEW_CHANNEL_ID`에 소유자만 보는 채널 ID를 넣으면 봇이 시작할 때와 그 뒤 10분마다 검증한 후보를 카드로 보낸다. 값이 없으면 아무것도 보내지 않고 봇은 그대로 뜬다. 봇에게 그 채널의 보기, 메시지 보내기, 링크 첨부 권한이 있어야 한다. 다른 채널로 내보내는 방법은 [승인 버튼](#승인-버튼-006)에 있다. 형식은 [로드맵의 카드 규칙](../ROADMAP.md#정해진-카드-규칙)을 따른다.

채널은 [`/검토-알림`](#알림-채널)으로 나눌 수 있다. `DISCOUNT_REVIEW_CHANNEL_ID`는 따로 정하지 않은 검토 알림이 가는 곳으로 남는다.

어떤 후보를 보내는가:

- `band`가 `green` 또는 `yellow`인 행만 보낸다. `red`와 아직 확인하지 않은 행은 보내지 않는다.
- `new_service`와 [제보](#제보-007)는 모두 보낸다. 다른 `discount`는 `price_check`가 `below_list`이거나 제목이나 근거에 무료, 크레딧, 가격 인하 문구가 적힌 행만 보내고, 글에 적힌 마감일이 지난 행은 보내지 않는다. 약관 변경 소식은 보내지 않는다.
- 게시일이 최근 7일 안인 행을 최신순으로 보낸다. 게시일이 없으면 처음 본 날로 따진다. 처음 수집하면 몇 달 전 변경로그도 오늘 처음 본 행이 되므로, 게시일이 있으면 처음 본 날은 보지 않는다. 더 오래된 행은 보내지 않고 그대로 둔다.
- 최근 1시간에 보낸 카드가 문제 제보 카드까지 합쳐 5장이면 멈추고, 나머지는 다음 실행으로 넘긴다.
- 새 서비스 카드는 하루 5장까지만 보낸다. 제보와 할인은 여기 들어가지 않는다. 남은 후보는 다음 날로 넘어가고, 7일이 지나면 보내지 않는다.
- `community` 글, `relay_list` 항목, `relay_site` 변경은 항상 노랑에 `#위험`이고(중계 사이트 둘은 `#재판매`도), 경고 줄과 주의 색으로 나가며 셋을 합쳐 하루 3장까지다. 공개 카드에도 경고가 그대로 붙는다.
- 모든 경로의 중국어 제목과 근거, 그리고 할인 후보의 영어 문장(한국어가 없고 영어 낱말이 셋 이상 이어지는 것)은 기록하기 전에 요약 모델로 한국어로 옮긴다. 이미 기록된 후보는 다시 옮기지 않는다. 새 서비스의 이름과 주소, 제보의 도메인은 그대로 둔다. 번역이 실패하면 원문 그대로 기록하고 실패를 수집 오류로 남긴다.

중복을 막는 방식:

- 보내기 전에 `carded_at`을 적고, 보낸 뒤 `card_message_id`를 적는다. 그래서 봇이 재시작해도 같은 카드를 두 번 보내지 않는다.
- 대신 보내는 도중 봇이 죽거나 Discord 응답을 받지 못하면 그 카드는 다시 보내지 않아 빠질 수 있다. `carded_at`만 있고 `card_message_id`가 없는 행이 그 경우다. 메시지 ID를 저장하다 실패해도 같은 모양이다.
- Discord가 거절한 카드(403, 500 등)는 표시를 지우고 다음 실행에서 다시 보낸다. 다음 카드는 계속 보낸다. 5xx인데 실제로는 게시된 드문 경우에는 두 번 갈 수 있다.
- 429를 받으면 그 실행을 멈추고 다음 실행까지 기다린다.
- 실패는 `/ready`의 `cards` 항목과 서버 로그에 남고, 준비 상태에는 영향을 주지 않는다.

Discord로 가는 글은 낯선 사람이 쓴 것이라서 다음을 지킨다.

- 멘션을 모두 끈다. 제목과 본문의 마크다운과 링크는 글자로만 보이게 하고 주소의 `https://`를 뗀다.
- 링크는 제목과 `원문 보기` 버튼에 후보의 https 주소만 쓴다. https가 아닌 행은 보내지 않는다. `ref`, `aff`, `via`, `utm_` 같은 추천 파라미터는 지운다.

결과를 볼 때:

```sh
docker exec rapi-postgres-1 psql -U rapi -d rapi -c "SELECT carded_at, card_message_id, band, kind, domain, left(title, 50) AS title FROM discount_candidates WHERE carded_at IS NOT NULL ORDER BY carded_at DESC LIMIT 20"
```

보냈는지 알 수 없는 행을 볼 때:

```sh
docker exec rapi-postgres-1 psql -U rapi -d rapi -c "SELECT id, carded_at, left(title, 60) AS title FROM discount_candidates WHERE carded_at IS NOT NULL AND card_message_id IS NULL"
```

채널에 카드가 없는 것을 확인했으면 그 행의 `carded_at`을 지워 다시 보낸다.

```sh
docker exec rapi-postgres-1 psql -U rapi -d rapi -c "UPDATE discount_candidates SET carded_at = NULL WHERE id = '행 ID' AND card_message_id IS NULL"
```

## 승인 버튼 (0.0.6)

0.0.6부터 보내는 검토 카드에 [게시]와 [버리기]가 붙는다. 그 전에 보낸 카드는 버튼 없이 그대로 둔다.

```sh
DISCOUNT_PUBLIC_CHANNEL_ID=공개_채널_ID
```

이 값과 [`/ai-할인-알림`, `/새-서비스-알림`](#알림-채널) 설정이 모두 없으면 버튼은 이유를 알려 주고 아무것도 바꾸지 않으며, 봇은 그대로 뜬다. 봇에게 공개 채널의 보기, 메시지 보내기, 링크 첨부 권한이 있어야 한다. `.env`를 바꾸면 봇을 다시 시작해야 한다.

소유자는 `DISCORD_ALLOWED_USER_IDS`와 `DISCORD_SUPERADMIN_USER_IDS`에 있는 사람이다. 권한 규칙에서 최고 권한으로 치는 두 목록을 그대로 쓴다. 누를 때마다 Discord가 서명한 사용자 ID와 채널을 확인하므로, 다른 사람이나 다른 채널에서 온 요청은 본인에게만 보이는 거절 메시지를 받고 아무것도 바뀌지 않는다. 버튼 ID에는 행 ID만 들어 있고 나머지는 매번 DB에서 다시 읽는다.

- [게시]를 누르면 마감일 입력창이 열린다. 제목이나 근거에서 찾은 날짜를 미리 채운다. 끝을 뜻하는 표현(`until`, `through`, `까지` 등)이 붙은 날짜를 먼저 고르고, 없으면 처음 나온 날짜를 쓴다. 틀릴 수 있으니 소유자가 고치거나 지우고 확정한다. 비워 두면 마감일을 표시하지 않는다.
- 입력창을 제출하면 검토 카드와 같은 형식으로 공개 채널에 한 건 보낸다. 승인 버튼은 없다. 검토 메시지에서는 승인 버튼이 사라지고 결과가 적히며, `원문 보기`는 남는다.
- 공개 채널에는 최근 1시간에 5장까지 보낸다. 넘으면 언제 다시 누르면 되는지 알려 주고 후보는 그대로 둔다. 버리기는 세지 않는다.
- `band`가 `red`인 행은 카드가 나간 뒤 빨강이 되었어도 게시되지 않는다. 버릴 수는 있다.

중복을 막는 방식:

- 보내기 전에 `status`를 `new`에서 `published`로 바꾸고 `decided_at`을 적는다. 그래서 두 번 누르거나 탭 두 개에서 제출해도 한 번만 간다. 보낸 뒤 `public_message_id`를 적는다.
- Discord가 거절하면(403, 429 등) `new`로 되돌리고 소유자에게 알린다. 다시 누를 수 있다.
- Discord 응답을 받지 못했거나 5xx를 받으면 갔는지 알 수 없다. 표시를 유지하고 소유자에게 알린다. 다시 보내지 않는다. 검토 카드와 달리 5xx도 되돌리지 않는 것은 공개 채널에 같은 글이 두 번 가는 쪽이 더 나쁘기 때문이다.
- 보내는 도중 봇이 죽어도 같은 모양이 된다. `published`인데 `public_message_id`가 없는 행이다.

결과를 볼 때:

```sh
docker exec rapi-postgres-1 psql -U rapi -d rapi -c "SELECT status, decided_at, public_message_id, band, domain, left(title, 50) AS title FROM discount_candidates WHERE status <> 'new' ORDER BY decided_at DESC LIMIT 20"
```

보냈는지 알 수 없는 행을 볼 때:

```sh
docker exec rapi-postgres-1 psql -U rapi -d rapi -c "SELECT id, decided_at, left(title, 60) AS title FROM discount_candidates WHERE status = 'published' AND public_message_id IS NULL"
```

공개 채널에 카드가 없는 것을 확인했으면 그 행을 되돌린다. 검토 메시지의 버튼은 이미 사라졌으니, 다시 내보내려면 `carded_at`도 지워 검토 카드를 새로 받는다.

```sh
docker exec rapi-postgres-1 psql -U rapi -d rapi -c "UPDATE discount_candidates SET status = 'new', decided_at = NULL, carded_at = NULL, card_message_id = NULL WHERE id = '행 ID' AND status = 'published' AND public_message_id IS NULL"
```

## 제보 (0.0.7)

허용된 서버에 있는 사람은 누구나 `/제보`로 링크를 보낼 수 있다. 봇은 Gateway 없이 HTTP 상호작용만 받으므로 채널 메시지를 읽지 못한다. 그래서 링크를 채널에 던지는 대신 명령으로 받는다.

| 옵션 | 값 |
| --- | --- |
| `링크` | 필수. `https` 공개 주소 |
| `종류` | `할인`(기본), `새 서비스`, `문제` |
| `메모` | 선택. 200자까지 |

명령은 다른 명령과 같은 방식으로 등록한다([서버별 기능](#서버별-기능-009) 참고). 홈 서버가 아닌 서버에서는 `/기능`으로 켜야 쓸 수 있다. 허용 서버 목록과 `DISCORD_ALLOWED_CHANNEL_IDS`도 다른 명령처럼 적용된다. 라피 역할은 없어도 되고, DM에서는 받지 않는다.

받을 때 지키는 것:

- 링크를 열지 않고 저장만 한 뒤 본인에게만 보이는 답을 바로 준다. 답에 링크나 메모를 되풀이하지 않는다.
- `https`이고 `isPublicUrl`을 통과하는 주소만 받는다. 계정 정보, 추천 파라미터, `#` 뒤를 지우고 파라미터 순서를 맞춘 주소로 중복을 가른다.
- 주소, 도메인, 제보자 ID, 메모만 저장한다.
- 한 사람당 최근 1시간에 5건까지 받는다. 두 종류를 합쳐 세고, 이미 받은 링크는 세지 않는다.

### 할인, 새 서비스

`route`가 `report`인 후보가 된다. 10분마다 도는 카드 작업이 먼저 제보 후보를 검증하고(한 번에 20건, 나머지는 다음 실행) 이어서 카드를 보내므로 약 10분 안에 검토 채널에 온다. 페이지는 후보 도메인의 첫 화면만 `publicFetch`로 읽는다.

- 제목은 도메인이고 근거는 비어 있다. 도메인 이름과 메모는 색, 가격, 태그를 정하는 데 쓰지 않는다.
- 할인 문구 필터를 건너뛴다. 사람이 골라 보낸 것이기 때문이다. 빨강, 미확인 제외와 시간당 5장 제한은 그대로다.
- 메모는 검토 카드에만 글자로 보인다. [게시]로 나가는 카드에는 넣지 않는다.

### 문제

`problem_reports`에만 저장한다. 후보가 되지 않고, 자동으로 색을 바꾸지 않으며, 공개 채널로 나가지 않는다. 다음 카드 작업에서 검토 채널로 도메인, 링크, 메모, 제보자가 적힌 카드가 온다. 다른 카드보다 먼저 보내고, 채널의 시간당 5장에 함께 센다. 같은 링크로 아직 닫히지 않은 제보가 있으면 새로 만들지 않는다.

버튼은 승인 버튼과 같이 소유자가 검토 채널에서 눌렀을 때만 동작한다.

- [빨강으로 정함]: 그 도메인의 모든 행을 `band = 'red'`로 바꾸고 결정, 결정한 사람을 제보 행에 적는다. 하위 도메인은 포함하지 않는다. 나중에 찾은 같은 도메인 후보도 검증할 때 빨강이 된다. 이미 공개 채널에 나간 글은 지우지 않고, 몇 건인지 알려 준다.
- [문제 없음]: 제보만 닫는다. 같은 링크를 나중에 다시 제보할 수 있다.

`DISCOUNT_REVIEW_CHANNEL_ID`가 없으면 제보는 저장하고 제보자에게 아직 전달되지 않는다고 답한다. 값을 넣으면 쌓인 카드가 나간다.

결과를 볼 때:

```sh
docker exec rapi-postgres-1 psql -U rapi -d rapi -c "SELECT first_seen_at, kind, band, carded_at, reporter_id, url, memo FROM discount_candidates WHERE route = 'report' ORDER BY first_seen_at DESC LIMIT 20"
docker exec rapi-postgres-1 psql -U rapi -d rapi -c "SELECT reported_at, domain, reporter_id, carded_at, decision, decided_by, decided_at, url, memo FROM problem_reports ORDER BY reported_at DESC LIMIT 20"
```

보냈는지 알 수 없는 문제 카드는 `carded_at`만 있고 `card_message_id`가 없는 행이다. 채널에 없는 것을 확인했으면 표시를 지워 다시 보낸다.

```sh
docker exec rapi-postgres-1 psql -U rapi -d rapi -c "UPDATE problem_reports SET carded_at = NULL WHERE id = '행 ID' AND card_message_id IS NULL AND decision IS NULL"
```

되돌리면(`packages/adapters/postgres/rollbacks/0006_reports.sql`) `problem_reports`와 제보 후보 행이 지워진다. 이미 빨강이 된 다른 행은 그대로다.

## 외부 계정 연결 (0.0.11)

사람마다 다른 서비스의 자기 계정을 라피에 연결한다. 지금은 GitHub만 된다. 연결은 기능과 따로 있다. 스타 알림 같은 기능은 그 사람의 연결을 빌려 쓰고 토큰을 직접 두지 않는다. 구조는 [구조 문서](architecture.md)에 있다.

- 승인된 서버에서 `/연결 추가 서비스:GitHub`. 15분짜리 승인 링크를 준다. GitHub에는 권한(scope)을 하나도 요청하지 않아서 공개 정보만 읽을 수 있고, 비공개 저장소나 쓰기 권한은 없다. 링크의 `state`에 서비스, Discord ID, 링크를 시작한 기능, 만료 시각이 서명돼 있어 다른 사람이나 다른 서비스 것으로 바꿀 수 없다.
- 승인하면 서비스가 `https://<공개주소>/connect/<서비스>/callback`(GitHub는 `/connect/github/callback`)으로 돌려보낸다. 봇은 `state`를 확인하고, 코드를 토큰으로 바꾸고, 그 토큰이 누구 계정인지 서비스에 물어본다. 그래서 남의 계정으로 연결할 수 없다. 토큰은 `WEBHOOK_ENCRYPTION_KEY`로 암호화해(AES-256-GCM) `user_connections`에 둔다. 사람과 서비스마다 하나다. 다른 계정으로 다시 연결하면 앞 계정의 권한은 서비스 쪽에서 회수한다.
- `/연결 보기`: 연결한 서비스와 계정. `/연결 끊기 서비스:GitHub`: 서비스 쪽 권한을 회수하고(GitHub는 `DELETE /applications/{client_id}/grant`) 토큰을 지운다. 그 연결을 쓰던 기능은 멈춘다. 회수에 실패하면 서비스 설정에서 직접 지우라고 알린다.
- 서버 안에서만 쓸 수 있다. `/기능`으로 끄는 기능이 아니다.

GitHub OAuth 앱 등록(운영자가 한 번):

1. GitHub → Settings → Developer settings → OAuth Apps → New OAuth App.
2. Homepage URL은 `RAPI_PUBLIC_BASE_URL`, Authorization callback URL은 그 뒤에 `/connect/github/callback`을 붙인 것(예: `https://rapi.justn.me/connect/github/callback`).
3. Client ID와, Generate a new client secret으로 만든 비밀값을 VM의 `.env`에 넣고 봇을 다시 시작한다. 비밀값은 채팅이나 Git에 남기지 않는다.

```sh
GITHUB_OAUTH_CLIENT_ID=...
GITHUB_OAUTH_CLIENT_SECRET=...
```

둘은 함께 있어야 하고 `RAPI_PUBLIC_BASE_URL`과 `WEBHOOK_ENCRYPTION_KEY`도 필요하다. 없으면 `/연결 추가`는 아직 설정되지 않았다고만 답하고, 운영자 본인의 스타 알림은 그대로 간다. 공개 게이트웨이(`ops/gateway/run.mjs`)는 `GET /connect/<서비스>/callback`을 통과시킨다. 이 파일은 배포에 포함되지 않으므로 VM에 복사하고 `rapi-public-gateway`를 다시 시작한다.

새 서비스를 붙일 때는 `CONNECTION_PROVIDERS`(application)에 이름을 넣고, 그 서비스의 OAuth를 `OAuthGateway` 포트로 구현해(adapters) `apps/bot/src/run.ts`의 `connections.providers`에 꽂는다. 명령, 콜백 주소, 게이트웨이, 저장, 회수는 손대지 않아도 된다.

## 운영자 대시보드

소유자가 홈 서버에서 `/대시보드`를 하면 요약과 24시간짜리 서명 링크를 받는다. 링크(`/dashboard`, `apps/bot/src/dashboard-page.ts`)는 작업별 성공과 실패, 수집원, 할인 후보, 이번 달 모델 사용량, 서버, 스타 알림 수를 보여 주고 아무것도 바꾸지 않는다. 링크가 유효해도 소유자가 아니면 열리지 않는다. 작업 상태는 봇 프로세스 메모리에 있어 재시작하면 `아직 안 돌았어요`로 돌아간다. `ops/model-prices.json`에 없는 모델은 비용이 0으로 쌓여 `가격 모름`으로 표시한다.

## 소개와 개인정보 페이지

`GET /`는 소개와 초대 링크, `GET /privacy`는 개인정보 안내다(`apps/bot/src/site-page.ts`). `/help`는 전체 명령어 목록이고(`apps/bot/src/help-page.ts`), `/도움말`이 주는 사람별 서명 링크(7일)로 열면 건의 입력칸이 나온다. 건의는 DB에 저장하지 않고 제보 검토 채널로 바로 보낸다. 한 사람당 시간당 5건이고, 이 제한은 메모리에만 있어 재시작하면 초기화된다. 저장하는 정보가 바뀌면 안내도 같이 고친다. 초대 링크의 권한은 카드를 보내는 데 필요한 채널 보기, 메시지 보내기, 링크 첨부뿐이다. `/서버구성`을 켜는 서버는 권한을 따로 줘야 한다. 공개 게이트웨이(`ops/gateway/run.mjs`)가 이 주소들을 통과시키므로, 이 파일이 바뀌면 VM에 복사하고 `rapi-public-gateway`를 다시 시작한다.

## 스타 리마인드 (0.0.8)

잊고 있던 GitHub 스타와 새로 파낸 저장소를 매일 아침 그 사람의 DM으로 보낸다. 새 릴리즈 알림이 아니다. 스타는 취향이 드러나므로 채널에는 보내지 않는다.

누구나 쓸 수 있다(0.0.11 스타 4차부터). 각자 자기 GitHub 계정을 연결하고(위 "외부 계정 연결"), 그 연결의 토큰으로만 그 사람의 스타를 읽는다. 운영자 토큰으로 남의 스타를 읽지 않는다:

- 승인된 서버에서 `/스타 켜기`. GitHub를 이미 연결했으면 바로 켜고 첫 DM을 보낸다. 연결이 없으면 GitHub 연결 링크를 주고, 그 링크로 연결을 마치면 바로 켠다. DM이 막혀 있으면(Discord 403) 멈춤으로 두고, DM을 허용한 뒤 `/스타 켜기`를 다시 하라고 알린다.
- 매일 읽기, 디깅, 취향 이웃, 검색 모두 그 사람의 토큰으로 한다. 사용 한도도 사람마다 따로다(시간당 5000번). GitHub가 401을 주면 그 사람이 권한을 거둔 것이므로 연결을 지우고 멈춤으로 둔다("GitHub 연결이 끊김"). 연결이 없는 사람은 운영자 토큰으로 대신 읽지 않고 멈춘다("GitHub 연결이 필요함").
- `/연결 끊기`로 GitHub 연결을 끊어도 멈춤("GitHub 연결이 끊김")이 되고, 다시 연결하면 이어서 받는다.
- `/스타 관심사`: 7일짜리 관심사 페이지 링크. `/스타 보기`: 받고 있는지와 멈춘 이유. `/스타 끄기`: DM을 끄고 그 사람의 스타, 관심사, 👍/👎, 보낸 기록, 취향 이웃을 모두 지운다. GitHub 연결은 남는다.
- 다른 GitHub 계정으로 다시 연결하면 그 사람의 스타와 취향 이웃만 지우고, 관심사, 👍/👎, 보낸 기록은 남긴다(같은 날 두 번 가지 않고, 본 것도 다시 안 나온다).
- 서버 안에서만 켤 수 있다. 봇이 DM을 보내려면 같은 서버에 있어야 하기 때문이다. 서버마다 `/기능`으로 끌 수 있지만 기본은 켜짐이다. 끄면 그 서버에서 `/스타`만 안 되고, 이미 켠 사람의 DM은 계속 간다.
- 최대 500명. 10분마다 도는 한 번에 네 명까지 디깅하고(한 명에 20초, 요청 100번쯤), 나머지는 다음 차례로 넘긴다. 그래서 사람이 많으면 09:00 이후 차례로 간다.
- 사람마다 행이 따로 있다(`user_id`): `github_stars`, `star_reminder_days`, `star_suggestions`, `star_neighbors`, `star_interests`, `star_votes`. 받는 사람 목록은 `star_subscribers`이고, 여기에는 토큰이 없다(토큰은 `user_connections`).

운영자 설정:

```sh
STAR_REMINDER_GITHUB_USER=GitHub_로그인
DISCORD_SUPERADMIN_USER_IDS=소유자_ID
```

둘 다 있으면 시작할 때 소유자(`DISCORD_SUPERADMIN_USER_IDS`의 첫 번째 ID)에게 이 로그인으로 스타 알림을 켜 둔다. 소유자만 연결 없이 배포의 `GITHUB_READ_TOKEN`으로 읽는다. 소유자가 `/연결 추가`로 GitHub를 연결했으면 그쪽(본인 토큰)이 이긴다. 0021 이전에 쌓인 스타와 기록은 시작할 때 소유자에게 넘긴다. 둘 다 없어도 다른 사람은 `/스타 켜기`로 쓸 수 있다. 로그인 형식이 틀리면 다른 설정처럼 봇이 시작하지 않는다.

`GITHUB_READ_TOKEN`은 있으면 쓰고 없어도 된다. 스타는 공개 API로 읽는다.

언제 도는가:

- 봇이 시작할 때와 그 뒤 10분마다 확인한다. 연결한 사람마다, 한국 시간 09:00이 지났고 그 사람에게 오늘 보낸 기록이 없을 때만 일한다. 멈춘 사람은 건너뛴다. 그래서 09:00에서 10분 안에 오고, 09:00 넘어서 재시작하면 바로 온다.
- 그때 스타 목록을 하루 한 번 읽고 보낸다. 오래된 스타부터 100개씩 최대 10쪽(요청 10번, 1000개)까지 읽는다. 재시작하면 아직 못 보낸 날에 한해 한 번 더 읽을 수 있다.
- 다 읽었을 때만 목록에서 사라진 스타를 지운 것으로 표시한다(`unstarred_at`). 1000개를 넘으면 표시하지 않고, 넘는 최신 스타는 저장하지 않는다. 다시 스타를 누르면 기록을 이어 간다.
- 읽기에 실패하면 저장된 목록은 그대로 두고 그 목록으로 보낸다. 빈 답도 실패로 친다. 저장된 것이 없으면 다음 날이나 재시작 때 다시 읽는다. 실패는 `/ready`의 `stars` 항목과 서버 로그에 남고, 준비 상태에는 영향을 주지 않는다. 항목은 다음 확인에서 지워지므로 지난 실패는 서버 로그에서 본다.

무엇을 고르는가:

- 스타를 누른 지 30일이 넘었고 최근 180일 안에 보낸 적이 없는 저장소만 고른다. 보관된 저장소와 스타를 지운 저장소는 뺀다.
- 매일 잊은 스타 하나와, 한 번도 보지 않은 새 저장소 하나를 보낸다.
  - 잊은 스타: 관심사를 골라 두었으면 관심사와 가장 잘 맞는 다섯 개 중 하나다. 분야·topic이 가장 크게 반영되고(2배), 언어·형태·규모·활동·나이·만든 쪽·라이선스는 1배다. 별로로 고른 것이 있으면 점수가 내려간다. 분야·topic·언어·형태 중 하나는 맞아야 하며, 규모나 라이선스만 맞는 것은 고르지 않는다. 관심사가 없거나 맞는 것이 없으면 보낸 지 가장 오래된 순서(안 보낸 것 먼저, 그다음 오래된 스타)로 20개를 추려 그 안에서 무작위로 고른다.
  - 새 저장소: 먼저 디깅한다. 아래에서 실패하거나 찾은 것이 없을 때만 관심사 검색으로 넘어간다.
- 디깅(`digTrails`, `followNeighbors`, `rankDug`, `pickDug`):
  - 씨앗 세 개를 가중치 무작위로 고른다. 👍한 저장소(최근 10개)가 3, 관심사와 가장 잘 맞는 스타 12개가 2, 가장 최근에 누른 스타 12개가 1이다. 별 20 미만이나 3만 초과는 씨앗으로 쓰지 않는다. 최근 30일 안에 👎 받은 것을 낸 씨앗은 무게가 절반이다. 관심사가 없어도 최근 스타로 돈다.
  - 씨앗마다 그 저장소를 쓰는 사람을 최대 12명 모은다. 최근 이슈·PR을 올린 사람, 최근 fork한 사람, 토큰이 허용하면 최근 stargazer를 번갈아 넣는다. 지금 쓰는 fine-grained 토큰은 stargazer 목록이 403이라, 한 번 막히면 그날은 다시 묻지 않는다. 봇과 씨앗 주인은 뺀다.
  - 그 사람들이 최근 누른 스타 100개, 씨앗 주인의 다른 저장소, 씨앗 기여자 두 명의 저장소를 읽는다. 스타를 읽은 사람이 4명보다 적은 씨앗은 씨앗 주인이 팔로우하는 사람 4명의 저장소도 읽는다. 씨앗 하나에 GitHub 요청이 20–25개쯤이고, 실패한 요청은 그 부분만 비운다.
  - 취향 이웃: 디깅하다 만난 사람 중 내 스타와 3개 이상 겹치는 사람을 `star_neighbors`에 남긴다. 매일 한 번도 안 따라간 사람부터(그다음 오래전에 따라간 사람, 많이 겹치는 사람) 세 명의 스타를 세 페이지(300개)까지 읽는다. 최근 30일 안에 그 사람에게서 나온 것이 👎를 받았으면 쉬게 한다. 요청은 하루 9개 더 든다.
  - 사람 점수: `0.2 + 1.8 × min(1, ((겹친 스타 + 1) / (그 사람 스타 + 20)) / 0.15)`. 스타가 적은 사람은 0쪽으로 줄어든다. 스타를 많이 누르는 사람은 `√(스타 수 / 30)`으로 나누고, fork로 만난 사람은 0.6배, 내가 👎한 저장소를 하나 누른 사람은 0.75배, 둘 이상이면 0.5배다. 90일보다 오래된 스타는 0.6배, 취향 이웃의 스타는 0.8배다.
  - 길 점수: 씨앗 주인의 다른 저장소 1.5점, 기여자 저장소 1점, 팔로우하는 사람의 저장소 0.8점, 씨앗 두 개 이상에서 닿으면 하나마다 0.75점. 여기에 별 수로 곱하고(★100–3천이 1, 그보다 적거나 유명할수록 작아짐), 관심사 점수의 절반을 더한다.
  - 보증: 내 스타와 2개 이상 겹치는 사람 두 명, 또는 그런 사람 한 명과 다른 사람이나 다른 길, 또는 6개 이상 겹치는 취향 이웃 한 명이 있어야 한다. 그런 사람 없이 만든 사람·기여자·팔로우 길로만 닿은 것은 분야·topic·언어·형태 중 하나가 관심사와 맞아야 한다(규모나 라이선스만 맞는 것은 안 된다).
  - 빼는 것: 내 스타, 전에 보낸 것, 👍/👎한 것, 내 저장소, 관심사 점수가 음수인 것, 최근 14일 안에 보낸 것과 같은 주인, 최근 30일 안에 👎한 저장소의 주인, 별 10 미만이나 5만 초과, 2년 넘게 안 바뀐 것, 설명 없는 것, 개인 홈페이지·블로그·dotfiles·프로필 저장소.
  - 고르기: 후보마다 가장 크게 기여한 길(같이 누른 사람·취향 이웃·만든 사람·기여자·팔로우)을 붙인다. 길마다 전에 보낸 것의 👍/👎로 `Beta(1+👍, 1+👎)`에서 한 번씩 뽑아 가장 큰 길을 고른다(톰슨 샘플링). 그 길의 최고 점수가 그날 1등의 40%보다 낮으면 뽑기에 넣지 않는다. 고른 길 안에서 씨앗마다 하나씩, 위에서 다섯 개 중 하나를 무작위로 고른다. 보낸 것에는 길과 씨앗을 남긴다(`star_suggestions.trail_kind`, `trail_seed`).
  - 카드에 "찾은 길"(예: `oil-ui 쓰는 사람 4명이 스타 누름 (모두 내 스타와 많이 겹침)`, `취향 이웃 0xroylee의 스타`, `skullet 만든 사람의 다른 저장소`)과 맞은 관심사가 붙는다.
- 관심사 검색: 관심으로 고른 topic과 분야(분야마다 정해 둔 GitHub topic)를 최대 세 번 검색한다. 검색에는 관심 언어와 관심 규모(없으면 별 50–5만)를 넣고, 최근 90일 안에 바뀐 것만 찾는다. 내 스타, 전에 보낸 것, 👍/👎를 누른 것은 빼고 가장 잘 맞는 하나를 고른다.
- 새 저장소를 못 찾으면 잊은 스타를 1개나 2개 보낸다. 고를 것이 없으면 보내지 않는다.
- 하루 한 메시지에 카드와 저장소 링크 버튼을 함께 담는다. 할인 카드의 "한 메시지에 한 건"은 여기에 적용하지 않는다. 관심사로 고른 카드에는 어느 관심사와 맞았는지 한 줄이 붙는다.
- 고르기, 디깅, 검색은 하루 한 번만 한다. 보내기가 실패해 다시 보낼 때는 같은 것을 보낸다(재시작하면 다시 고른다).

관심사 페이지와 👍/👎:

- 메시지 아래에 저장소마다 👍/👎 버튼과 "관심사 고르기" 링크 버튼이 붙는다. 링크는 `RAPI_PUBLIC_BASE_URL`과 `WEBHOOK_ENCRYPTION_KEY`가 둘 다 있을 때만 붙는다.
- 링크(`/stars?t=…`)는 `WEBHOOK_ENCRYPTION_KEY`에서 만든 키로 소유자 ID와 만료 시각을 서명한 것이고, 7일 동안 열린다. 만료되면 다음 날 DM의 새 링크를 쓴다. 공개 게이트웨이는 `GET /stars`, `GET /stars/data`, `POST /stars/interests`만 봇으로 넘기고, 셋 다 서명을 확인한다.
- 페이지는 저장된 스타에서 분야(140여 개 분류. 넓은 분야와 그 안의 잘게 쪼갠 분야가 함께 붙는다), 언어, 형태, 규모, 활동, 나이, 만든 쪽, 만든 곳(스타 두 개 이상인 계정), 라이선스, GitHub topic(스타 두 개 이상에 달린 것)을 뽑아 보여 준다. 누를 때마다 관심 → 별로 → 무관으로 바뀌고, 저장하면 `star_interests`에 남는다.
- 👍/👎는 소유자가 누른 것만 센다. 그 저장소의 관심사 항목마다 ±0.25씩 더하고(합쳐서 -1에서 1 사이), 👎한 저장소는 다시 보내지 않는다. 같은 저장소를 다시 누르면 앞의 것을 바꾼다(`star_votes`).
- topic, 최근 수정일, 만든 날, 만든 쪽, 라이선스는 다음 날 스타를 읽을 때 채워진다. 그 전에는 분야·언어·규모로만 고른다.

중복을 막는 방식:

- 보내기 전에 `star_reminder_days`에 그날 행을 만들고 `last_reminded_at`과 `reminded_count`를 올린다. 그래서 하루에 다시 시작해도 더 보내지 않는다.
- Discord가 거절하면(403, 429 등) 행과 표시를 되돌리고 10분 뒤 다시 보낸다. 403은 그 사람이 DM을 막은 것이라 멈춤으로 두고(`star_subscribers.paused_at`), 다시 연결할 때까지 보내지 않는다.
- Discord 응답을 받지 못했거나 5xx를 받으면 갔는지 알 수 없으므로 되돌리지 않는다. 그날 것은 빠질 수 있지만 두 번 가지는 않는다. 보내는 도중 봇이 죽어도 같다. `message_id`가 없는 행이 그 경우다.

설명과 저장소 이름은 낯선 사람이 쓴 글이라 멘션을 끄고 마크다운과 링크를 글자로만 보이게 한다. 설명은 300자로 잘라 저장한다.

결과를 볼 때:

```sh
docker exec rapi-postgres-1 psql -U rapi -d rapi -c "SELECT user_id, github_login, subscribed_at, paused_at, paused_reason FROM star_subscribers ORDER BY subscribed_at"
docker exec rapi-postgres-1 psql -U rapi -d rapi -c "SELECT user_id, day, claimed_at, message_id, repos FROM star_reminder_days ORDER BY day DESC, user_id LIMIT 20"
docker exec rapi-postgres-1 psql -U rapi -d rapi -c "SELECT user_id, count(*), count(unstarred_at) AS unstarred, count(last_reminded_at) AS reminded, max(last_reminded_at) FROM github_stars GROUP BY user_id"
```

오늘 것을 다시 받아 볼 때(09:00 이후에만 나간다). 이미 보낸 스타는 표시가 남아 있어 다른 스타가 온다.

```sh
docker exec rapi-postgres-1 psql -U rapi -d rapi -c "DELETE FROM star_reminder_days WHERE day = (now() AT TIME ZONE 'Asia/Seoul')::date"
sudo systemctl restart rapi-bot
```

관심사와 👍/👎를 볼 때:

```sh
docker exec rapi-postgres-1 psql -U rapi -d rapi -c "SELECT user_id, jsonb_object_keys(facets) AS facet FROM star_interests"
docker exec rapi-postgres-1 psql -U rapi -d rapi -c "SELECT full_name, vote, voted_at FROM star_votes ORDER BY voted_at DESC LIMIT 20"
docker exec rapi-postgres-1 psql -U rapi -d rapi -c "SELECT full_name, trail_kind, trail_seed, suggested_at FROM star_suggestions ORDER BY suggested_at DESC LIMIT 20"
docker exec rapi-postgres-1 psql -U rapi -d rapi -c "SELECT login, shared, found_from, followed_at FROM star_neighbors ORDER BY shared DESC LIMIT 20"
```

되돌리면(`packages/adapters/postgres/rollbacks/0007_star_reminders.sql`) 저장한 스타와 보낸 기록이 지워진다. `0019_star_interests.sql`을 되돌리면 관심사, 👍/👎, 보낸 새 저장소 기록과 스타의 topic 등 추가 정보가 지워지고, 고르기는 예전 방식으로 돌아간다. `0021_star_owners.sql`을 되돌리면 맨 처음 연결된 사람(소유자) 것만 남기고 다른 사람의 스타와 기록, 받는 사람 목록이 지워진다. 0021을 되돌린 채로는 이 기능의 코드가 돌지 않으므로 앞 릴리즈로 함께 되돌린다. `0020_star_digging.sql`을 되돌리면 취향 이웃과, 보낸 것이 어느 길로 왔는지가 지워진다. 디깅은 그날 만난 사람만으로 돌고, 👍/👎는 길을 고르는 데 쓰이지 않는다.

## 서버별 기능 (0.0.9)

서버마다 켠 기능만 동작한다. 홈 서버는 언제나 전부 켜져 있어서 지금까지와 같다. 홈 서버는 `DISCORD_HOME_GUILD_ID`, 없으면 `COMMUNITY_GUILD_ID`, 없으면 `DISCORD_ALLOWED_GUILD_IDS`의 첫 번째 서버다.

| 기능 | 값 | 포함하는 것 | 기본값 |
| --- | --- | --- | --- |
| 상태 | `status` | `/상태`, `/수집원`. 읽기만 하고 운영자만 쓸 수 있다 | 켜짐 |
| 제보 | `report` | `/제보` | 꺼짐 |
| 스타 알림 | `stars` | `/스타`. 각자의 DM으로 간다 | 켜짐 |
| 서버 구성 | `server_config` | `/서버구성`, 적용 버튼, 인증 버튼 | 꺼짐 |
| 소식 카드 | `curation` | AI 블로그, 무료 토큰 채널로 나가는 카드 | 꺼짐 |

할인 카드와 승인 버튼은 소유자 채널과 DM으로 가므로 이 목록에 없다. `COMMUNITY_GUILD_ID` 서버에는 소식 카드가 스위치와 상관없이 나간다.

바꾸는 방법은 해당 서버에서 쓰는 `/기능` 하나다.

```text
/기능 보기
/기능 켜기 기능:제보
/기능 끄기 기능:제보
```

- 소유자(`DISCORD_ALLOWED_USER_IDS`, `DISCORD_SUPERADMIN_USER_IDS`)만 쓸 수 있다. 승인 버튼과 같은 기준이다. 그 서버의 관리자라도 이번 버전에서는 바꿀 수 없다.
- 홈 서버는 바꿀 수 없고 보기만 된다.
- 바꾸면 다음 상호작용부터 적용된다. 캐시가 없다.
- 설정은 `discord_guild_features`에 저장한다. 기능 행이 없는 서버는 위 기본값을 따른다.

꺼진 기능은 명령이 등록되어 있거나 예전 버튼을 눌러도 본인에게만 보이는 안내만 받고 아무 일도 하지 않는다. 설정을 읽지 못하면 켜진 것으로 치지 않고 다시 시도하라고 답한다. 홈 서버는 설정을 읽지 않는다.

`DISCORD_ALLOWED_CHANNEL_IDS`를 쓰면 다른 서버의 채널도 그 목록에 있어야 `/상태`, `/제보`, `/서버구성`이 동작한다. `/기능`과 `/서버`는 이 목록을 보지 않는다.

업그레이드하면 홈 서버가 아닌 허용 서버는 기본값으로 시작한다. 이미 쓰던 서버는 `/기능 켜기`로 다시 켠다.

### 명령 등록

`.env`에 `REGISTER_DISCORD_COMMANDS=true`를 넣고 봇을 다시 시작하면 허용된 모든 서버(`DISCORD_ALLOWED_GUILD_IDS`, 승인된 서버, 홈 서버)에 명령을 등록한다. 전체 명령에는 `/서버신청` 하나만 등록한다. 예전에 전체 명령으로 등록한 것이 있으면 이때 덮어써서 지워진다.

- 서버마다 따로 등록하므로 한 곳이 실패해도 나머지는 계속한다. 실패는 서버 로그에 `command registration:`으로 남는다.
- 시작을 막지 않는다. 봇은 등록이 끝나기를 기다리지 않고 뜬다.
- 초대할 때 `applications.commands` 권한을 받지 않은 서버는 403으로 실패한다. 그 권한으로 다시 초대한 뒤 재시작한다.
- 승인한 서버는 승인할 때 바로 등록된다. 실패하면 재시작 때나 `/서버 승인`을 다시 실행할 때 다시 시도한다.

`npm run discord:register-commands`도 같은 일을 하고, 실패가 있으면 0이 아닌 코드로 끝난다.

결과를 볼 때:

```sh
docker exec rapi-postgres-1 psql -U rapi -d rapi -c "SELECT guild_id, feature, enabled, updated_by, updated_at FROM discord_guild_features ORDER BY guild_id, feature"
journalctl -u rapi-bot --since "10 minutes ago" | grep "command registration"
```

되돌리면(`packages/adapters/postgres/rollbacks/0008_guild_features.sql`) 저장한 설정이 지워진다. 이전 버전은 서버별 기능을 보지 않으므로 다른 서버에서도 전부 동작한다.

## 알림 채널

`.env`를 고치지 않고 서버 안에서 알림마다 정한다. 바꾸면 다음 카드부터 적용되고 재시작은 필요 없다.

```text
/ai-할인-알림 켜기 채널:#할인
/새-서비스-알림 켜기
/라피-업데이트-알림 끄기
/검토-알림 켜기 종류:검토: 제보 채널:#제보
```

채널을 비우면 명령을 친 채널로 정한다. `/검토-알림`은 홈 서버에만 등록되어 다른 서버에서는 보이지 않는다. 네 명령 모두 `켜기`, `끄기`, `보기`가 있다.

| 명령                  | 쓸 수 있는 사람                        | 가는 것                       |
| --------------------- | -------------------------------------- | ----------------------------- |
| `/ai-할인-알림`       | 승인된 서버의 서버 관리 권한자, 소유자 | [게시]한 할인 카드            |
| `/새-서비스-알림`     | 승인된 서버의 서버 관리 권한자, 소유자 | [게시]한 새 서비스 카드       |
| `/라피-업데이트-알림` | 승인된 서버의 서버 관리 권한자, 소유자 | 라피 새 릴리즈 소식           |
| `/검토-알림`          | 소유자, 홈 서버에서만                  | 게시 전 검토 카드와 제보 카드 |

- 켤 때 그 채널에 안내 메시지를 한 건 보낸다. 보내지 못하면 저장하지 않는다. 봇에게 보기, 메시지 보내기, 링크 첨부 권한이 있어야 한다.
- 켠 서버만 받는다. 승인이 풀리거나 차단된 서버에는 보내지 않는다.
- [게시]한 카드는 그 알림을 켠 모든 서버로 간다. 일부가 실패해도 나머지는 보내고, 실패한 곳은 소유자에게 알리며 다시 보내지 않는다. 전부 확실히 거절됐을 때만 후보가 되돌아간다.
- 홈 서버가 할인이나 새 서비스 채널을 정하기 전에는 `DISCOUNT_PUBLIC_CHANNEL_ID`로 간다. 검토 알림은 따로 정하지 않은 종류만 `DISCOUNT_REVIEW_CHANNEL_ID`로 간다. 라피 업데이트는 이 값으로 가지 않는다.
- 검토 채널은 소유자만 보는 곳으로 정한다. 버튼은 지금 정한 검토 채널과 `DISCOUNT_REVIEW_CHANNEL_ID` 모두에서 소유자에게 동작한다. 이미 보낸 카드는 옮기지 않는다.
- 시간당 5장 제한은 카드 수 기준이며 서버 수만큼 늘지 않는다.
- 공개된 카드를 나중에 빨강으로 정해도 다른 서버의 메시지는 봇이 지우지 않는다.

라피 업데이트는 10분마다 이 저장소의 최신 릴리즈를 읽고, 새 릴리즈면 소유자 승인 없이 바로 보낸다. 릴리즈 노트의 첫 문단과 `## 바뀐 것`만 보내고 `## 확인한 것`, `## 남은 것`은 보내지 않는다. 그러니 릴리즈 노트의 그 두 부분에는 다른 서버에 보여도 되는 말만 쓴다. 처음 돌 때는 현재 릴리즈를 기억만 하고, 실패한 채널에 다시 보내지 않는다.

## 새 서버 승인 (0.0.10)

라피는 링크로 누구나 추가할 수 있는 공개 봇이다. 승인되지 않은 서버는 `/서버신청` 말고는 아무것도 할 수 없다. HTTP 상호작용만 쓰므로 봇이 서버에 들어간 것을 알 수 없고, 요청이 와야 안다.

허용 기준은 `DISCORD_ALLOWED_GUILD_IDS`, 홈 서버, `discord_guilds`에서 승인한 서버 중 하나다.

- 세 가지 모두 없으면 모든 서버를 거절한다. 예전에는 전부 열렸다. 서버 로그에 `guilds: no home or allowed guild configured`가 남는다.
- 소유자 버튼도 같은 문을 지나므로 `DISCOUNT_REVIEW_CHANNEL_ID` 채널은 허용된 서버에 있어야 한다. 그렇지 않으면 [게시], [승인]도 거절된다.
- 허용 여부를 읽지 못하면 거절하고 다시 시도하라고 답한다.

### 요청

서버 관리 권한(또는 관리자)이 있는 사람이 `/서버신청 사유:...`를 쓴다. 권한은 서명된 요청의 값으로 확인한다. 사유는 선택이고 100자로 자른다.

| 서버 상태 | 답 | 소유자에게 카드 |
| --- | --- | --- |
| 처음 요청 | 요청을 보냈다고 알림 | 감 |
| 이미 요청 중 | 기다려 달라고 알림 | 다시 안 감 |
| 차단됨 | 요청을 받지 않는다고 알림 | 안 감 |
| 차단을 풀고 7일이 안 지남 | 다시 요청할 수 있는 날짜를 알림 | 안 감 |
| 이미 허용됨 | 이미 승인됐다고 알림 | 안 감 |

DM에서는 요청이 만들어지지 않는다.

### 카드와 버튼

카드는 `DISCOUNT_REVIEW_CHANNEL_ID`로 간다. 소유자만 보는 채널로 정해 둔 곳이고, `OPERATIONS_CHANNEL_ID`는 운영 알림용이라 쓰지 않는다. 값이 없으면 요청은 저장만 되고 값을 넣으면 나간다.

- 요청이 들어오면 바로 보내고, 그 순간 다른 카드를 보내는 중이면 10분 타이머가 보낸다.
- 할인, 문제 제보 카드와 같은 시간당 5장 제한을 쓴다. 많이 들어오면 다음 시간으로 넘어간다.
- 서버 이름은 보낼 때 Discord에 물어본다. 상호작용에는 이름이 없다. 봇이 그 서버에 없으면(`applications.commands`로만 추가) 이름을 모른다고 표시한다.
- 서버 이름과 사유는 낯선 사람이 쓴 글이라 서식 문자를 이스케이프하고 링크 주소의 `https://`를 지우고, 멘션은 꺼서 보낸다.

버튼은 누를 때마다 소유자인지와 검토 채널인지를 확인하고, 요청이 열려 있을 때만 상태를 바꾼다. 두 번 눌러도 두 번째는 이미 처리했다고만 답한다.

- [승인]: 바로 허용되고 그 서버에 명령을 등록한다. 기능은 [서버별 기능](#서버별-기능-009)의 기본값으로 시작한다.
- [차단]: 그 서버의 요청을 모두 거절한다.

등록에 실패해도 승인은 유지되고 카드에 그렇게 적힌다. 봇을 `applications.commands` 권한으로 다시 초대한 뒤 `/서버 승인`을 다시 실행한다.

### 소유자 명령

허용된 서버 어디서든 쓴다. 소유자(`DISCORD_ALLOWED_USER_IDS`, `DISCORD_SUPERADMIN_USER_IDS`)만 쓸 수 있다. 서버 ID는 카드에 있다.

```text
/서버 승인 서버:<서버 ID>
/서버 차단 서버:<서버 ID>
/서버 해제 서버:<서버 ID>
```

- `승인`: 요청이 없거나 차단된 서버도 승인하고 명령을 등록한다. 이미 승인한 서버에 쓰면 등록만 다시 한다.
- `차단`: 이미 승인한 서버도 막고 그 서버의 명령을 지운다. 명령을 지우지 못해도 차단은 유지된다. `/서버신청`은 전체 명령이라 그 서버에 계속 보이지만 거절만 한다.
- `해제`: 차단만 푼다. 승인된 것이 아니며 7일 뒤부터 다시 요청할 수 있다.
- `DISCORD_ALLOWED_GUILD_IDS`와 홈 서버는 차단할 수 없다. `.env`를 바꿔야 한다.

허용 목록은 15초 캐시하지만 위 결정은 캐시를 바로 비운다. `psql`로 행을 직접 바꾸면 최대 15초 뒤에 반영된다.

### 결과를 볼 때

```sh
docker exec rapi-postgres-1 psql -U rapi -d rapi -c "SELECT guild_id, name, status, requester_id, reason, requested_at, decided_at, carded_at, card_message_id FROM discord_guilds ORDER BY requested_at DESC"
```

카드를 보내다 응답을 받지 못하면 중복을 피하려고 다시 보내지 않는다. `status='pending'`인데 `carded_at`이 있고 `card_message_id`가 비어 있으면 그 경우다. 채널에 카드가 없으면 `/서버 승인`이나 `/서버 차단`으로 바로 정하거나, 아래처럼 되돌리면 다음 타이머가 다시 보낸다.

```sh
docker exec rapi-postgres-1 psql -U rapi -d rapi -c "UPDATE discord_guilds SET carded_at = NULL WHERE guild_id = '<서버 ID>' AND status = 'pending' AND card_message_id IS NULL"
```

되돌리면(`packages/adapters/postgres/rollbacks/0009_guild_requests.sql`) 요청자, 사유, 카드 기록이 지워지고 차단은 `rejected`로 남는다. 이전 버전은 이 값을 허용으로 치지 않으므로 계속 거절된다. 이전 버전은 할인 버튼을 다른 서버에서 막지 않고, 서버가 하나도 설정되지 않으면 모두 연다.

## 카드 템플릿

봇이 Discord로 보내는 카드(할인, 검토, 문제 제보, 서버 승인 요청, 스타 알림, 라피 업데이트)와 채널 연결 테스트 글의 문구, 줄 순서, 색은 `packages/domain/src/discounts/card-templates.json`에 있다. 코드는 값만 채운다.

- `{이름}`은 코드가 채우는 값이다. 낯선 사람의 글은 이미 마크다운이 막힌 채로 들어온다.
- `[[ ... ]]` 안에 빈 값이 하나라도 있으면 그 부분이 빠지고, 비어 버린 줄도 빠진다.
- 색은 `colors`의 이름이나 `#rrggbb`로 쓴다. 할인 카드의 `{띠}`는 `green`, `yellow`, `warn` 중 하나가 된다.
- `routeLabels`는 할인 카드의 `{출처}`다. 새 경로를 만들면 여기에도 이름을 넣는다(테스트가 확인한다).

고칠 때는 `npm run card-studio`를 실행하고 `http://127.0.0.1:4700`을 연다. 실제 카드 함수에 예시 데이터를 넣어 Discord 모양으로 보여 주고, 고치는 대로 미리보기가 바뀐다. 저장하면 위 JSON 파일에 써진다. 이 컴퓨터에서만 열리고, 봇에는 커밋해서 배포해야 반영된다.

## 놓친 딜 세기

출처를 더 늘릴지는 놓친 딜로 정한다. 직접 본 딜을 Rapi가 안 보냈으면 `/제보`로 넣는다. VM에서 아래를 돌리면 제보마다 다른 경로가 같은 도메인을 먼저 찾았는지 보여 준다.

```sh
cd /home/justn/rapi-releases/current && node --env-file=/home/justn/rapi/.env --import tsx scripts/missed-deals.ts 2026-11-07
```

`먼저 찾음(경로)`은 Rapi가 이미 알던 딜이고, `놓침`은 어느 경로도 몰랐던 딜이다. 도메인으로만 맞춰 보므로, 게시판 글처럼 도메인이 없는 후보와 겹친 제보는 놓침으로 나온다.
