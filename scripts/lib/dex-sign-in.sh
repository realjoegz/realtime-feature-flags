# shellcheck shell=bash
# Sign-in through Dex with curl, playing the browser: the authorization code flow
# with PKCE and the dashboard's client. Sourced by scripts/demo.sh and by
# tools/latency (tools/latency/src/sign-in.ts), which both need access tokens for
# the API. Dex enforces S256 for every client and has no password grant, so this
# flow is the only way to a token. Needs curl, jq and openssl.
#
# DEX is Dex's issuer, RFF_DEMO_DEX or http://127.0.0.1:5556/dex. The client is the
# dashboard's, with the local demo values that dex/local-demo-config.yaml registers.
# A function that fails calls fail: the caller's, or the one below, which prints the
# reason and exits.

DEX="${RFF_DEMO_DEX:-http://127.0.0.1:5556/dex}"
CLIENT_ID=rff-dashboard
CLIENT_SECRET=dashboard-local-secret
REDIRECT_URI=http://127.0.0.1:3100/auth/callback
SCOPE='openid email profile audience:server:client_id:rff-api'

if ! declare -F fail >/dev/null; then
  fail() {
    echo "FAIL $*" >&2
    exit 1
  }
fi

b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
uri() { jq -rn --arg value "$1" '$value | @uri'; }

# dex_login LOGIN PASSWORD AUTHORIZATION_URL JAR: plays the browser at Dex. Follows
# the authorization request to the login form, posts the form back to the URL it
# came from, and prints the URL Dex then redirects to: the redirect URI with the
# code and the state. Nothing listens there for this function; the caller decides.
dex_login() {
  local login="$1" password="$2" authorization_url="$3" jar="$4" form_url approval callback
  form_url="$(curl -sS -c "$jar" -b "$jar" -o /dev/null -L -w '%{url_effective}' "$authorization_url")"
  approval="$(curl -sS -c "$jar" -b "$jar" -o /dev/null -w '%{redirect_url}' \
    --data-urlencode "login=$login" --data-urlencode "password=$password" "$form_url")"
  [[ -n "$approval" ]] || fail "Dex did not accept the login form for $login at $form_url"
  # With skipApprovalScreen, the approval step redirects straight to the client.
  callback="$(curl -sS -c "$jar" -b "$jar" -o /dev/null -w '%{redirect_url}' "$approval")"
  [[ "$callback" == "$REDIRECT_URI?"* ]] ||
    fail "Dex sent $login to ${callback:-nowhere} instead of $REDIRECT_URI"
  printf '%s' "$callback"
}

# api_token LOGIN PASSWORD JAR: an access token for the API, with audience rff-api,
# through the code flow with PKCE. JAR is the file that keeps Dex's cookies.
api_token() {
  local login="$1" password="$2" jar="$3" verifier challenge state callback code reply token
  verifier="$(openssl rand 32 | b64url)"
  challenge="$(printf '%s' "$verifier" | openssl dgst -sha256 -binary | b64url)"
  state="$(openssl rand 12 | b64url)"
  callback="$(dex_login "$login" "$password" "$DEX/auth?client_id=$CLIENT_ID&redirect_uri=$(uri "$REDIRECT_URI")&response_type=code&scope=$(uri "$SCOPE")&state=$state&code_challenge=$challenge&code_challenge_method=S256" "$jar")"
  [[ "$callback" == *"state=$state"* ]] || fail "the state Dex returned for $login is not the one sent"
  code="$(printf '%s' "$callback" | sed -n 's/.*[?&]code=\([^&]*\).*/\1/p')"
  reply="$(curl -sS -u "$CLIENT_ID:$CLIENT_SECRET" "$DEX/token" \
    --data-urlencode grant_type=authorization_code --data-urlencode "code=$code" \
    --data-urlencode "redirect_uri=$REDIRECT_URI" --data-urlencode "code_verifier=$verifier")"
  token="$(printf '%s' "$reply" | jq -r '.access_token // empty')"
  [[ -n "$token" ]] || fail "Dex gave $login no access token: $reply"
  printf '%s' "$token"
}
