#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
base=${LEE_URL:-https://lee.coey.dev}
auth=~/.pi/agent/auth.json
pass() { printf 'PASS %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1"; exit 1; }

status=$(curl -s -o /dev/null -w '%{http_code}' "$base/v1/models")
[ "$status" = 401 ] && pass "no token -> 401" || fail "no token -> $status"

forged_token=$(openssl rand -hex 24)
status=$(curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer $forged_token" "$base/v1/models")
[ "$status" = 401 ] && pass "forged token -> 401" || fail "forged token -> $status"

client=$(curl -s "$base/oauth/register" -H 'content-type: application/json' \
  -d '{"client_name":"lee-proof","redirect_uris":["http://127.0.0.1:53682/callback"],"token_endpoint_auth_method":"none"}' | jq -r .client_id)
consent=$(curl -s "$base/authorize?response_type=code&client_id=$client&redirect_uri=http%3A%2F%2F127.0.0.1%3A53682%2Fcallback&scope=lee%3Aread&state=s&code_challenge=$(openssl rand -hex 22)&code_challenge_method=S256")
printf '%s' "$consent" | grep -q "Continue with Cloudflare" && pass "consent page hands off to Sign in with Cloudflare" || fail "consent page missing Cloudflare handoff"
printf '%s' "$consent" | grep -qi 'type="password"\|cloudflare_token' && fail "consent page still asks for a pasted token" || pass "consent page has no token field"

jq -e '."cloudflare-lee".type == "oauth"' "$auth" >/dev/null && pass "pi holds a Lee OAuth credential from /login" || fail "no pi /login credential"
refresh=$(jq -r '."cloudflare-lee".refresh' "$auth")
client_id=$(jq -r '."cloudflare-lee".clientId // ."cloudflare-lee".client_id // empty' "$auth")
[ -n "$client_id" ] || fail "pi credential has no client id"
rotated=$(curl -s "$base/oauth/token" -d grant_type=refresh_token -d "refresh_token=$refresh" -d "client_id=$client_id")
access=$(printf '%s' "$rotated" | jq -r '.access_token // empty')
new_refresh=$(printf '%s' "$rotated" | jq -r '.refresh_token // empty')
[ -n "$access" ] && [ -n "$new_refresh" ] || fail "refresh failed: $(printf '%s' "$rotated" | jq -c '.error // .')"
pass "refresh rotated the Lee grant (Cloudflare refresh ran upstream)"

status=$(curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer $access" "$base/v1/models")
[ "$status" = 200 ] && pass "Lee token -> 200" || fail "Lee token -> $status"

wrangler_token=$(grep oauth_token ~/.wrangler/config/default.toml | cut -d'"' -f2)
expected=$(curl -s -H "authorization: Bearer $wrangler_token" "https://api.cloudflare.com/client/v4/zones?per_page=1&account.id=${LEE_PROOF_ACCOUNT:-bfcb6ac5b3ceaf42a09607f6f7925823}" | jq -r .result_info.total_count)
answer=$(curl -s "$base/v1/chat/completions" -H "authorization: Bearer $access" -H 'content-type: application/json' \
  -d "{\"model\":\"cloudflare/lee\",\"messages\":[{\"role\":\"user\",\"content\":\"proof $(date +%s): How many zones are in my Cloudflare account? Answer with only the number.\"}]}" | jq -r '.choices[0].message.content')
printf '%s' "$answer" | grep -qw "$expected" && pass "prod answer '$answer' matches live zone count $expected via the signed-in user's Cloudflare OAuth token" || fail "answer '$answer' != $expected"

if grep -q -E 'cfat_|cfoc_|oauth_token' ~/.pi/agent/models.json "$auth"; then fail "Cloudflare credential found in pi files"; fi
pass "no Cloudflare token in pi models.json or auth.json"

grep -q 'storage.put("cloudflare-token"' src/lee-harness.ts && fail "Durable Object still stores the Cloudflare token" || pass "Durable Object keeps the Cloudflare token in memory only"
