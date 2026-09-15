#!/usr/bin/env bash
# Live smoke for email-required signup. Runs the REAL send-email function
# locally under Deno (the same file that gets deployed) pointed at the live
# Supabase project, then drives the exact HTTP calls the client makes:
#   signup-send → OTP row → signup-verify → token_hash → GoTrue /verify
#   (session) → profile insert under RLS (trigger sets email_verified) →
#   duplicate signup refused → sign-in with the new account → link-email guard.
# Creates one throwaway auth user + profile and deletes them on exit.
#
# Resend: pass RESEND_API_KEY to send real mail. Without it the function gets
# a dummy key, Resend rejects, signup-send answers 500 "email failed" and the
# smoke still proceeds — the OTP row is stored before the send, and the Resend
# call is byte-for-byte the shape of the already-live signin-send path.
#
# Needs: SUPABASE_ACCESS_TOKEN_EZ (Management API), deno, curl, node; port 8000 free.
#   set -a; . ~/.config/env/global.env; set +a; bash test/signup-live.sh
set -euo pipefail
cd "$(dirname "$0")/.."
REF="${PINGME_REF:-yuqahobbcwibekzvitec}"
: "${SUPABASE_ACCESS_TOKEN_EZ:?SUPABASE_ACCESS_TOKEN_EZ not set}"
API="https://api.supabase.com/v1/projects/$REF"
URL="https://$REF.supabase.co"
FN="http://127.0.0.1:8000"
J() { node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{let d=null;try{d=JSON.parse(s)}catch{}let v;try{v=(new Function("d","return ("+process.argv[1]+")"))(d)}catch{v=null}process.stdout.write(v===undefined||v===null?"":(typeof v==="object"?JSON.stringify(v):String(v)))})' "$1"; }
ANON=$(node -e "const s=require('fs').readFileSync('app.js','utf8');console.log(s.match(/SUPABASE_ANON = '([^']+)'/)[1])")
SERVICE=$(curl -sf -m 60 "$API/api-keys?reveal=true" -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN_EZ" | J '(d.find(k=>k.name==="service_role")||{}).api_key')
[ -n "$SERVICE" ] && [ "$SERVICE" != "null" ] || { echo "no service_role key"; exit 1; }

TAG="su$(date +%s | tail -c 7)"
EMAIL="mrrobot+$TAG@openclaw.dev"
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ok   $1"; }
fail() { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
check() { if eval "$2"; then ok "$1"; else fail "$1 :: $3"; fi; }

sql() {
  local q; q=$(node -e 'console.log(JSON.stringify({query:process.argv[1]}))' "$1")
  curl -s -m 120 -X POST "$API/database/query" -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN_EZ" \
    -H "Content-Type: application/json" -d "$q"
}
# fn <json-body> [bearer] → "<http_code>\n<body>"  (local function, browser-like headers)
fn() {
  curl -s -m 60 -o /tmp/pm-fn-body -w "%{http_code}" -X POST "$FN/send-email" -H "Content-Type: application/json" \
    -H "Origin: https://usepingme.com" -H "Authorization: Bearer ${2:-$ANON}" -d "$1"
  echo; cat /tmp/pm-fn-body; echo
}
code_of() { echo "$1" | head -1; }
body_of() { echo "$1" | tail -n +2; }

USER_ID=""; FNPID=""
cleanup() {
  echo "== cleanup"
  [ -n "$FNPID" ] && kill "$FNPID" 2>/dev/null || true
  if [ -n "$USER_ID" ]; then
    sql "delete from email_otps where user_id = '$USER_ID'" >/dev/null || true
    sql "delete from profiles where id = '$USER_ID'" >/dev/null || true
    sql "delete from auth.users where id = '$USER_ID'" >/dev/null || true
  fi
  sql "delete from auth.users where email = '$EMAIL'" >/dev/null || true
  local left; left=$(sql "select count(*) as n from auth.users where email = '$EMAIL'" | J 'd[0].n')
  local prof; prof=$(sql "select count(*) as n from profiles where name = '$TAG'" | J 'd[0].n')
  echo "  leftover users=$left profiles=$prof"
  echo "== $PASS passed, $FAIL failed"
  [ "$FAIL" = 0 ] && [ "$left" = 0 ] && [ "$prof" = 0 ] && echo "SIGNUP LIVE OK" || { echo "SIGNUP LIVE FAILED"; exit 1; }
}
trap cleanup EXIT

echo "== schema present"
TRG=$(sql "select count(*) as n from pg_trigger where tgname = 'profiles_email_verified_from_auth' and not tgisinternal" | J 'd[0].n')
check "profiles_email_verified_from_auth trigger applied" '[ "$TRG" = 1 ]' "got '$TRG'"

echo "== start the real function locally (deno) against the live project"
if (ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep -q ':8000 '; then echo "port 8000 busy"; exit 1; fi
SUPABASE_URL="$URL" SUPABASE_SERVICE_ROLE_KEY="$SERVICE" SUPABASE_ANON_KEY="$ANON" RESEND_API_KEY="${RESEND_API_KEY:-dummy-no-send}" \
  deno run --quiet --no-lock --allow-net --allow-env supabase/functions/send-email/index.ts >/tmp/pm-fn.log 2>&1 &
FNPID=$!
for i in $(seq 1 60); do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' -X OPTIONS "$FN/send-email" -H "Origin: https://usepingme.com" 2>/dev/null)" = 200 ]; then break; fi
  sleep 1
done
check "function serving (OPTIONS 200)" '[ "$(curl -s -o /dev/null -w "%{http_code}" -X OPTIONS "$FN/send-email")" = 200 ]' "$(tail -3 /tmp/pm-fn.log)"
EXPECT_SEND=500; [ -n "${RESEND_API_KEY:-}" ] && EXPECT_SEND=200

echo "== signup-send"
OUT=$(fn "{\"action\":\"signup-send\",\"email\":\"$(echo "$EMAIL" | tr a-z A-Z)\"}"); CODE=$(code_of "$OUT"); BODY=$(body_of "$OUT")
check "signup-send → $EXPECT_SEND (Resend $([ "$EXPECT_SEND" = 200 ] && echo real || echo stubbed))" '[ "$CODE" = "$EXPECT_SEND" ]' "http $CODE body $BODY"
USER_ID=$(sql "select id from auth.users where email = '$EMAIL'" | J 'd[0].id')
CONF=$(sql "select coalesce(email_confirmed_at::text,'null') as c from auth.users where id = '$USER_ID'" | J 'd[0].c')
check "auth user created for the (lower-cased) email, unconfirmed" '[ -n "$USER_ID" ] && [ "$CONF" = null ]' "id='$USER_ID' confirmed='$CONF'"
OTP=$(sql "select code from email_otps where user_id = '$USER_ID' and email = '$EMAIL' and expires_at > now()" | J 'd[0].code')
check "otp row keyed by the new user (6 digits, unexpired)" '[[ "$OTP" =~ ^[0-9]{6}$ ]]' "got '$OTP'"

echo "== signup-verify"
WRONG=$([ "$OTP" = 000000 ] && echo 111111 || echo 000000)
OUT=$(fn "{\"action\":\"signup-verify\",\"email\":\"$EMAIL\",\"code\":\"$WRONG\"}"); CODE=$(code_of "$OUT"); BODY=$(body_of "$OUT")
check "wrong code → invalid code, no token" '[ "$CODE" = 200 ] && echo "$BODY" | grep -q "invalid code" && ! echo "$BODY" | grep -q token_hash' "http $CODE body $BODY"
ATT=$(sql "select attempts from email_otps where user_id = '$USER_ID'" | J 'd[0].attempts')
check "attempt counted" '[ "$ATT" = 1 ]' "attempts=$ATT"
sleep 3  # progressive delay after a failed attempt
OUT=$(fn "{\"action\":\"signup-verify\",\"email\":\"$EMAIL\",\"code\":\"$OTP\"}"); CODE=$(code_of "$OUT"); BODY=$(body_of "$OUT")
TH=$(echo "$BODY" | J 'd.token_hash')
check "right code → verified + token_hash" '[ "$CODE" = 200 ] && [ "$(echo "$BODY" | J "d.verified")" = true ] && [ -n "$TH" ]' "http $CODE body $BODY"
CONF=$(sql "select coalesce(email_confirmed_at::text,'null') as c from auth.users where id = '$USER_ID'" | J 'd[0].c')
check "auth email confirmed" '[ "$CONF" != null ]' "confirmed='$CONF'"
N=$(sql "select count(*) as n from email_otps where user_id = '$USER_ID'" | J 'd[0].n')
check "otp row consumed" '[ "$N" = 0 ]' "rows=$N"

echo "== exchange token_hash for a session (what sb.auth.verifyOtp does)"
SESS=$(curl -s -m 60 -X POST "$URL/auth/v1/verify" -H "apikey: $ANON" -H "Content-Type: application/json" -d "{\"type\":\"magiclink\",\"token_hash\":\"$TH\"}")
TOKEN=$(echo "$SESS" | J 'd.access_token'); SUID=$(echo "$SESS" | J 'd.user.id')
check "session minted for the new user" '[ -n "$TOKEN" ] && [ "$SUID" = "$USER_ID" ]' "$(echo "$SESS" | head -c 200)"

echo "== name step: profile insert under RLS as the new user"
PROF=$(curl -s -m 60 -w "\n%{http_code}" -X POST "$URL/rest/v1/profiles" -H "apikey: $ANON" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -H "Prefer: return=representation" -d "{\"id\":\"$USER_ID\",\"name\":\"$TAG\",\"color\":\"#E8502A\",\"status\":\"off\",\"ambient\":\"just joined\"}")
PCODE=$(echo "$PROF" | tail -1); PBODY=$(echo "$PROF" | head -n -1)
check "profile inserted (201)" '[ "$PCODE" = 201 ]' "http $PCODE body $PBODY"
EV=$(echo "$PBODY" | J 'd[0].email_verified')
check "profile born email_verified=true (trigger)" '[ "$EV" = true ]' "returned row: $PBODY"
EV2=$(curl -s -m 60 "$URL/rest/v1/profiles?id=eq.$USER_ID&select=email_verified" -H "apikey: $ANON" | J 'd[0].email_verified')
check "email_verified visible to anon readers (leaderboard gate input)" '[ "$EV2" = true ]' "got '$EV2'"

echo "== duplicate signup refused"
OUT=$(fn "{\"action\":\"signup-send\",\"email\":\"$EMAIL\"}"); CODE=$(code_of "$OUT"); BODY=$(body_of "$OUT")
check "signup-send for a registered email → already_registered" '[ "$CODE" = 200 ] && [ "$(echo "$BODY" | J "d.code")" = already_registered ]' "http $CODE body $BODY"
N=$(sql "select count(*) as n from auth.users where email = '$EMAIL'" | J 'd[0].n')
check "no duplicate auth user" '[ "$N" = 1 ]' "users=$N"

echo "== sign in with the new account (existing signin flow)"
OUT=$(fn "{\"action\":\"signin-send\",\"email\":\"$EMAIL\"}"); CODE=$(code_of "$OUT"); BODY=$(body_of "$OUT")
check "signin-send → sent" '[ "$CODE" = 200 ] && [ "$(echo "$BODY" | J "d.sent")" = true ]' "http $CODE body $BODY"
OTP2=$(sql "select code from email_otps where user_id = '$USER_ID' and expires_at > now()" | J 'd[0].code')
check "sign-in otp stored" '[[ "$OTP2" =~ ^[0-9]{6}$ ]]' "got '$OTP2'"
OUT=$(fn "{\"action\":\"signin-verify\",\"email\":\"$EMAIL\",\"code\":\"$OTP2\"}"); CODE=$(code_of "$OUT"); BODY=$(body_of "$OUT")
TH2=$(echo "$BODY" | J 'd.token_hash')
check "signin-verify → token_hash" '[ "$CODE" = 200 ] && [ -n "$TH2" ]' "http $CODE body $BODY"
SESS2=$(curl -s -m 60 -X POST "$URL/auth/v1/verify" -H "apikey: $ANON" -H "Content-Type: application/json" -d "{\"type\":\"magiclink\",\"token_hash\":\"$TH2\"}")
check "second-device sign-in yields a session for the same user" '[ "$(echo "$SESS2" | J "d.user.id")" = "$USER_ID" ]' "$(echo "$SESS2" | head -c 200)"

echo "== guards"
OUT=$(fn "{\"action\":\"send\",\"email\":\"x@example.com\",\"user_id\":\"$USER_ID\"}"); CODE=$(code_of "$OUT")
check "link-email send with anon key only → 401" '[ "$CODE" = 401 ]' "http $CODE"
OUT=$(fn "{\"action\":\"send\",\"email\":\"$EMAIL\"}" "$TOKEN"); CODE=$(code_of "$OUT")
check "link-email send with the user session token → accepted (not 401)" '[ "$CODE" != 401 ]' "http $CODE $(body_of "$OUT")"
OUT=$(fn "{\"action\":\"signup-send\",\"email\":\"not-an-email\"}"); CODE=$(code_of "$OUT")
check "invalid email → 400" '[ "$CODE" = 400 ]' "http $CODE"
