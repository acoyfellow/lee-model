#!/usr/bin/env bash
set -euo pipefail
token=$(grep oauth_token ~/.wrangler/config/default.toml | cut -d'"' -f2)
account=${LEE_ACCOUNT_ID:?set LEE_ACCOUNT_ID to the Workers AI account}
exec npx wrangler dev --port 8799 --inspector-port 9339 --var "WORKERS_AI_TOKEN:$token" --var "ACCOUNT_ID:$account"
