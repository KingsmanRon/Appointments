#!/usr/bin/env bash
set -euo pipefail
node -e "JSON.parse(require('fs').readFileSync('infra/vercel/vercel.json'))"
test -s infra/azure/main.bicep && test -s infra/railway/railway.toml && test -s Dockerfile && test -s docker-compose.yml
if command -v az >/dev/null; then
  az bicep build --file infra/azure/main.bicep --stdout >/dev/null
elif command -v bicep >/dev/null; then
  bicep build infra/azure/main.bicep --stdout >/dev/null
else
  echo 'Azure CLI and Bicep CLI unavailable; static assets checked' >&2
fi
