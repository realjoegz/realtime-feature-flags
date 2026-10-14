#!/usr/bin/env bash
# Runs against the compose stack and exits non-zero on the first check that fails.
# Each check prints one line.
#
#   docker compose up --build --detach --wait
#   scripts/demo.sh
#
# 1. Both API replicas answer GET /health with their own instance name, and refuse
#    GET /me without a token and GET /sdk/stream without an SDK key.
# 2. The dashboard sign-in, driven with curl through Dex's login form: the session
#    cookie is HttpOnly and encrypted, the flags page shows a seeded flag, no response
#    body holds a JWT, and a callback whose state was changed is refused.
# 3. Access tokens for the API, through the same code flow with PKCE and the
#    dashboard's client, that the API accepts.
# 4. An SDK stream on api-2 receives each of two changes saved on api-1 within 2 s;
#    the second is saved 3 s after the first arrived. The stack's safety poll runs
#    every 30 s (compose.yaml), so at most one poll round falls inside the two
#    windows, and only Redis delivers both in time.
# 5. A viewer's PUT gets 403.
# 6. A user who is only in globex gets, for acme's flags, the same 404 as for a
#    tenant that does not exist.
#
# The users, passwords, client secret and SDK key are the local demo values of
# dex/local-demo-config.yaml and apps/api/src/seed/demo-data.ts. The sign-in through
# Dex is in scripts/lib/dex-sign-in.sh, which tools/latency uses as well. Needs curl,
# jq, openssl and perl. The first checks poll until a deadline, because port
# forwarding can lag a container that compose reports healthy.
set -euo pipefail

API_1="${RFF_DEMO_API_1:-http://127.0.0.1:4001}"
API_2="${RFF_DEMO_API_2:-http://127.0.0.1:4002}"
DASHBOARD="${RFF_DEMO_DASHBOARD:-http://127.0.0.1:3100}"
DEADLINE_SECONDS="${RFF_DEMO_DEADLINE_SECONDS:-60}"
ACME_SDK_KEY=rff_sdk_acme-local-demo-key-not-a-secret00000000000
NO_TENANT=00000000-0000-4000-8000-000000000000
# How long a change may take from api-1 to a stream on api-2, and how long the demo
# waits between two such changes.
DELIVERY_MS=2000
GAP_MS=3000
# The replicas' safety poll interval, as compose.yaml sets it.
SAFETY_POLL_MS="$(sed -n "s/^ *RFF_SAFETY_POLL_MS: '\([0-9]*\)'\$/\1/p" "$(dirname "$0")/../compose.yaml")"
# Set-Cookie attributes, matched without regard to case.
HTTP_ONLY='; *[Hh][Tt][Tt][Pp][Oo][Nn][Ll][Yy](;|$)'
SAME_SITE_LAX='; *[Ss][Aa][Mm][Ee][Ss][Ii][Tt][Ee]=[Ll][Aa][Xx](;|$)'
PATH_ROOT='; *[Pp][Aa][Tt][Hh]=/(;|$)'

work="$(mktemp -d)"
stream_pid=""
cleanup() {
  if [[ -n "$stream_pid" ]]; then
    kill "$stream_pid" 2>/dev/null || true
    wait "$stream_pid" 2>/dev/null || true
  fi
  rm -rf "$work"
}
trap cleanup EXIT

ok() { echo "ok   $*"; }
fail() {
  echo "FAIL $*" >&2
  exit 1
}
# DEX, the dashboard's client (CLIENT_ID, CLIENT_SECRET, REDIRECT_URI, SCOPE),
# b64url, uri, dex_login and api_token.
# shellcheck source=lib/dex-sign-in.sh
source "$(dirname "$0")/lib/dex-sign-in.sh"
[[ "$SAFETY_POLL_MS" =~ ^[0-9]+$ ]] || fail "compose.yaml should set RFF_SAFETY_POLL_MS once, it gives: ${SAFETY_POLL_MS:-nothing}"
now_ms() { perl -MTime::HiRes=time -e 'printf "%d\n", time * 1000'; }
b64url_decode() { perl -MMIME::Base64=decode_base64url -0777 -ne 'print decode_base64url($_)'; }
# header FILE NAME: the values of a response header saved with curl -D, one per line.
header() { tr -d '\r' <"$1" | grep -i "^$2: " | sed 's/^[^:]*: //' || true; }

# expect_reply URL STATUS EXPECTED: polls URL until it answers STATUS with exactly
# the body EXPECTED.
expect_reply() {
  local url="$1" status="$2" expected="$3" reply="" deadline=$((SECONDS + DEADLINE_SECONDS))
  while ((SECONDS < deadline)); do
    if reply="$(curl --silent --show-error --max-time 5 --write-out ' %{http_code}' "$url" 2>&1)" &&
      [[ "$reply" == "$expected $status" ]]; then
      echo "ok   GET $url -> $status $expected"
      return 0
    fi
    sleep 1
  done
  echo "FAIL GET $url: expected $status $expected within ${DEADLINE_SECONDS}s, last answer: $reply" >&2
  return 1
}

# expect_status URL STATUS: polls URL until it answers STATUS.
expect_status() {
  local url="$1" status="$2" got="" deadline=$((SECONDS + DEADLINE_SECONDS))
  while ((SECONDS < deadline)); do
    got="$(curl --silent --max-time 5 --output /dev/null --write-out '%{http_code}' "$url" || true)"
    if [[ "$got" == "$status" ]]; then
      ok "GET $url -> $status"
      return 0
    fi
    sleep 1
  done
  fail "GET $url: expected $status within ${DEADLINE_SECONDS}s, last status: $got"
}

# dashboard_login JAR NAME: GET /auth/login on the dashboard; checks the redirect
# to Dex and the flow cookie, and prints the authorization URL.
dashboard_login() {
  local jar="$1" name="$2" reply status location flow
  reply="$(curl -sS -c "$jar" -b "$jar" -D "$work/$name.headers" -o "$work/$name.body" \
    -w '%{http_code} %{redirect_url}' "$DASHBOARD/auth/login")"
  status="${reply%% *}" location="${reply#* }"
  [[ "$status" == 303 && "$location" == "$DEX/auth?"* ]] ||
    fail "GET $DASHBOARD/auth/login: expected 303 to $DEX/auth, got $reply"
  flow="$(header "$work/$name.headers" set-cookie | grep '^rff_auth_flow=' || true)"
  [[ "$flow" =~ $HTTP_ONLY ]] || fail "the sign-in flow cookie is not HttpOnly: ${flow:-none}"
  printf '%s' "$location"
}

# call METHOD URL TOKEN [BODY]: the status and body of one API request, "STATUS BODY".
call() {
  local method="$1" url="$2" token="$3" body="${4:-}"
  if [[ -n "$body" ]]; then
    curl -sS -X "$method" -H "authorization: Bearer $token" -H 'content-type: application/json' \
      --data "$body" -w ' %{http_code}' "$url" | sed 's/^\(.*\) \([0-9]*\)$/\2 \1/'
  else
    curl -sS -X "$method" -H "authorization: Bearer $token" -w ' %{http_code}' "$url" |
      sed 's/^\(.*\) \([0-9]*\)$/\2 \1/'
  fi
}

# --- 1. the replicas ---------------------------------------------------------------

expect_reply "$API_1/health" 200 '{"status":"ok","instance":"api-1"}'
expect_reply "$API_2/health" 200 '{"status":"ok","instance":"api-2"}'
expect_reply "$API_1/me" 401 '{"message":"Unauthorized","statusCode":401}'
expect_reply "$API_2/me" 401 '{"message":"Unauthorized","statusCode":401}'
expect_reply "$API_1/sdk/stream" 401 '{"message":"Unauthorized","statusCode":401}'
expect_reply "$API_2/sdk/stream" 401 '{"message":"Unauthorized","statusCode":401}'
expect_status "$DEX/.well-known/openid-configuration" 200
expect_status "$DASHBOARD/signed-out" 200

# --- 2. the dashboard sign-in -------------------------------------------------------

jar="$work/dashboard-alice.jar"
authorization_url="$(dashboard_login "$jar" login)"
ok "GET $DASHBOARD/auth/login -> 303 to Dex with an HttpOnly flow cookie"
callback="$(dex_login alice@example.test alice-local-pass "$authorization_url" "$work/dex-alice.jar")"
reply="$(curl -sS -c "$jar" -b "$jar" -D "$work/callback.headers" -o "$work/callback.body" \
  -w '%{http_code} %{redirect_url}' "$callback")"
[[ "$reply" == "303 $DASHBOARD/" ]] || fail "the callback for alice: expected 303 to $DASHBOARD/, got $reply"
session_cookie="$(header "$work/callback.headers" set-cookie | grep '^rff_session=' || true)"
[[ "$session_cookie" =~ $HTTP_ONLY && "$session_cookie" =~ $SAME_SITE_LAX && "$session_cookie" =~ $PATH_ROOT ]] ||
  fail "the session cookie is not HttpOnly, SameSite=Lax, Path=/: ${session_cookie:-none}"
# Its value is a compact JWE (dir, A256GCM: five segments, the second empty), and no
# segment, decoded, shows a JWT or alice's email.
session_value="${session_cookie#rff_session=}"
session_value="${session_value%%;*}"
[[ "$session_value" =~ ^[A-Za-z0-9_-]+\.\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$ ]] ||
  fail "the session cookie's value is not a compact JWE with dir key management (it has $(printf '%s' "$session_value" | tr -cd '.' | wc -c | tr -d ' ') dots, and is not printed)"
[[ "$(printf '%s' "${session_value%%.*}" | b64url_decode | jq -c '[.alg, .enc]')" == '["dir","A256GCM"]' ]] ||
  fail "the session cookie's header is not dir with A256GCM: $(printf '%s' "${session_value%%.*}" | b64url_decode)"
for segment in $(printf '%s' "$session_value" | tr '.' ' '); do
  if printf '%s' "$segment" | b64url_decode | LC_ALL=C grep -Eaq 'eyJ[A-Za-z0-9_-]{8,}\.eyJ|alice@example\.test'; then
    fail "a segment of the session cookie's value, decoded, shows a JWT or alice's email"
  fi
done
ok "alice signed in through Dex's login form: the session cookie is HttpOnly, SameSite=Lax, Path=/, and an encrypted JWT"

reply="$(curl -sS -b "$jar" -o "$work/tenants.body" -w '%{http_code} %{redirect_url}' "$DASHBOARD/")"
if [[ "$reply" == *"/signed-out?reason=refused" ]]; then
  fail "GET $DASHBOARD/ as alice: $reply. The API refused the token Dex gave alice: no seeded user has its issuer and subject (apps/api/src/seed/dex-subject.ts), or the API expects another issuer or audience"
fi
[[ "$reply" == "200 " ]] || fail "GET $DASHBOARD/ as alice: $reply"
flags_path="$(grep -o '/tenants/[0-9a-f-]*/flags' "$work/tenants.body" | sort -u)"
[[ "$(printf '%s\n' "$flags_path" | wc -l | tr -d ' ')" == 1 ]] ||
  fail "the tenant list should link alice's one tenant, it links: ${flags_path:-none}"
dashboard_acme="${flags_path#/tenants/}"
dashboard_acme="${dashboard_acme%/flags}"
curl -sS -b "$jar" -o "$work/flags.body" -w '%{http_code}' "$DASHBOARD$flags_path" >"$work/flags.status"
[[ "$(cat "$work/flags.status")" == 200 ]] && grep -q 'new-checkout' "$work/flags.body" ||
  fail "GET $DASHBOARD$flags_path as alice: $(cat "$work/flags.status"), without the flag new-checkout"
ok "GET $DASHBOARD$flags_path as alice -> 200 with the seeded flag new-checkout"

# A second sign-in up to the callback, whose state is then changed.
jar_wrong="$work/dashboard-wrong-state.jar"
callback="$(dex_login alice@example.test alice-local-pass "$(dashboard_login "$jar_wrong" login-2)" "$work/dex-alice-2.jar")"
wrong="$(printf '%s' "$callback" | sed 's/\([?&]state=\)[^&]*/\1changed-state/')"
reply="$(curl -sS -c "$jar_wrong" -b "$jar_wrong" -D "$work/wrong.headers" -o "$work/wrong.body" -w '%{http_code}' "$wrong")"
[[ "$reply" == 400 ]] && grep -q 'Sign-in failed (state)' "$work/wrong.body" ||
  fail "a callback with a changed state: expected 400 (state), got $reply $(cat "$work/wrong.body")"
! header "$work/wrong.headers" set-cookie | grep -q '^rff_session=' ||
  fail "a callback with a changed state set a session cookie"
ok "GET /auth/callback with Dex's code and a changed state -> 400 (state), no session cookie"

# --- 3. access tokens for the API ---------------------------------------------------

alice="$(api_token alice@example.test alice-local-pass "$work/dex-api-alice.jar")"
bob="$(api_token bob@example.test bob-local-pass "$work/dex-api-bob.jar")"
dave="$(api_token dave@example.test dave-local-pass "$work/dex-api-dave.jar")"
reply="$(call GET "$API_1/me" "$alice")"
acme="$(printf '%s' "${reply#* }" | jq -r '.memberships[] | select(.slug == "acme" and .role == "owner") | .tenantId')"
[[ "${reply%% *}" == 200 && "$acme" == "$dashboard_acme" ]] ||
  fail "GET $API_1/me with alice's token: expected 200 with acme, owner, got $reply"
ok "access tokens for alice, bob and dave through Dex's code flow with PKCE; GET $API_1/me as alice -> 200, owner of acme"

# --- 4. a change on api-1 reaches a stream on api-2 ----------------------------------

curl -sS -N --max-time 120 -H "authorization: Bearer $ACME_SDK_KEY" "$API_2/sdk/stream" \
  >"$work/stream" 2>"$work/stream.err" &
stream_pid=$!
deadline=$(($(now_ms) + 10000))
until grep -q '^id: ' "$work/stream"; do
  (($(now_ms) < deadline)) || fail "no snapshot on the acme stream of api-2 within 10 s: $(cat "$work/stream" "$work/stream.err")"
  sleep 0.05
done
reply="$(call GET "$API_1/tenants/$acme/flags/dark-mode" "$alice")"
[[ "${reply%% *}" == 200 ]] || fail "GET dark-mode as alice: $reply"
rules="$(printf '%s' "${reply#* }" | jq -c .rules)"

# save_and_wait ROLLOUT: PUT dark-mode on api-1 with that rollout and wait until its
# version is on the api-2 stream. Sets started (when the PUT was sent), version and
# elapsed (from started to the frame on the stream, in ms).
save_and_wait() {
  local rollout="$1" reply frame
  started=$(now_ms)
  reply="$(call PUT "$API_1/tenants/$acme/flags/dark-mode" "$alice" "{\"enabled\":true,\"rules\":$rules,\"rolloutBasisPoints\":$rollout}")"
  version="$(printf '%s' "${reply#* }" | jq -r '.version // empty')"
  [[ "${reply%% *}" == 200 && -n "$version" ]] || fail "PUT dark-mode on api-1 as alice: $reply"
  until grep -qx "id: $version" "$work/stream"; do
    (($(now_ms) - started <= DELIVERY_MS)) ||
      fail "version $version, saved on api-1, did not reach the stream on api-2 within $DELIVERY_MS ms"
    sleep 0.01
  done
  elapsed=$(($(now_ms) - started))
  # The frame of that version holds acme's snapshot with the new rollout.
  frame="$(awk -v id="id: $version" 'BEGIN { RS = "" } { n = split($0, lines, "\n"); hit = 0; for (i = 1; i <= n; i++) if (lines[i] == id) hit = 1; if (hit) for (i = 1; i <= n; i++) if (lines[i] ~ /^data: /) print substr(lines[i], 7) }' "$work/stream")"
  [[ "$(printf '%s' "$frame" | jq -r --arg acme "$acme" '.tenantId == $acme and .version == '"$version"' and (.flags[] | select(.key == "dark-mode") | .rolloutBasisPoints) == '"$rollout")" == true ]] ||
    fail "the frame of version $version is not acme's snapshot with the new rollout: $frame"
}

# Two saves, the second GAP_MS after the first arrived, so their windows of DELIVERY_MS
# do not overlap. Poll rounds are SAFETY_POLL_MS apart and both windows lie inside one
# span shorter than that, so at most one window holds a poll round: without the Redis
# notification, at least one of the two saves misses its window.
rollout=$(($(now_ms) % 10001))
save_and_wait "$rollout"
first_started=$started first_version=$version first_elapsed=$elapsed
sleep "$((GAP_MS / 1000))"
save_and_wait "$(((rollout + 1) % 10001))"
span=$((started + DELIVERY_MS - first_started))
((span < SAFETY_POLL_MS)) ||
  fail "the two saves and their windows took $span ms, not less than the $SAFETY_POLL_MS ms between poll rounds"
ok "two PUTs of dark-mode on api-1, the second $GAP_MS ms after the first arrived -> versions $first_version and $version on the acme SDK stream of api-2 after $first_elapsed ms and $elapsed ms (limit $DELIVERY_MS ms each, both windows inside $span ms, under the $SAFETY_POLL_MS ms between safety poll rounds)"
kill "$stream_pid" 2>/dev/null || true
wait "$stream_pid" 2>/dev/null || true
stream_pid=""

curl -sS -b "$jar" -o "$work/audit.body" -w '%{http_code}' "$DASHBOARD/tenants/$acme/audit" >"$work/audit.status"
[[ "$(cat "$work/audit.status")" == 200 ]] && grep -q 'flag.update' "$work/audit.body" && grep -q 'dark-mode' "$work/audit.body" ||
  fail "GET $DASHBOARD/tenants/$acme/audit as alice: $(cat "$work/audit.status"), without the flag.update of dark-mode"
ok "GET $DASHBOARD/tenants/$acme/audit as alice -> 200 with the flag.update of dark-mode"

for body in login callback tenants flags login-2 wrong audit; do
  if grep -Eq 'eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.' "$work/$body.body"; then
    fail "the dashboard's $body response body holds a JWT"
  fi
done
ok "no dashboard response body (7 of them) holds a JWT, such as alice's access token"

# --- 5. a viewer cannot change a flag ------------------------------------------------

reply="$(call PUT "$API_1/tenants/$acme/flags/dark-mode" "$bob" "{\"enabled\":false,\"rules\":$rules,\"rolloutBasisPoints\":0}")"
[[ "$reply" == '403 {"message":"Forbidden","statusCode":403}' ]] ||
  fail "PUT dark-mode as bob, a viewer of acme: expected 403, got $reply"
ok "PUT $API_1/tenants/$acme/flags/dark-mode as bob, a viewer of acme -> 403"

# --- 6. another tenant's flags look like no tenant at all ---------------------------

other="$(call GET "$API_1/tenants/$acme/flags" "$dave")"
none="$(call GET "$API_1/tenants/$NO_TENANT/flags" "$dave")"
[[ "${other%% *}" == 404 && "$other" == "$none" ]] ||
  fail "GET acme's flags as dave, only in globex: expected the reply for a tenant that does not exist ($none), got $other"
ok "GET $API_1/tenants/$acme/flags as dave, only in globex -> $other, the same as for a tenant that does not exist"

echo "demo: all checks passed"
