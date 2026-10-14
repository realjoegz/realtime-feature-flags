#!/usr/bin/env bash
# Runs against the compose stack and exits non-zero on the first check that fails.
#
#   docker compose up --build --detach --wait
#   scripts/demo.sh
#
# For now it checks that both API replicas answer GET /health with their own instance
# name, that both refuse GET /me without a token, and that both refuse the SDK
# stream, GET /sdk/stream, without an SDK key. Every check polls until a
# deadline instead of trusting one request, because port forwarding can lag a
# container that compose already reports healthy.
set -euo pipefail

API_1="${RFF_DEMO_API_1:-http://127.0.0.1:4001}"
API_2="${RFF_DEMO_API_2:-http://127.0.0.1:4002}"
DEADLINE_SECONDS="${RFF_DEMO_DEADLINE_SECONDS:-60}"

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

expect_reply "$API_1/health" 200 '{"status":"ok","instance":"api-1"}'
expect_reply "$API_2/health" 200 '{"status":"ok","instance":"api-2"}'
expect_reply "$API_1/me" 401 '{"message":"Unauthorized","statusCode":401}'
expect_reply "$API_2/me" 401 '{"message":"Unauthorized","statusCode":401}'
expect_reply "$API_1/sdk/stream" 401 '{"message":"Unauthorized","statusCode":401}'
expect_reply "$API_2/sdk/stream" 401 '{"message":"Unauthorized","statusCode":401}'

echo "demo: all checks passed"
