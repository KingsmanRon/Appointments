#!/usr/bin/env bash
set -euo pipefail
: "${RESOURCE_GROUP:?}" "${PREFIX:?}" "${DATABASE_URL:?}" "${IMAGE:?}"
az deployment group create -g "$RESOURCE_GROUP" -f "$(dirname "$0")/main.bicep" -p prefix="$PREFIX" databaseUrl="$DATABASE_URL" image="$IMAGE"
