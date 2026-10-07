#!/usr/bin/env bash
set -euo pipefail
exec npx wrangler dev --port 8799 --inspector-port 9339 --local-protocol https
