#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
[ "${1:-}" = "--prod" ] && exec ./evals/proof-prod.sh
base=${LEE_URL:-https://localhost:8799}
local_cert=$(mktemp)
openssl s_client -connect "${base#https://}" -servername localhost </dev/null 2>/dev/null | openssl x509 > "$local_cert" || true
export NODE_EXTRA_CA_CERTS="$local_cert"
cloudflare_token=${LEE_CONSENT_CLOUDFLARE_TOKEN:-$(grep oauth_token ~/.wrangler/config/default.toml | cut -d'"' -f2)}
pass() { printf 'PASS %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1"; exit 1; }

status=$(curl -s --cacert "$local_cert" -o /dev/null -w '%{http_code}' "$base/v1/models")
[ "$status" = 401 ] && pass "no token -> 401" || fail "no token -> $status"

forged_token=$(openssl rand -hex 24)
status=$(curl -s --cacert "$local_cert" -o /dev/null -w '%{http_code}' -H "authorization: Bearer $forged_token" "$base/v1/models")
[ "$status" = 401 ] && pass "bad token -> 401" || fail "bad token -> $status"

grant=$(LEE_URL="$base" LEE_CONSENT_CLOUDFLARE_TOKEN="$cloudflare_token" node evals/oauth-flow.mjs)
access=$(printf '%s' "$grant" | jq -r .access_token)
scope=$(printf '%s' "$grant" | jq -r .scope)
[ -n "$access" ] && [ "$scope" = "lee:read" ] && pass "OAuth code+PKCE flow issued scoped token ($scope)" || fail "OAuth flow"

case "$access" in *"$cloudflare_token"*) fail "Lee token embeds the Cloudflare token";; esac
pass "Lee token is not the Cloudflare token"

status=$(curl -s --cacert "$local_cert" -o /dev/null -w '%{http_code}' -H "authorization: Bearer $access" "$base/v1/models")
[ "$status" = 200 ] && pass "scoped token -> 200" || fail "scoped token -> $status"

expected=$(curl -s -H "authorization: Bearer $cloudflare_token" 'https://api.cloudflare.com/client/v4/zones?per_page=1' | jq -r .result_info.total_count)
answer=$(curl -s --cacert "$local_cert" "$base/v1/chat/completions" -H "authorization: Bearer $access" -H 'content-type: application/json' \
  -d '{"model":"cloudflare/lee","messages":[{"role":"user","content":"How many zones are in my Cloudflare account? Answer with only the number."}]}' | jq -r '.choices[0].message.content')
printf '%s' "$answer" | grep -qw "$expected" && pass "PiHarness answer '$answer' matches live zone count $expected" || fail "answer '$answer' != $expected"

for file in ~/.pi/agent/models.json ~/.pi/agent/auth.json; do
  if grep -q -E "cfat_|oauth_token" "$file" || grep -qF "$cloudflare_token" "$file"; then fail "Cloudflare token found in $file"; fi
done
pass "no Cloudflare token in pi models.json or auth.json"

jq -e '."cloudflare-lee".type == "oauth"' ~/.pi/agent/auth.json >/dev/null && pass "pi holds a Lee OAuth credential from /login" || fail "no pi /login credential"
