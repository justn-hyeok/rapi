#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
env_file=${REDHOOD_ENV_FILE:-.env}
if [[ ! -f "$env_file" ]]; then
  echo "Environment file not found: $env_file" >&2
  exit 1
fi

IFS= read -r -s -p "새 Discord 봇 토큰을 붙여넣고 Enter: " token
printf '\n'
if [[ -z "$token" ]]; then
  echo "토큰이 비어 있습니다." >&2
  exit 1
fi

printf '%s' "$token" | REDHOOD_ENV_FILE="$env_file" node scripts/update-discord-token.mjs
unset token

if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemctl이 없어 서비스는 재시작하지 않았습니다."
  exit 0
fi

services=()
for service in redhood-bot.service redhood-monitor.service; do
  if systemctl is-active --quiet "$service"; then
    services+=("$service")
  fi
done
if [[ ${#services[@]} -eq 0 ]]; then
  echo "실행 중인 레드후드 서비스가 없어 .env만 갱신했습니다."
  exit 0
fi

if [[ $EUID -eq 0 ]]; then
  systemctl restart "${services[@]}"
else
  sudo systemctl restart "${services[@]}"
fi
echo "토큰 교체 완료: 실행 중이던 레드후드 서비스 ${#services[@]}개를 재시작했습니다."
