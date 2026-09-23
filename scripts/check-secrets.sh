#!/usr/bin/env bash
set -euo pipefail
if git grep -InE '(SUPABASE_SERVICE_ROLE_KEY|-----BEGIN (RSA |EC )?PRIVATE KEY-----|AKIA[0-9A-Z]{16})' -- ':!scripts/check-secrets.sh'; then echo 'potential secret found' >&2; exit 1; fi
