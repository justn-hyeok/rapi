#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export DATABASE_URL="${MIGRATION_DATABASE_URL:-${DATABASE_URL:-postgresql://redhood:redhood-local-only@127.0.0.1:5433/redhood}}"
exec node scripts/migrate.mjs
