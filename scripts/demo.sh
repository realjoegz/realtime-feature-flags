#!/usr/bin/env bash
# Runs against the compose stack and exits non-zero on the first check that fails.
#
#   docker compose up --build --detach --wait
#   scripts/demo.sh
#
# For now it checks that both API replicas answer GET /health with their own instance
# name. Every check polls until a deadline instead of trusting one request, because
# port forwarding can lag a container that compose already reports healthy.
set -euo pipefail

API_1="${RFF_DEMO_API_1:-http://127.0.0.1:4001}"
API_2="${RFF_DEMO_API_2:-http://127.0.0.1:4002}"
DEADLINE_SECONDS="${RFF_DEMO_DEADLINE_SECONDS:-60}"

# expect_body URL EXPECTED: polls URL until it answers 200 with exactly EXPECTED.
expect_body() {
  local url="$1" expected="$2" body="" deadline=$((SECONDS + DEADLINE_SECONDS))
  while ((SECONDS < deadline)); do
    if body="$(curl --silent --show-error --fail --max-time 5 "$url" 2>&1)" &&
      [[ "$body" == "$expected" ]]; then
      echo "ok   GET $url -> $body"
      return 0
    fi
    sleep 1
  done
  echo "FAIL GET $url: expected $expected within ${DEADLINE_SECONDS}s, last answer: $body" >&2
  return 1
}

expect_body "$API_1/health" '{"status":"ok","instance":"api-1"}'
expect_body "$API_2/health" '{"status":"ok","instance":"api-2"}'

echo "demo: all checks passed"
