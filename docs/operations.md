# 운영, 권한, 보안

## 1. 필요한 외부 자원

### 필수

- Linux VM 한 대와 SSH 관리 권한
- 공식 Discord application/bot과 대상 서버 또는 DM 사용 권한
- 전용 GitHub 계정과 필요한 저장소·조직 권한
- 전용 이메일 계정의 SMTP 또는 발송 API 권한
- 요약·분류에 사용할 모델 공급자 인증

### 공개 블로그 운영 시

- 도메인과 DNS 변경 권한
- 정적 호스팅 또는 VM reverse proxy/TLS 구성 권한
- 블로그 Git 저장소와 배포 인증

### 출처에 따라 선택

- GitHub App 또는 fine-grained token
- 웹훅 발신자별 shared secret
- S3 호환 object storage

## 2. 최초 사용자 작업

다음은 계정 소유자만 수행할 수 있어 사용자가 최초 한 번 제공하거나 승인해야
한다.

1. Discord Developer Portal에서 application과 bot을 만들고 필요한 서버에
   초대한다.
2. VM SSH 공개키를 등록하고 배포 대상 호스트·사용자를 알려준다.
3. GitHub 전용 계정에 필요한 저장소·조직 권한을 부여한다.
4. 이메일 계정에서 앱 비밀번호 또는 제한된 발송 자격 증명을 발급한다.
5. 모델 공급자의 프로젝트와 비용 한도를 설정한다.
6. 블로그 공개 시 도메인 DNS 레코드 변경을 승인한다.

토큰 원문은 Discord나 Git 이력에 보내지 않는다. 가능하면 VM에서 직접 입력하거나
비밀 관리 도구로 주입한다.

## 3. 최소 권한 표

| 주체 | 허용 권한 | 기본 금지 |
| --- | --- | --- |
| Discord bot | 서버 구성 적용을 위한 Administrator, 명령·역할·채널·웹훅 관리 | 사용자 계정 로그인, 애플리케이션 SUPERADMIN 승격 |
| GitHub 수집 | metadata/content read, issues/PR read | 저장소 write |
| GitHub 실행 | 작업별 승인된 repo write/PR 범위 | 조직 관리자, 무관 저장소 접근 |
| 이메일 | 지정 발신자 주소의 send | mailbox 전체 읽기 |
| 블로그 배포 | 지정 repo/배포 대상 write | 다른 사이트·도메인 변경 |

GitHub 읽기와 쓰기 자격 증명은 분리한다. 평상시 수집 프로세스는 쓰기 토큰에
접근하지 않는다. GitHub App을 사용할 때는 [공식 권한 문서](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)를
기준으로 필요한 webhook과 API별 최소 권한을 선택한다.

## 4. 비밀값 목록

구현 시 실제 변수명은 확정하되 범주는 다음과 같다.

- Discord bot token, application/public key, allowed user/guild/channel IDs
- database URL과 backup 자격 증명
- GitHub App key 또는 token
- SMTP/API endpoint, username, app password, sender address
- 모델 공급자 API key와 프로젝트 ID
- 웹훅 source secret
- 블로그 배포 key와 object storage 자격 증명

저장소에는 값이 없는 `.env.example`만 둔다. 운영 비밀은 읽기 권한이 제한된
환경 파일, systemd credential, 또는 별도 secret manager에 둔다. 로그와 오류
보고서에는 토큰, Authorization header, 쿠키, 원문 credential을 남기지 않는다.

## 5. VM 기준 구성

초기 단일 VM 배치는 다음 프로세스로 충분하다.

- `rapi-bot`: Discord Gateway와 명령 처리
- `rapi-worker`: 수집, 분류·요약, 발송 worker
- `rapi-scheduler`: cron/예약 작업 enqueue
- `rapi-blog`: 정적 빌드 또는 웹 서버
- PostgreSQL: 같은 VM 또는 관리형 서비스
- reverse proxy: HTTPS와 공개 webhook/blog endpoint

프로세스는 전용 OS 사용자로 실행하고 자동 재시작, resource limit, health check를
설정한다. DB와 공개 웹 포트를 제외한 내부 서비스는 외부에 노출하지 않는다.

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

## 6. 배포 절차

릴리스 후보를 서비스 전환 없이 준비할 때는 깨끗한 후보 checkout에서 전체 SHA와
기존 스테이징 루트 디렉터리를 명시한다. `deploy-revision.sh`는 Git archive로
비밀값 없는 revision을 별도 디렉터리에 풀고, 새 `npm ci`와 check, proxy,
격리 E2E·restart·restore, audit를 모두 통과한 경우에만
`release-manifest.json`을 쓴다. 실패한 스테이징 디렉터리는 조사할 수 있도록 남긴다.
이 단계는 서비스를 교체하거나 worker를 재시작하지 않는다.

```bash
RAPI_RELEASE_SHA="$(git rev-parse HEAD)" \
RAPI_RELEASE_ROOT=/absolute/existing/staging-directory \
  ./scripts/deploy-revision.sh
```

manifest에는 원본·빌드 파일의 digest와 migration 목록도 들어간다.
`scripts/switch-release.mjs`는 후보와 이전 artifact를 검증하고, 현재 실행 중인
서비스만 중지·전환·재시작한다. `/ready`의 기동 시점 revision과 readiness가
일치해야 전환을 인정하며 실패하면 이전 artifact로 돌아가 같은 검사를 수행한다.
이미 중지된 worker는 이 절차나 터널 구성으로 자동 재시작하지 않는다.

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

monitor는 중지된 worker의 경고를 계속 보고하므로, 배포 전환에서는 monitor의
`/health`와 기동 revision을 검사한다. 나머지 활성 애플리케이션은 `/ready`를
검사한다. monitor 경고를 지우거나 중지된 worker를 켜서 검사를 통과시키지 않는다.

```bash
RAPI_SWITCH_APPROVED=true \
RAPI_CURRENT_RELEASE=/absolute/releases/current \
RAPI_CANDIDATE_RELEASE=/absolute/releases/candidate-directory \
RAPI_RELEASE_SHA=full-40-character-candidate-sha \
RAPI_SWITCH_RECEIPT=/absolute/evidence/switch-receipt.json \
RAPI_SERVICE_ENV_FILE=/home/justn/rapi/.env \
RAPI_SWITCH_SERVICES=bot,chat,monitor,worker \
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
ChatOps의 코드 변경은 체크아웃에 직접 커밋하지 않고 브랜치와 PR로 main에 들어온다.

공개 커뮤니티 `1545832299671847013`의 준비된 구성은
`config/discord-community.yaml`과
`docs/evidence/community-plan-20260928.json`이다. 기존 ADMIN 역할을 채택하고
기존 채널을 삭제하지 않는다. 봇 관리자 권한·역할 순서와 공개 실행기 전용
로그인을 확보한 뒤, 배포된 `DiscordLayoutManager.preview/apply`로 fresh plan을
확인·적용한다. 저장된 snapshot은 사전 검토용이며 그대로 재사용하는 승인 토큰이 아니다.

역할·채널 적용 후 공개 대화 접근 설정을 독립적으로 준비할 수 있다. 이 명령은
RSS·이메일·GitHub 등록을 요구하지 않으며, 별도 실행기 활성화까지 자동 수행하지 않는다.

```bash
COMMUNITY_GUILD_ID=1545832299671847013 \
  node --env-file=.env --import tsx scripts/configure-public-community.ts --preview

# 운영 승인 후 역할/채널 ID를 환경 파일에 반영한다.
RAPI_COMMUNITY_APPROVED=true COMMUNITY_GUILD_ID=1545832299671847013 \
  node --env-file=.env --import tsx scripts/configure-public-community.ts --apply
```

공개 실행기 전용 로그인은 설치된 전용 계정에서 진행한다. 장치 승인 단계는
소유자가 직접 수행한다. 승인된 실제 질문이 성공한 뒤 공개 기능을 활성화하고
USER/ADMIN/SUPERADMIN의 허용·거부 흐름을 각각 확인한다.

```bash
sudo -u rapi-public env HOME=/var/lib/rapi-public \
  CODEX_HOME=/var/lib/rapi-public/codex \
  /opt/rapi-public-agent/codex login --device-auth
```

1. CI가 typecheck, lint, unit/integration test, migration 검사를 수행한다.
2. 불변 revision 또는 image tag를 만든다.
3. DB 백업과 migration dry-run 결과를 확인한다.
4. worker 소비를 일시 중지하고 migration을 적용한다.
5. 앱을 교체하고 health/readiness를 확인한다.
6. Discord 명령, 수집, 테스트 발송, 블로그 smoke를 실행한다.
7. 실패하면 직전 revision으로 앱을 되돌리고 호환 가능한 복구 절차를 실행한다.

배포 성공은 프로세스가 떠 있는 것만으로 판단하지 않는다. 실제 Discord 명령과
수집→저장→발송 경로의 smoke가 필요하다.

## 7. 백업과 복구

- PostgreSQL 자동 일일 백업과 보존 기간 설정
- 대형 원본 저장소의 versioning 또는 snapshot
- 비밀값을 제외한 운영 설정과 migration은 Git으로 관리
- 월 1회 별도 위치에 복구해 무결성 검사
- 복구 목표 시점(RPO)과 목표 시간(RTO)은 실제 데이터 증가량을 본 뒤 확정

백업 생성 로그만으로 복구 가능성을 증명하지 않는다. 빈 환경에서 복원하고 주요
레코드와 앱 기동을 확인해야 한다.

## 8. 모니터링과 알림

Discord 운영 채널 또는 DM으로 아래 상황을 알린다.

- 수집원이 연속 실패하거나 예상 주기보다 지연됨
- 큐 적체와 worker 중단
- DB 용량, VM 디스크, 메모리 임계치 초과
- 이메일·Discord 발송 실패율 증가
- 모델 비용 한도 접근 또는 초과
- 승인 대기 작업 만료
- 백업 또는 복구 점검 실패

알림 자체의 폭주를 막기 위해 동일 원인의 집계, cooldown, 복구 알림을 적용한다.

## 9. 승인 정책 초안

### 자동 실행 가능

- 허용된 출처의 읽기 전용 수집
- 이미 승인된 구독에 따른 DM/이메일 발송
- 비공개 MDX 초안 생성
- 조회, 검색, 상태 확인

### 최초 정책 승인 후 자동화 가능

- 사용자가 출처, 카테고리, 템플릿, 공개 범위, 기간을 한정해 승인한 정책과 정확히
  일치하는 예약 블로그 게시
- 지정 저장소의 이슈·프로젝트 정리
- 실패한 멱등 작업의 제한적 재시도

### 매번 명시적 승인

- 코드 commit/push, PR 생성·병합, 배포
- 승인된 자동 게시 정책 밖의 최초 공개 또는 모든 공개 범위 확대
- 새로운 수신자에게 이메일 발송
- 유료 자원 생성, 비용 한도 상향
- 자격 증명·권한·DNS 변경
- 데이터의 영구 삭제

승인은 대상, 동작, 유효 기간, 최대 비용 또는 변경 범위를 포함한다. 일부 동작에
대한 승인을 다른 동작으로 확대 해석하지 않는다.

자동 게시 정책은 만료 시각을 가져야 하며, 새 출처·새 템플릿·새 카테고리는 기존
정책에 자동 포함하지 않는다. 개별 글을 승인한 것은 이후 글의 포괄 승인으로
간주하지 않는다.

## 10. 운영 인수 체크리스트

- [ ] Discord bot이 허용된 사용자와 채널에서만 응답한다.
- [ ] self-bot 또는 개인 계정 토큰이 없다.
- [ ] 저장소와 빌드 산출물에 비밀값이 없다.
- [ ] GitHub 읽기/쓰기 권한이 분리됐다.
- [ ] 테스트 이메일과 실제 발송 대상이 분리됐다.
- [ ] HTTPS와 webhook signature 검증이 적용됐다.
- [ ] 재시작 후 queue와 수집 cursor가 복구된다.
- [ ] 같은 이벤트와 발송을 재시도해도 중복되지 않는다.
- [ ] DB 백업을 별도 환경에서 실제 복원했다.
- [ ] 공개 MDX 빌드에서 비공개 콘텐츠가 제외된다.
- [ ] ChatOps 실행마다 시도와 결과 증거가 기록된다.

## 11. 구현된 운영 명령

```bash
npm run bootstrap       # 설치, DB, migration, 전체 검증
npm run db:migrate      # 미적용 migration 적용
npm run backup          # backups/ 아래 권한 0600 SQL dump 생성
npm run restore:smoke   # 격리된 임시 DB로 실제 복구 검증
npm run restart:smoke   # PostgreSQL 재시작 전후 핵심 count 검증
npm run start:bot       # Discord interaction/webhook 서버
npm run start:worker    # GitHub/RSS/HTML 목록 수집과 배치 발송 worker
npm run start:monitor   # 독립 health 감시와 장애·복구 알림
npm run db:migrate      # 로컬 또는 Supabase 지정 DB migration
npm run backup          # 원자적 custom-format dump와 최근 7개 보존
```

서비스 프로세스는 reverse proxy 뒤에서 실행하며 `/health`를 readiness 확인에 쓴다.
Docker volume `rapi-postgres`는 애플리케이션 컨테이너 교체와 분리해 보존한다.

## 자연어 ChatOps 운영 정책 (D-008)

허용된 소유자의 명확한 자연어 변경·배포 요청은 그 자체로 실행 권한이며 반복
승인을 요구하지 않는다. 이는 위 승인 초안의 자연어 ChatOps 경로를 대체한다.
`/작업`·`/승인`은 기존 동작을 유지한다. 배포 시 기존 `npm run db:migrate`가
0004를 적용한 뒤 기존 `rapi-chat.service`를 사용한다. 이번 구현 작업에서는
운영 전환은 [커뮤니티 운영 전환](operations-webhooks.md)의 drain, 백업, readiness
rollback 절차를 따른다.

`npm run test:e2e`는 `compose.test.yaml`의 임시 PostgreSQL을 임의 로컬 포트에
기동하고 **rapi_test만** 사용한다. migration 재적용도 검사하며 EXIT trap으로
컨테이너·네트워크를 정리한다. 운영 Compose 또는 DB에는 연결하지 않는다.
테스트를 직접 실행할 때도 정확히 `rapi_test` 이름이 아니면 거부한다.
상태 조회, 실제 취소, interrupted 복구와 알려진 한계는
[운영 상세](chatops-capabilities.md)를 참고한다.

기본 실행 모델은 `gpt-5.6-sol`이다. 명시적인 `스파크로 …`는 Spark를 그대로 선택하므로 계정 지원 여부를 확인해야 한다. ChatOps 요청의 `아스트라로 …`,
`…, 모델: gpt-6-astra`로 실행별 모델을 지정한다.
선택 결과는 ChatOps 실행 행에 저장한다.

## senpi 하니스 (선택)

senpi는 소유자 실행 전용 두 번째 하니스다(동작은 [ChatOps 기능](chatops-capabilities.md)
참고). 고정 버전은 `ops/harness-versions.json`이다.

```bash
# 1. VM에서 설치: 릴리스 tarball을 받아 sha256 확인 뒤 /opt/rapi-senpi/<버전>에
#    풀고 /usr/local/bin/senpi를 연결한다. 전용 설정(텔레메트리 끔, 프로젝트 신뢰
#    never)을 SENPI_HOME(기본 /var/lib/rapi/senpi)/agent/settings.json에 쓴다.
#    다시 실행해도 안전하다. gh 로그인이 필요하다.
scripts/install-senpi.sh

# 2. 소유자가 서비스 계정(justn)으로 공급자 로그인(브라우저/기기 인증이 필요하다).
PI_CODING_AGENT_DIR=/var/lib/rapi/senpi/agent senpi   # 대화창에서 /login

# 3. 같은 요청을 Codex와 `센파이로 …`로 몇 번 나란히 돌려 본 뒤에만 기본값을 바꾼다.
#    .env에 CHATOPS_HARNESS=senpi 를 쓰고 rapi-chat을 재시작한다.
```

`curl -s localhost:3100/ready`의 `senpi` 항목이 `ok`면 바이너리와 설정 파일이 있다는
뜻일 뿐 로그인 상태는 아니다. 로그인 전에는 `센파이로`가 실패하므로 2번을 먼저 한다. 인증 오류처럼 보이는 실패에는 ChatOps가
"senpi 로그인이 필요할 수 있어요"를 덧붙인다.
`SENPI_BIN`, `SENPI_HOME`은 기본 경로를 바꿀 때만 설정한다.

## 하네스 버전 갱신 (선택)

`HARNESS_UPDATES_ENABLED=true`로 켜면 워커가 6시간마다 `ops/harness-versions.json`의
`repo` 항목(예: senpi → `code-yeongyu/senpi`)의 최신 GitHub 릴리스를 확인한다. 새
버전이면 임시 디렉터리에서 자산을 받아 SHA256SUMS를 대조하고 `--version`, 격리 설정
유지, 고정 스모크 프롬프트를 검사한 뒤 SUPERADMIN 전원에게 `반영 추천`/`보류 추천`
DM을 보낸다. 버튼은 `[반영]` `[건너뛰기]` `[나중에]`(24시간 뒤 재알림)이고 소유자만
누를 수 있다. 자동으로 바뀌는 것은 없다.

소음을 줄이는 규칙: 새 버전이 연달아 나오면 가장 최신 것만 알리고 이전 것은 `superseded`로
건너뛴다. 같은 하네스는 마지막 알림 뒤 7일이 지나야 다시 알린다(그동안 더 새 버전이 나오면
그것으로 바뀐다). VM에 하네스 로그인 정보가 없어 평가 자체가 불가능하면(`No API key`)
`보류 추천` DM·PR 없이 `environment_unavailable`로 건너뛴다.

- `[반영]`: VM에 로그인된 `gh`로 `HARNESS_UPDATES_REPO`를 임시 clone해 브랜치
  `chore/harness-<이름>-<버전>`에 고정값을 바꾸고 PR을 연다. 새 자격 증명은 없다.
- PR이 머지되면 DM에 `[되돌리기]`가 오고, 누르면 이전 고정값 복원 PR을 연다.
- 머지·배포 뒤 설치는 수동이다: `scripts/install-senpi.sh` (sudo가 필요해 배포
  스크립트에는 연결하지 않았다).
- 모든 단계는 `harness_updates`, `harness_update_events`에 남는다.
- 스모크 프롬프트는 `SENPI_HOME/agent`의 로그인 파일(설정 제외)을 임시 디렉터리에
  복사해 실행하고 끝나면 지운다.
- 워커와 봇 둘 다 같은 환경변수를 읽으므로 워커와 `rapi-bot`을 재시작한다.

## LiteLLM 켜기 (선택)

라피 내부 모델 호출(요약 등)은 `packages/adapters`의 `OpenAiCompatibleModelClient` 하나를
거친다. 이 클라이언트는 LiteLLM, OpenAI, Anthropic의 OpenAI 호환 엔드포인트 어디든
가리킬 수 있고, `MeteredModelClient`가 모든 호출을 `model_usage`에 기록하며 월 상한을
적용한다. `MODEL_API_BASE_URL`과 `MODEL_API_KEY`가 모두 없으면 꺼져 있고(코드는
`null`을 받아 기존 동작을 유지), 배포만으로는 아무것도 바뀌지 않는다.

소유자만 할 수 있는 일:

1. VM에 LiteLLM 설치: `python3 -m venv /opt/rapi-litellm && /opt/rapi-litellm/bin/pip
   install 'litellm[proxy]'`.
2. `ops/litellm/config.example.yaml`을 `/etc/rapi/litellm.yaml`로 복사해 모델 목록을 고른다.
3. `/etc/rapi/litellm.env`(chmod 600)에 `LITELLM_MASTER_KEY`(임의의 긴 값)와 공급자
   키(`OPENAI_API_KEY` 등)를 넣는다. 저장소에는 넣지 않는다.
4. `ops/systemd/rapi-litellm.service.example`을 `/etc/systemd/system/rapi-litellm.service`로
   복사하고 `systemctl enable --now rapi-litellm`. 바인드는 `127.0.0.1:4000`이다.
5. `.env`에 설정하고 워커와 `rapi-bot`을 재시작한다:
   `MODEL_API_BASE_URL=http://127.0.0.1:4000/v1`, `MODEL_API_KEY=<LITELLM_MASTER_KEY>`,
   `MODEL_DEFAULT=rapi-default`, 선택으로 `MODEL_FOR_PUBLIC_QA` 등 기능별 모델과
   `MODEL_MONTHLY_BUDGET_USD`.
6. 요약을 API로 돌리려면 `SUMMARIZER_BACKEND=api`(기본은 `codex`). 이 값은
   위 변수가 모두 있어야 설정 검증을 통과한다.

동작:

- 비용은 LiteLLM의 `x-litellm-response-cost` 헤더를 우선 쓰고, 없으면
  `ops/model-prices.json`의 가격표로 계산한다. 가격표에 없는 모델은 비용 0으로 기록되고
  행의 `note`에 `unknown_price`가 남는다. 가격표 값은 공급자 가격 페이지로 확인한다.
- 상한은 달력 월(Asia/Seoul) 기준이다. 80%에서 SUPERADMIN 전원에게 DM(월 1회), 100%에서
  `archive_qa`·`public_qa`·`chatbot`·`rewrite`를 멈추고 DM(월 1회)한다. `summary`,
  `blog_draft`, `repo_report`는 계속 돈다. DM이 한 명에게도 가지 않으면 다음 호출에서
  다시 시도한다.
- `/사용량`(운영진)과 `/상태`에 이번 달·지난달 기능별 모델 비용이 붙는다.
- 사용량 조회: `SELECT feature, count(*), sum(cost_micro_usd)/1e6 AS usd FROM model_usage
  WHERE at >= date_trunc('month', now() AT TIME ZONE 'Asia/Seoul') GROUP BY 1;`
- 마이그레이션을 먼저 적용한다(`npm run db:migrate`).
- 80%/100% 알림은 월·단계·`MODEL_MONTHLY_BUDGET_USD` 금액별로 한 번씩 간다. 한도를 올리면 같은 달에도 새 한도에서 다시 알린다.

연결 범위: 봇·chat·워커가 각자 같은 방식으로 이 클라이언트를 만들어 블로그 초안(`blog_draft`)과
주간 GitHub 리포트(`repo_report`)에 넘긴다. `MODEL_API_*`가 없으면 초안은 "꺼져 있어요"라고
답하고 리포트는 모델 요약 없이 나간다.

public-agent는 DB·키 접근이 없는 격리 프로세스라 이 클라이언트를 직접 쓰지 않는다.
`PUBLIC_AGENT_BACKEND=api`일 때의 비용은 호출하는 쪽(봇·chat)이 이어 받는다: 질문을 넘기기 전에
같은 `evaluateBudget`으로 이번 달 합계를 확인해 100%이면 "이번 달 한도에 도달했어요"로 답하고,
실행기가 소켓 응답에 실어 보낸 사용량(토큰, 모델, LiteLLM이 준 비용)을 같은 `model_usage`에 기록한다.
비용이 비어 오면 호출하는 쪽의 `ops/model-prices.json`으로 계산한다. `codex` 백엔드는 지금처럼
계량하지 않는다. Codex CLI를 LiteLLM 뒤로 보내는 일(Responses API, `wire_api = "responses"`)은
아직 하지 않았다. chat(ChatOps)은 계속 Codex 구독 로그인으로 실행된다.
## 메일 켜기 (선택)

학습자 호를 메일로도 보내는 채널이다. 0단계 실험의 "메일 의향" 결과가 메일 발송을
가리킬 때만 켠다. 기본은 꺼져 있고, 켜지 않으면 배포해도 아무것도 바뀌지 않는다.
`LEARNER_EXPERIMENT_ENABLED=true`가 먼저 필요하다.

### 소유자가 할 일

1. 발송 업체를 고르고 계정을 만든다: `resend` 또는 `postmark`.
2. 보내는 도메인을 업체에 등록하고 안내하는 DNS 레코드를 넣는다.
   - **SPF**: 업체가 안내하는 `include:`를 도메인의 SPF TXT에 합친다(SPF TXT는 도메인당 하나).
   - **DKIM**: 업체가 주는 CNAME/TXT 레코드를 그대로 추가한다.
   - **DMARC**: `_dmarc.<도메인>` TXT. 처음에는 `v=DMARC1; p=none; rua=mailto:<받을 주소>`로
     시작하고, 리포트에서 SPF/DKIM 정렬이 확인되면 `p=quarantine`으로 올린다.
   - 업체 화면에서 도메인이 "Verified"가 된 것을 확인한 뒤 진행한다.
3. 업체에서 발급한 서버 API 키를 `EMAIL_API_KEY`에 넣는다(채팅·Git에 남기지 않는다).
4. 웹훅을 등록한다. URL은 `https://<RAPI_PUBLIC_BASE_URL의 도메인>/e/webhook/<resend|postmark>`.
   - Resend: 이벤트 `email.bounced`, `email.complained`를 선택하고, 발급된 서명 비밀값
     (`whsec_...`)을 `EMAIL_WEBHOOK_SECRET`에 넣는다. 서명(svix)과 5분 시각 허용 오차를 검증한다.
   - Postmark: 서명을 제공하지 않으므로 웹훅 URL에 Basic 인증을 건다. 임의의 `user:password`를
     만들어 업체 웹훅 설정과 `EMAIL_WEBHOOK_SECRET` 양쪽에 같은 값으로 넣는다. Bounce와
     Spam complaint 웹훅을 켠다. 정기 소식은 Postmark 정책상 Broadcast 스트림이 맞을 수
     있다(코드에서 확인하지 못했다). 그렇다면 스트림을 만들고 ID를 `EMAIL_POSTMARK_STREAM`에
     넣는다(기본 `outbound`).
5. `.env`에 설정한다: `EMAIL_ENABLED=true`, `EMAIL_PROVIDER`, `EMAIL_API_KEY`, `EMAIL_FROM`
   (인증한 도메인의 주소만, 표시 이름 없이), 선택 `EMAIL_REPLY_TO`, `EMAIL_WEBHOOK_SECRET`. 하나라도 빠지면
   봇이 시작하지 않는다.
6. 공개 게이트웨이(`ops/gateway/run.mjs`)가 새 코드로 재시작돼야 `/e/verify/…`,
   `/e/unsub/…`, `/e/webhook/…`가 열린다. 봇을 재시작한다.
7. 확인: 본인 계정으로 학습자 구독 → 구독 확인 메시지의 `[메일로도 받기]`로 주소 등록 →
   확인 메일의 링크 → `[확인]` → 다음 호 발송 후 메일 수신, 맨 아래 `메일 그만 받기` 동작을 본다.

### 동작 요약

- 주소 등록은 디스코드 모달이다. 주소를 저장하고 확인 메일(24시간, 1회용 링크)을 보낸다.
  링크를 열면 확인 버튼이 있는 페이지가 뜨고, 버튼을 눌러야 확인된다(메일 보안 스캐너가
  링크를 미리 열어도 소모되지 않는다).
- 호 발송은 기존 흐름 그대로 소유자가 `[발송]`을 눌렀을 때만 나간다. 그때 확인된 주소를
  가진 구독자에게 메일이 추가로 나간다. 수신자별 결과는 `learner_email_deliveries`에
  남고, 실패는 다시 시도하지 않는다.
- 모든 메일에 `List-Unsubscribe` + `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
  헤더와 본문 하단 수신 거부 링크(`/e/unsub/<토큰>`)가 있다.
- 하드 바운스·스팸 신고는 해당 주소로의 발송을 멈춘다. 소프트 바운스는 5회 누적 시 멈춘다.
- 웹 `/me`(`WEB_ENABLED`와 `EMAIL_ENABLED`가 둘 다 켜졌을 때): 로그인한 사용자가 메일 주소를
  등록·변경·삭제하고 상태(확인 대기, 확인됨, 수신 거부, 발송 불가)를 본다. 주소는 가린 채
  보여 주고, 등록은 디스코드 모달과 같은 서비스(확인 메일, 10분 간격 제한)를 거치며 CSRF 토큰이
  필요하다. 하드 바운스·스팸 신고된 주소는 삭제해도 행이 남아 차단이 유지된다. 게이트웨이는
  `POST /me/email`을 새로 연다.
- 웹 매직 링크 로그인: `verifyEmailToken()`(`@rapi/core`)이 토큰 검증을 제공한다. 웹 로그인은
  Discord OAuth만 쓰므로 메일 링크 로그인은 연결하지 않았다. 필요하면 `login` 목적(purpose)을 추가하고
  `/e/login/<토큰>` 라우트와 게이트웨이 정규식을 더한다.
- 끄려면 `EMAIL_ENABLED=false`로 되돌리고 봇을 재시작한다. 저장된 주소는 남는다
  (`/데이터삭제`와 보존기간 규칙으로 지워진다. `docs/data-lifecycle.md` 참고).

## 결제 (꺼짐)

유료 이용권은 Toss Payments로 결제하도록 만들어 두었고 **꺼진 채로 배포된다**. 사업자 등록(통신판매업 신고)
전에는 아무것도 팔 수 없으므로, `BILLING_ENABLED=false`인 동안은 다음이 모두 참이다.

- `/billing/*`, `/admin/billing`, `POST /billing/webhook/toss`는 전부 404를 돌려준다.
- 가격은 어떤 페이지에도 나오지 않고, `/me`에도 요금제 줄이 없다.
- 기능 확인(`allowsFeature`)은 항상 통과한다. 지금은 어떤 기능도 막지 않는다(`/me` 표시에만 쓴다).

### 모델

- 한 번 결제하면 정해진 기간을 쓰는 **기간권**이다. 자동 갱신은 없다. Toss 정기결제(자동결제·빌링키)는
  별도 계약이 필요해서 만들지 않았다.
- 플랜은 `ops/billing-plans.json`(`BILLING_PLANS_FILE`로 바꿈)에 있다. 기본 플랜 `supporter`의 1,000원은
  테스트용 자리표시이고 실제 가격이 아니다. `priceKrw: 0`인 플랜은 "준비 중"으로만 보이고 살 수 없다.
  결제된 주문이 있는 플랜을 파일에서 지우면 그 주문의 환불·재확인이 막히므로 지우지 말고 `priceKrw: 0`으로 둔다.
- 다시 사면 `max(지금, 만료일)`부터 기간이 이어진다. 환불하면 그 주문이 준 기간만큼 줄고, 남는 기간이 없으면
  이용권이 사라진다.
- 금액은 항상 플랜 파일에서 서버가 정한다. 결제 성공 주소의 `amount`는 저장된 주문 금액과 같을 때만
  승인 요청을 보낸다. 다르면 승인하지 않고 주문을 실패로 닫는다.

### 설정

| 변수 | 뜻 |
| --- | --- |
| `BILLING_ENABLED` | 기본 false. 켜려면 `WEB_ENABLED`, `RAPI_PUBLIC_BASE_URL`, 아래 두 키가 모두 필요하다. |
| `TOSS_CLIENT_KEY`, `TOSS_SECRET_KEY` | Toss 개발자센터의 키. 시크릿 키는 `.env`에만 둔다. |
| `BILLING_LIVE` | 기본 false. false면 `test_`로 시작하지 않는 키는 설정 검증이 거부해서 실수로 실결제가 일어나지 않는다. 사업자 등록 뒤에만 true로 한다. |
| `BILLING_PLANS_FILE` | 플랜 파일 절대 경로(기본 `ops/billing-plans.json`). |

Toss는 계정 없이 테스트 환경에서 쓸 수 있는 문서용 키를 공개한다(위젯 클라이언트 키
`test_gck_docs_Ovk5rk1EwkEbP0W43n07xlzm`, 위젯 시크릿 키 `test_gsk_docs_OaPz8L5KdmQXkzRz3y47BMw6`).
`.env.example` 주석에만 적었고 코드의 기본값은 아니다.

### 테스트 모드로 해 보기

1. `npm run db:migrate`로 `0028`을 적용한다.
2. `.env`에 `WEB_ENABLED=true`(3번 단계가 끝난 상태), `BILLING_ENABLED=true`, 위 문서용 키를 넣고 봇과 게이트웨이를
   재시작한다. `BILLING_LIVE`는 비워 둔다.
3. 로그인 → `/billing` → `[구매하기]`. 결제창 위에 "테스트 결제" 배지가 보여야 한다. 토스 테스트 안내에 따라 카드
   정보를 넣으면 실제 청구는 일어나지 않는다(테스트 키).
4. 성공 화면 → `/me`에 `요금제: 서포터 (YYYY-MM-DD까지)`가 보이는지, 새로고침해도 같은 화면인지 확인한다.
5. SUPERADMIN으로 `/admin/billing` → `[환불]` → 확인. 주문이 "환불됨"이 되고 `/me`가 "무료"로 돌아오는지 본다.
6. 결제창이 비어 있으면 브라우저 콘솔의 CSP 오류를 본다. 결제 페이지만 `js.tosspayments.com`(script),
   `*.tosspayments.com`(frame/connect/img)와 `static.toss.im`(img)을 허용한다. 토스 위젯이 다른 출처를 더 쓰면
   `packages/agent/src/web-billing.ts`의 `TOSS_ALLOW`에 추가한다. 이 허용 목록은 실제 브라우저로 확인하지
   못했다(테스트는 헤더 문자열만 검사한다).

웹훅 URL은 `${RAPI_PUBLIC_BASE_URL}/billing/webhook/toss`다. Toss 일반 결제 웹훅에는 서명이 없어서, 라피는 본문을
힌트로만 쓰고 `paymentKey`로 Toss에 다시 조회한 결과로만 주문을 바꾼다. 조회가 실패하면 503을 돌려 Toss가 다시
보내게 한다. 승인 요청 도중 네트워크가 끊겨 주문이 `pending`으로 남은 경우도 이 웹훅이 정리한다.

### 개인정보 삭제와 거래 기록

`내 정보` 삭제를 확정하면 `billing_entitlements` 행은 지우고, `billing_orders`의 `user_id`는 다른 행위자
참조와 같은 HMAC 가명으로 바꾼다. **주문 기록은 지우지 않는다.** 전자상거래 관련 법령이 대금결제·거래 기록의
보존(통상 5년)을 요구하기 때문이다. 정확한 기간과 범위는 사업자 등록 때 세무·법률 확인을 받아 확정한다.
자동 보존기간 정리는 주문을 건드리지 않는다. 보존기간이 끝난 주문을 지우는 작업은 아직 없다(TODO).

### 사업자 등록 뒤 소유자가 할 일

1. 통신판매업 신고(구매안전서비스 이용확인증이 필요할 수 있다).
2. Toss Payments 가맹 계약을 맺고 라이브 키를 받는다.
3. Toss 개발자센터에서 웹훅 URL(`/billing/webhook/toss`)을 등록하고 `PAYMENT_STATUS_CHANGED` 이벤트를 켠다.
4. 아래 법적 페이지를 먼저 만든다.
5. `.env`에 라이브 키를 넣고 `BILLING_LIVE=true`로 바꾼 뒤 봇을 재시작한다. 먼저 1,000원 같은 최소 금액으로 직접 결제와
   환불을 한 번 해 본다.
6. `ops/billing-plans.json`의 `supporter`를 실제 가격으로 바꾼다(지금 값은 자리표시다).

### 켜기 전에 있어야 할 법적 페이지 (TODO, 문구는 쓰지 않았다)

- [ ] 이용약관
- [ ] 환불·청약철회 정책(디지털 이용권의 철회 제한 안내 포함)
- [ ] 개인정보 처리방침에 결제 정보 항목 추가
- [ ] 푸터의 사업자 정보(상호, 대표자, 사업자등록번호, 통신판매업 신고번호, 주소, 연락처)
- [ ] 결제 화면에 약관·환불 정책 링크

## OMP 제거

2026-10-24부터 코드 실행 경로는 ChatOps(Codex 직접 실행) 하나다. `rapi-omp` 서비스,
`/작업`·`/승인` 슬래시 명령, `/omp/callback`, `OMP_*` 설정은 제거됐다. 기존 task 행은
DB에 남고 보존 정책을 따른다. 배포 뒤 VM에서 한 번 정리한다.

```bash
sudo systemctl stop rapi-omp && sudo systemctl disable rapi-omp
sudo rm -f /etc/systemd/system/rapi-omp.service*
sudo systemctl daemon-reload
npm run discord:register-commands   # 슬래시 명령 재등록: /작업, /승인 제거
```

VM `.env`의 `OMP_*`와 `COMMAND_CODE_API_KEY`는 더 이상 읽지 않으므로 지워도 된다
(남아 있어도 설정 검증은 알 수 없는 키를 무시한다).

## GitHub App 만들기 (선택)

소유자 본인 레포에서 `@rapi`로 일을 시키고(반응형), 매주 월요일 09:00(Asia/Seoul)에 레포
요약을 받는(능동형) 기능이다. 기본은 꺼져 있다. `GITHUB_APP_ENABLED=true`를 쓰기 전에는
봇이 `/github/webhook`을 열지 않고 404로 답한다(게이트웨이는 경로만 전달한다).

### 1. GitHub에서 App 등록 (소유자만 가능)

Settings → Developer settings → GitHub Apps → New GitHub App.

- **Homepage URL**: 아무 주소(레포 주소 등).
- **Webhook URL**: `<RAPI_PUBLIC_BASE_URL>/github/webhook` (Cloudflare Tunnel 뒤의 공개 게이트웨이가
  이 경로만 `POST`로 봇에 전달한다).
- **Webhook secret**: 16자 이상 임의 문자열. `.env`의 `GITHUB_APP_WEBHOOK_SECRET`과 같아야 한다.
- **Repository permissions**: Contents **Read & write**, Pull requests **Read & write**,
  Issues **Read & write**, Metadata **Read-only**, Checks **Read-only**.
- **Subscribe to events**: `Issues`, `Issue comment`, `Pull request review comment`.
- **Where can this GitHub App be installed?**: **Only on this account**.
- 만든 뒤 App ID를 적어 두고 **Generate a private key**로 `.pem`을 받는다.
- **Install App**에서 본인 계정의 **필요한 레포만**(Only select repositories) 선택해 설치한다.

### 2. VM에 비밀값 두기

```bash
# 개인 키: 서비스 계정만 읽도록 (레포 밖, Git에 넣지 않는다)
sudo install -d -m 700 -o justn -g justn /home/justn/secrets
install -m 600 rapi-github-app.pem /home/justn/secrets/rapi-github-app.pem
```

`.env`에 추가하고 `rapi-bot`, `rapi-chat`, `rapi-worker`를 재시작한다.

```bash
GITHUB_APP_ENABLED=true
GITHUB_APP_ID=<App ID>
GITHUB_APP_PRIVATE_KEY_PATH=/home/justn/secrets/rapi-github-app.pem
GITHUB_APP_WEBHOOK_SECRET=<위 웹훅 시크릿>
GITHUB_APP_ALLOWED_OWNERS=<설치 계정 로그인, 쉼표 구분>
GITHUB_APP_OWNER_LOGINS=<@rapi를 부를 수 있는 로그인, 쉼표 구분>
# 선택: 리포트를 레포 이슈에도 남기려면 issue
GITHUB_REPORT_TARGET=dm
```

`DISCORD_SUPERADMIN_USER_IDS`가 필요하다(리포트 DM 수신자). 마이그레이션
마이그레이션을 먼저 적용한다(`npm run db:migrate`).

### 3. 동작과 안전장치

- 웹훅은 `X-Hub-Signature-256`을 상수 시간으로 검증하고 `X-GitHub-Delivery`로 중복을 거른다.
  설치 계정이 `GITHUB_APP_ALLOWED_OWNERS`에 없으면 403이다.
- `@rapi`를 부른 사람이 `GITHUB_APP_OWNER_LOGINS`에 없으면 조용히 무시한다(공개 레포에서 낯선
  사람이 App의 댓글을 유발하지 못하게 답글도 달지 않는다).
- 요청은 Discord와 같은 ChatOps 엔진·같은 실행 기록(`chatops_runs`)으로 처리된다. 수신 즉시 👀
  반응이 붙고 진행·결과가 같은 스레드 댓글로 올라오며 작업 ID가 함께 표시된다. `@rapi 멈춰`로 중단한다.
- 변경 요청은 새 클론에서 실행하고, 하네스에는 토큰이 전달되지 않는다. 라피가 `rapi/<작업ID>`
  브랜치만 푸시하고 PR을 연다. 기본 브랜치에는 푸시하지 않는다(코드에서 거부). 질문은 PR 없이
  댓글로 답한다.
- 설치 토큰은 해당 레포 하나로 한정되고 만료 직전까지만 캐시한다.
- 주간 리포트는 지난 7일의 머지된 PR, 열린 이슈, 검사 실패 PR, 14일 이상 멈춘 PR을 GitHub API로
  모아 SUPERADMIN에게 DM으로 보낸다. 직접 호출하는 모델 요약(`repo_report`)은 `ModelClient`가
  연결돼 있을 때만 붙고, 없거나 예산이 소진돼도 리포트는 그대로 나간다.

### 4. 확인

```bash
# 웹훅 전달: App 설정 → Advanced → Recent Deliveries에서 202(접수) 또는 200(무시/중복)
# 레포 이슈에 "@rapi 이 레포 구조를 설명해줘" 댓글 → 👀 → 답 댓글
```

끄려면 `GITHUB_APP_ENABLED=false`로 되돌리고 서비스를 재시작한다. App 설치 자체를 지우면 GitHub 쪽에서도
토큰이 즉시 무효화된다.

## 기능 켜기 순서

모든 기능은 꺼진 채로 배포되고, 배포만으로는 아무것도 바뀌지 않는다. 아래 순서는 앞 단계가
뒤 단계의 전제인 경우를 따랐다. 단계마다 `.env`를 바꾸고 해당 서비스를 재시작한다. 마이그레이션은
먼저 `npm run db:migrate`로 적용한다.

| 순서 | 플래그 | 필요한 것 | 소유자 작업 | 자세히 |
| --- | --- | --- | --- | --- |
| 1 | `MODEL_API_BASE_URL` + `MODEL_API_KEY` (플래그 없음) | `MODEL_DEFAULT`, 선택 `MODEL_MONTHLY_BUDGET_USD`, 마이그레이션 `0026` | LiteLLM 설치와 공급자 키, 가격표 확인 | [LiteLLM 켜기](#litellm-켜기-선택) |
| 2 | `LEARNER_EXPERIMENT_ENABLED` | `WEBHOOK_ENCRYPTION_KEY`, `RAPI_PUBLIC_BASE_URL`, `DISCORD_SUPERADMIN_USER_IDS`, `0019`, `0027`(재알림) | 없음(Discord 안에서 소유자 승인으로 발송) | `.env.example` |
| 3 | `WEB_ENABLED` | `DISCORD_OAUTH_CLIENT_ID/SECRET`, `RAPI_PUBLIC_BASE_URL`, `WEBHOOK_ENCRYPTION_KEY`, `0021`(구독 폼은 2번이 켜져야 작동) | Discord 개발자 포털에 `${RAPI_PUBLIC_BASE_URL}/auth/discord/callback` redirect 등록, 게이트웨이 재시작 | README, `docs/ux-notes/w1-web.md` |
| 4 | `BLOG_PUBLISH_ENABLED`, `BLOG_DRAFTS_ENABLED` | `DISCORD_SUPERADMIN_USER_IDS`, `0022`, `0027`(상태 전이·재알림), 초안은 1번 | VM의 `gh` 로그인, 블로그 PR 병합, `RAPI_BLOG_WITHDRAWALS_FILE` 쓰기 권한 | `docs/ux-notes/m2-blog.md` |
| 5 | `EMAIL_ENABLED` | 2번, `EMAIL_PROVIDER`, `EMAIL_API_KEY`, `EMAIL_FROM`, `EMAIL_WEBHOOK_SECRET`, `0023` | 발송 도메인 SPF/DKIM/DMARC, 업체 웹훅 등록, 게이트웨이 재시작 | [메일 켜기](#메일-켜기-선택) |
| 6 | `PUBLIC_AGENT_ENABLED` + `PUBLIC_AGENT_BACKEND=api` | 실행기 쪽 `PUBLIC_AGENT_API_KEY/MODEL`(1번과 별개). 월 상한·가격표는 봇 `.env`의 `MODEL_MONTHLY_BUDGET_USD`와 `ops/model-prices.json` | `/etc/rapi-public-agent.env`에 같은 백엔드·키 설정, 배포 뒤 실행기 재시작(안 하면 사용량 기록이 오지 않는다) | 위 LiteLLM 절 |
| 7 | `CHATBOT_ENABLED`, `CHATBOT_L2_ENABLED` | 6번, `0025`, 블로그 색인은 `RAPI_PUBLIC_BASE_URL`(https) | 봇 `.env`와 실행기 env 둘 다 `api`인지 확인 | `docs/ux-notes/q5-chatbot.md` |
| 8 | `GITHUB_APP_ENABLED` | `GITHUB_APP_ID/PRIVATE_KEY_PATH/WEBHOOK_SECRET/ALLOWED_OWNERS/OWNER_LOGINS`, `0024` | GitHub App 등록·설치·웹훅 URL | [GitHub App 만들기](#github-app-만들기-선택) |
| 9 | `HARNESS_UPDATES_ENABLED` | `DISCORD_SUPERADMIN_USER_IDS`, `0020` | VM의 `gh` 로그인, 제안 PR 검토 | [하네스 버전 갱신](#하네스-버전-갱신-선택) |
| 10 | `BILLING_ENABLED` (+ `BILLING_LIVE`) | 3번, `TOSS_CLIENT_KEY`, `TOSS_SECRET_KEY`, `RAPI_PUBLIC_BASE_URL`, `0028`. 사업자 등록 전에는 테스트 키만 | 사업자 등록(통신판매업 신고), Toss 가맹 계약·라이브 키, 웹훅 URL 등록, 법적 페이지, 게이트웨이 재시작 | [결제 (꺼짐)](#결제-꺼짐) |
| 11 | `ARCHIVE_SOURCES_ENABLED`, `CHATBOT_RERANK_ENABLED`, `GRAPH_INDEX_ENABLED`, `CHATBOT_GRAPH_ENABLED`, `BLOG_GUIDE_GRAPH_ENABLED` | 7번, `0031`, `0032`, `MODEL_API_*`, `node scripts/graph-admin.mjs estimate` | 모델 비용(`/비용`), 그래프 `report` | [출처가 붙은 입문 가이드](guide-pipeline.md) |

켜고 나서 한 번씩 확인할 것:

- 1번: `/사용량`(운영진)에 기능별 비용 줄이 보이는지. 새 모델은 가격표에 먼저 넣는다.
- 3번: 로그인 → `/me`, `/archive`. 4번 이후 `/archive`에는 발행된 가이드 글이 학습자 소식과 함께 보이고
  내린 글은 보이지 않는다.
- 5번: `/me`의 "메일 주소" 카드에서 등록 → 확인 메일 → `[확인]`.
- 7번: 챗봇에게 블로그 글을 물어 출처 링크가 나오는지(색인은 5분 단위로 갱신되고, 내린 글은 다음 갱신에서 빠진다).
- 6번은 1번 없이 켤 수 있다. 공개 질문 비용은 `model_usage`에 남지만 `MODEL_MONTHLY_BUDGET_USD`가 없으면
  상한이 없다(기록만).

끄는 순서는 반대다. 플래그를 `false`로 되돌리고 서비스를 재시작하면 된다.

## 소유자 재알림 (U8)

학습자 미리보기를 3시간 동안
결정하지 않으면, 블로그 글이 PR이 열린 채 24시간 `approved`에 머물면 SUPERADMIN에게 DM을 한 번 보낸다(반복 없음).
새 환경 변수는 없다.

## 크롤러 제거 후 정리 (0029)


배포 뒤 VM에서: `rapi-crawler-controller`, `rapi-crawler-browser`, `rapi-crawler-auto-deploy.timer`를 stop·disable하고, `.env`에서 `CRAWLER_*`를 지우고, `rapi-crawler` 저장소를 보관(archive)한다.
그다음 쌓인 응답 스냅샷을 서비스를 멈추지 않고 지운다: `node --env-file=/home/justn/rapi/.env scripts/cleanup-response-snapshots.mjs`(건수 확인) → `--apply` → `VACUUM (ANALYZE) raw_events`. 마이그레이션 안에서 지우면 3 GB 테이블에서 배포 전환이 몇 분 이상 멈춘다(2026-10-25 실제로 13분 중단).

`html` 수집원은 `collection_policy.html`에 `linkPattern`(경로 정규식, 200자 미만), `maxItems`(기본 20), `exclude`(경로 정규식 목록)를 둔다. 추가는 `createSource("html", url, "public", { html: {...} })`로 하며, 현재 관리자 화면(`/수집원`, `/admin/sources`)에는 수집원 추가 기능이 없다(상태 조회만).

## 할인 후보 수집 (0.0.3)

봇이 시작 1분 뒤와 그 뒤 24시간마다 후보를 찾아 `discount_candidates`에 기록만 한다. Discord로 보내지 않는다. 출처 목록은 `config/discount-sources.json`에 있다.

| 경로 (`route`) | 찾는 것 | 출처 |
| --- | --- | --- |
| `changelog` | 할인 (`discount`) | OpenAI, Vercel, Cloudflare, AWS, Anthropic, DeepSeek, APIYI 공식 변경로그. 할인 문구가 있고 30일 안에 나온 항목만 |
| `pull_request` | 새 서비스 (`new_service`) | `anomalyco/models.dev`의 열린 PR 중 provider를 추가하는 것 |
| `code_search` | 새 서비스 (`new_service`) | GitHub 코드 검색. API 주소, 저장소, 파일 링크만 남기고 원문은 저장하지 않음 |

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

어떤 후보를 보내는가:

- `band`가 `green` 또는 `yellow`인 행만 보낸다. `red`와 아직 확인하지 않은 행은 보내지 않는다.
- `new_service`와 [제보](#제보-007)는 모두 보낸다. 다른 `discount`는 `price_check`가 `below_list`이거나 제목이나 근거에 무료나 크레딧이 적힌 행만 보낸다. 약관 변경 소식은 보내지 않는다.
- 게시일이 최근 7일 안인 행을 최신순으로 보낸다. 게시일이 없으면 처음 본 날로 따진다. 처음 수집하면 몇 달 전 변경로그도 오늘 처음 본 행이 되므로, 게시일이 있으면 처음 본 날은 보지 않는다. 더 오래된 행은 보내지 않고 그대로 둔다.
- 최근 1시간에 보낸 카드가 문제 제보 카드까지 합쳐 5장이면 멈추고, 나머지는 다음 실행으로 넘긴다.

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

이 값이나 `DISCOUNT_REVIEW_CHANNEL_ID`가 없으면 버튼은 이유를 알려 주고 아무것도 바꾸지 않으며, 봇은 그대로 뜬다. 봇에게 공개 채널의 보기, 메시지 보내기, 링크 첨부 권한이 있어야 한다. `.env`를 바꾸면 봇을 다시 시작해야 한다.

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

되돌리면(`packages/db/rollbacks/0006_reports.sql`) `problem_reports`와 제보 후보 행이 지워진다. 이미 빨강이 된 다른 행은 그대로다.

## 스타 리마인드 (0.0.8)

잊고 있던 GitHub 스타를 하루 한두 개 소유자 DM으로 보낸다. 새 릴리즈 알림이 아니다. 스타는 취향이 드러나므로 채널에는 보내지 않는다.

```sh
STAR_REMINDER_GITHUB_USER=GitHub_로그인
DISCORD_SUPERADMIN_USER_IDS=소유자_ID
```

받는 사람은 `DISCORD_SUPERADMIN_USER_IDS`의 첫 번째 ID다. 둘 중 하나라도 없으면 아무것도 읽거나 보내지 않고 봇은 그대로 뜬다. 로그인만 있고 받을 사람이 없으면 시작할 때 서버 로그에 한 줄 남긴다. 로그인 형식이 틀리면 다른 설정처럼 봇이 시작하지 않는다. `.env`를 바꾸면 봇을 다시 시작해야 한다. 소유자가 봇과 같은 서버에 있고 그 서버 멤버의 DM을 허용해야 받을 수 있다.

`GITHUB_READ_TOKEN`은 있으면 쓰고 없어도 된다. 스타는 공개 API로 읽는다.

언제 도는가:

- 봇이 시작할 때와 그 뒤 10분마다 확인한다. 한국 시간 09:00이 지났고 오늘 보낸 기록이 없을 때만 일한다. 그래서 09:00에서 10분 안에 오고, 09:00 넘어서 재시작하면 바로 온다.
- 그때 스타 목록을 하루 한 번 읽고 보낸다. 오래된 스타부터 100개씩 최대 10쪽(요청 10번, 1000개)까지 읽는다. 재시작하면 아직 못 보낸 날에 한해 한 번 더 읽을 수 있다.
- 다 읽었을 때만 목록에서 사라진 스타를 지운 것으로 표시한다(`unstarred_at`). 1000개를 넘으면 표시하지 않고, 넘는 최신 스타는 저장하지 않는다. 다시 스타를 누르면 기록을 이어 간다.
- 읽기에 실패하면 저장된 목록은 그대로 두고 그 목록으로 보낸다. 빈 답도 실패로 친다. 저장된 것이 없으면 다음 날이나 재시작 때 다시 읽는다. 실패는 `/ready`의 `stars` 항목과 서버 로그에 남고, 준비 상태에는 영향을 주지 않는다. 항목은 다음 확인에서 지워지므로 지난 실패는 서버 로그에서 본다.

무엇을 고르는가:

- 스타를 누른 지 30일이 넘었고 최근 180일 안에 보낸 적이 없는 저장소만 고른다. 보관된 저장소와 스타를 지운 저장소는 뺀다.
- 보낸 지 가장 오래된 순서(안 보낸 것 먼저, 그다음 오래된 스타)로 20개를 추리고, 그 안에서 무작위로 1개나 2개를 고른다. 고를 것이 없으면 보내지 않는다.
- 하루 한 메시지에 카드와 저장소 링크 버튼을 함께 담는다. 할인 카드의 "한 메시지에 한 건"은 여기에 적용하지 않는다.

중복을 막는 방식:

- 보내기 전에 `star_reminder_days`에 그날 행을 만들고 `last_reminded_at`과 `reminded_count`를 올린다. 그래서 하루에 다시 시작해도 더 보내지 않는다.
- Discord가 거절하면(403, 429 등) 행과 표시를 되돌리고 10분 뒤 다시 보낸다.
- Discord 응답을 받지 못했거나 5xx를 받으면 갔는지 알 수 없으므로 되돌리지 않는다. 그날 것은 빠질 수 있지만 두 번 가지는 않는다. 보내는 도중 봇이 죽어도 같다. `message_id`가 없는 행이 그 경우다.

설명과 저장소 이름은 낯선 사람이 쓴 글이라 멘션을 끄고 마크다운과 링크를 글자로만 보이게 한다. 설명은 300자로 잘라 저장한다.

결과를 볼 때:

```sh
docker exec rapi-postgres-1 psql -U rapi -d rapi -c "SELECT day, claimed_at, message_id, repos FROM star_reminder_days ORDER BY day DESC LIMIT 10"
docker exec rapi-postgres-1 psql -U rapi -d rapi -c "SELECT count(*), count(unstarred_at) AS unstarred, count(last_reminded_at) AS reminded, max(last_reminded_at) FROM github_stars"
```

오늘 것을 다시 받아 볼 때(09:00 이후에만 나간다). 이미 보낸 스타는 표시가 남아 있어 다른 스타가 온다.

```sh
docker exec rapi-postgres-1 psql -U rapi -d rapi -c "DELETE FROM star_reminder_days WHERE day = (now() AT TIME ZONE 'Asia/Seoul')::date"
sudo systemctl restart rapi-bot
```

되돌리면(`packages/db/rollbacks/0007_star_reminders.sql`) 저장한 스타와 보낸 기록이 지워진다.

## 서버별 기능 (0.0.9)

서버마다 켠 기능만 동작한다. 홈 서버는 언제나 전부 켜져 있어서 지금까지와 같다. 홈 서버는 `DISCORD_HOME_GUILD_ID`, 없으면 `COMMUNITY_GUILD_ID`, 없으면 `DISCORD_ALLOWED_GUILD_IDS`의 첫 번째 서버다.

| 기능 | 값 | 포함하는 것 | 기본값 |
| --- | --- | --- | --- |
| 상태 | `status` | `/상태`, `/수집원`. 읽기만 하고 운영자만 쓸 수 있다 | 켜짐 |
| 제보 | `report` | `/제보` | 꺼짐 |
| 서버 구성 | `server_config` | `/서버구성`, 적용 버튼, 인증 버튼 | 꺼짐 |
| 소식 카드 | `curation` | AI 블로그, 무료 토큰 채널로 나가는 카드 | 꺼짐 |

할인 카드, 승인 버튼, 스타 리마인드는 소유자 채널과 DM으로 가므로 이 목록에 없다. `COMMUNITY_GUILD_ID` 서버에는 소식 카드가 스위치와 상관없이 나간다.

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

되돌리면(`packages/db/rollbacks/0008_guild_features.sql`) 저장한 설정이 지워진다. 이전 버전은 서버별 기능을 보지 않으므로 다른 서버에서도 전부 동작한다.

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

되돌리면(`packages/db/rollbacks/0009_guild_requests.sql`) 요청자, 사유, 카드 기록이 지워지고 차단은 `rejected`로 남는다. 이전 버전은 이 값을 허용으로 치지 않으므로 계속 거절된다. 이전 버전은 할인 버튼을 다른 서버에서 막지 않고, 서버가 하나도 설정되지 않으면 모두 연다.
