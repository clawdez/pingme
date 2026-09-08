#!/usr/bin/env bash
# Live smoke for 20260909_pending_schools.sql against the real Supabase project,
# exercising the exact paths the client uses (PostgREST with a real anonymous
# user JWT) plus the admin paths (service_role JWT and the postgres session that
# the dashboard SQL editor uses). Creates one throwaway user + a few pending
# schools and deletes all of them on exit.
#
# Needs: SUPABASE_ACCESS_TOKEN_EZ (Management API), curl, node (no jq needed).
#   set -a; . ~/.config/env/global.env; set +a; bash test/pending-schools-live.sh
set -euo pipefail
cd "$(dirname "$0")/.."
REF="${PINGME_REF:-yuqahobbcwibekzvitec}"
: "${SUPABASE_ACCESS_TOKEN_EZ:?SUPABASE_ACCESS_TOKEN_EZ not set}"
API="https://api.supabase.com/v1/projects/$REF"
URL="https://$REF.supabase.co"
# J '<js expr over d>' — evaluate against JSON on stdin (d = parsed body); prints scalar or JSON.
J() { node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{let d=null;try{d=JSON.parse(s)}catch{}let v;try{v=(new Function("d","return ("+process.argv[1]+")"))(d)}catch{v=null}process.stdout.write(v===undefined||v===null?"":(typeof v==="object"?JSON.stringify(v):String(v)))})' "$1"; }
ANON=$(node -e "const s=require('fs').readFileSync('app.js','utf8');console.log(s.match(/SUPABASE_ANON = '([^']+)'/)[1])")
SERVICE=$(curl -sf -m 60 "$API/api-keys?reveal=true" -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN_EZ" | J '(d.find(k=>k.name==="service_role")||{}).api_key')
[ -n "$SERVICE" ] && [ "$SERVICE" != "null" ] || { echo "no service_role key"; exit 1; }

# Short tag: slugs are capped at 32 chars by suggest_school, and the longest
# test slug is "rice-university-<TAG>" — keep TAG under 16 chars.
TAG="mrl$(date +%s | tail -c 7)"
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ok   $1"; }
fail() { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
check() { if eval "$2"; then ok "$1"; else fail "$1 :: $3"; fi; }

# Management API SQL (runs as postgres, no JWT — same as the dashboard SQL editor)
sql() {
  local q; q=$(node -e 'console.log(JSON.stringify({query:process.argv[1]}))' "$1")
  curl -s -m 120 -X POST "$API/database/query" -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN_EZ" \
    -H "Content-Type: application/json" -d "$q"
}
# PostgREST rpc as a given bearer. Prints "<http_code>\n<body>".
rpc() { # rpc <fn> <json-args> <bearer>
  curl -s -m 60 -o /tmp/pm-rpc-body -w "%{http_code}" -X POST "$URL/rest/v1/rpc/$1" \
    -H "apikey: $ANON" -H "Authorization: Bearer $3" -H "Content-Type: application/json" -d "$2"
  echo; cat /tmp/pm-rpc-body; echo
}

USER_ID=""
SLUGS=("rice-university-$TAG" "second-school-$TAG" "third-school-$TAG" "fourth-school-$TAG" "sql-editor-$TAG")
cleanup() {
  echo "== cleanup"
  local list; list=$(printf "'%s'," "${SLUGS[@]}"); list="${list%,}"
  if [ -n "$USER_ID" ]; then
    sql "delete from school_suggestions where user_id = '$USER_ID'" >/dev/null || true
    sql "delete from profiles where id = '$USER_ID'" >/dev/null || true
    sql "delete from auth.users where id = '$USER_ID'" >/dev/null || true
  fi
  sql "delete from school_suggestions where slug in ($list)" >/dev/null || true
  sql "delete from schools where slug in ($list)" >/dev/null || true
  local left; left=$(sql "select count(*) as n from schools where slug like '%$TAG'" | J 'd[0].n')
  local users; users=$(sql "select count(*) as n from profiles where name = '$TAG'" | J 'd[0].n')
  echo "  leftover schools=$left profiles=$users"
  echo "== $PASS passed, $FAIL failed"
  [ "$FAIL" = 0 ] && [ "$left" = 0 ] && [ "$users" = 0 ] && echo "PENDING-SCHOOLS LIVE OK" || { echo "PENDING-SCHOOLS LIVE FAILED"; exit 1; }
}
trap cleanup EXIT

echo "== schema present"
COL=$(sql "select data_type from information_schema.columns where table_schema='public' and table_name='schools' and column_name='pending'" | J 'd[0].data_type')
check "schools.pending exists (boolean)" '[ "$COL" = "boolean" ]' "got '$COL'"
FNS=$(sql "select string_agg(proname, ',' order by proname) as f from pg_proc where proname in ('suggest_school','approve_school')" | J 'd[0].f')
check "rpcs exist" '[ "$FNS" = "approve_school,suggest_school" ]' "got '$FNS'"

echo "== anonymous signup (same path as the app)"
SIGNUP=$(curl -s -m 60 -X POST "$URL/auth/v1/signup" -H "apikey: $ANON" -H "Content-Type: application/json" -d '{}')
TOKEN=$(echo "$SIGNUP" | J 'd.access_token')
USER_ID=$(echo "$SIGNUP" | J 'd.user.id')
check "anonymous user created" '[ -n "$TOKEN" ] && [ -n "$USER_ID" ]' "$(echo "$SIGNUP" | head -c 200)"
PROF=$(curl -s -m 60 -o /dev/null -w "%{http_code}" -X POST "$URL/rest/v1/profiles" -H "apikey: $ANON" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -H "Prefer: return=minimal" -d "{\"id\":\"$USER_ID\",\"name\":\"$TAG\",\"color\":\"#E8502A\"}")
check "profile inserted under RLS" '[ "$PROF" = 201 ]' "http $PROF"

echo "== suggest_school as the user"
OUT=$(rpc suggest_school "{\"p_name\":\"  Rice   University $TAG \"}" "$TOKEN"); CODE=$(echo "$OUT" | head -1); BODY=$(echo "$OUT" | tail -n +2)
check "returns 200 with the slug" '[ "$CODE" = 200 ] && [ "$BODY" = "\"rice-university-$TAG\"" ]' "http $CODE body $BODY"
ROW=$(sql "select pending, display_name from schools where slug = 'rice-university-$TAG'")
check "school row exists and is pending" '[ "$(echo "$ROW" | J 'd[0].pending')" = true ]' "$ROW"
check "display_name keeps casing, collapses whitespace" '[ "$(echo "$ROW" | J 'd[0].display_name')" = "Rice University $TAG" ]' "$ROW"
PS=$(sql "select school from profiles where id = '$USER_ID'" | J 'd[0].school')
check "profile.school assigned" '[ "$PS" = "rice-university-$TAG" ]' "got $PS"
N=$(curl -s -m 60 "$URL/rest/v1/schools?select=slug&slug=eq.rice-university-$TAG" -H "apikey: $ANON" -H "Authorization: Bearer $TOKEN" | J 'd.length')
check "submitter can read own pending row via RLS" '[ "$N" = 1 ]' "got $N rows"
N=$(curl -s -m 60 "$URL/rest/v1/schools?select=slug&slug=eq.rice-university-$TAG" -H "apikey: $ANON" -H "Authorization: Bearer $ANON" | J 'd.length')
check "anon cannot see the pending row" '[ "$N" = 0 ]' "got $N rows"
RC=$(curl -s -m 60 -o /tmp/pm-roster -w "%{http_code}" "$URL/rest/v1/profiles?select=id,name,school,home_city&order=updated_at.desc&limit=50" -H "apikey: $ANON" -H "Authorization: Bearer $TOKEN")
RN=$(J 'd.filter(x=>x.id==="'"$USER_ID"'").length' < /tmp/pm-roster)
check "roster still loads for a user with a pending school" '[ "$RC" = 200 ] && [ "$RN" = 1 ]' "http $RC rows=$RN"

echo "== validation + auth"
OUT=$(rpc suggest_school '{"p_name":"other"}' "$TOKEN"); CODE=$(echo "$OUT" | head -1); BODY=$(echo "$OUT" | tail -n +2)
check "reserved name rejected" '[ "$CODE" != 200 ] && [ "$CODE" != 204 ]' "http $CODE $BODY"
OUT=$(rpc suggest_school '{"p_name":"x"}' "$TOKEN"); CODE=$(echo "$OUT" | head -1)
check "1-char name rejected" '[ "$CODE" != 200 ] && [ "$CODE" != 204 ]' "http $CODE"
OUT=$(rpc suggest_school "{\"p_name\":\"Anon School $TAG\"}" "$ANON"); CODE=$(echo "$OUT" | head -1); BODY=$(echo "$OUT" | tail -n +2)
check "anon caller rejected" '[ "$CODE" = 401 ] || [ "$CODE" = 403 ] || [ "$CODE" = 400 ]' "http $CODE $BODY"
AN=$(sql "select count(*) as n from schools where slug like 'anon-school%'" | J 'd[0].n')
check "anon call inserted nothing" '[ "$AN" = 0 ]' "got $AN"

echo "== rate limit (3 per 24h)"
OUT=$(rpc suggest_school "{\"p_name\":\"Second School $TAG\"}" "$TOKEN"); C2=$(echo "$OUT" | head -1)
OUT=$(rpc suggest_school "{\"p_name\":\"Third School $TAG\"}" "$TOKEN"); C3=$(echo "$OUT" | head -1)
check "2nd and 3rd suggestions accepted" '[ "$C2" = 200 ] && [ "$C3" = 200 ]' "http $C2 $C3"
OUT=$(rpc suggest_school "{\"p_name\":\"Fourth School $TAG\"}" "$TOKEN"); C4=$(echo "$OUT" | head -1); BODY=$(echo "$OUT" | tail -n +2)
check "4th suggestion rejected with a rate-limit message" '[ "$C4" != 200 ] && echo "$BODY" | grep -qi "rate limit"' "http $C4 $BODY"
FN=$(sql "select count(*) as n from schools where slug = 'fourth-school-$TAG'" | J 'd[0].n')
check "4th row not inserted" '[ "$FN" = 0 ]' "got $FN"

echo "== approve"
OUT=$(rpc approve_school "{\"p_slug\":\"rice-university-$TAG\"}" "$TOKEN"); CODE=$(echo "$OUT" | head -1)
check "authenticated user cannot approve" '[ "$CODE" != 200 ] && [ "$CODE" != 204 ]' "http $CODE"
OUT=$(rpc approve_school "{\"p_slug\":\"rice-university-$TAG\"}" "$SERVICE"); CODE=$(echo "$OUT" | head -1); BODY=$(echo "$OUT" | tail -n +2)
check "service_role approves" '[ "$CODE" = 200 ] || [ "$CODE" = 204 ]' "http $CODE $BODY"
P=$(sql "select pending from schools where slug = 'rice-university-$TAG'" | J 'd[0].pending')
check "row flipped to pending=false" '[ "$P" = false ]' "got $P"
N=$(curl -s -m 60 "$URL/rest/v1/schools?select=slug&slug=eq.rice-university-$TAG" -H "apikey: $ANON" -H "Authorization: Bearer $ANON" | J 'd.length')
check "anon can now see the approved school" '[ "$N" = 1 ]' "got $N rows"
# Ez's path: plain SQL from the dashboard editor (postgres session, no JWT)
sql "insert into schools (slug, display_name, pending) values ('sql-editor-$TAG', 'SQL Editor $TAG', true) on conflict (slug) do nothing" >/dev/null
R=$(sql "select approve_school('sql-editor-$TAG')")
P=$(sql "select pending from schools where slug = 'sql-editor-$TAG'" | J 'd[0].pending')
check "approve_school works from the SQL editor session" '[ "$P" = false ]' "resp $R pending=$P"
R=$(sql "select approve_school('no-such-school-$TAG')")
check "approving an unknown slug raises" 'echo "$R" | grep -qi "unknown school\|error"' "$R"

echo "== regression: seeded picker"
SEEDED=$(curl -s -m 60 "$URL/rest/v1/schools?select=slug&pending=eq.false&order=slug" -H "apikey: $ANON" -H "Authorization: Bearer $ANON" | J 'd.map(x=>x.slug).join(",")')
for s in baylor texas-am ttu uh ut-austin; do
  check "seeded school $s still listed to anon" 'echo ",$SEEDED," | grep -q ",$s,"' "$SEEDED"
done
