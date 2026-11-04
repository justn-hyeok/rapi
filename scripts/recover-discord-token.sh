#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

./scripts/rotate-discord-token.sh

root=()
if [[ $EUID -ne 0 ]]; then root=(sudo); fi

cleanup() {
  "${root[@]}" systemctl disable --now \
    redhood-bot.service >/dev/null 2>&1 || true
}
trap cleanup ERR

"${root[@]}" systemctl enable --now \
  redhood-bot.service \

if node --env-file=.env -e 'process.exit(process.env.REDHOOD_PUBLIC_BASE_URL ? 0 : 1)'; then
  "${root[@]}" systemctl enable --now redhood-public-gateway.service
  if [[ -f /var/lib/redhood/cloudflared/config.yml ]]; then
    "${root[@]}" systemctl enable --now redhood-tunnel.service
  fi
fi

for attempt in {1..30}; do
  if curl --silent --fail --max-time 3 "http://127.0.0.1:${PORT:-4000}/ready" >/dev/null; then
    trap - ERR
    echo "새 Discord 토큰을 등록했고 봇 준비 상태를 확인했습니다."
    exit 0
  fi
  sleep 1
done
echo "봇이 준비되지 않았습니다. 서비스를 다시 중지합니다." >&2
false
