#!/usr/bin/env bash
# Live smoke for 20260911_scenes_from_schools.sql against the real Supabase
# project, exercising the exact paths the client uses (PostgREST + RPC with real
# user JWTs) plus the admin paths (service_role JWT and the postgres session the
# dashboard SQL editor uses). Creates three throwaway email-confirmed users and
# a few scenes, and deletes all of them on exit.
#
# Needs: SUPABASE_ACCESS_TOKEN_EZ (Management API), curl, node (no jq needed).
#   set -a; . ~/.config/env/global.env; set +a; bash test/scenes-live.sh
set -euo pipefail
cd "$(dirname "$0")/.."
REF="${PINGME_REF:-yuqahobbcwibekzvitec}"
: "${SUPABASE_ACCESS_TOKEN_EZ:?SUPABASE_ACCESS_TOKEN_EZ not set}"
API="https://api.supabase.com/v1/projects/$REF"
URL="https://$REF.supabase.co"
J() { node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{let d=null;try{d=JSON.parse(s)}catch{}let v;try{v=(new Function("d","return ("+process.argv[1]+")"))(d)}catch{v=null}process.stdout.write(v===undefined||v===null?"":(typeof v==="object"?JSON.stringify(v):String(v)))})' "$1"; }
ANON=$(node -e "const s=require('fs').readFileSync('app.js','utf8');console.log(s.match(/SUPABASE_ANON = '([^']+)'/)[1])")
SERVICE=$(curl -sf -m 60 "$API/api-keys?reveal=true" -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN_EZ" | J '(d.find(k=>k.name==="service_role")||{}).api_key')
[ -n "$SERVICE" ] && [ "$SERVICE" != "null" ] || { echo "no service_role key"; exit 1; }

# slugs are capped at 32 chars: keep TAG short
TAG="mrl$(date +%s | tail -c 7)"
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ok   $1"; }
fail() { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
check() { if eval "$2"; then ok "$1"; else fail "$1 :: $3"; fi; }

sql() {
  local q; q=$(node -e 'console.log(JSON.stringify({query:process.argv[1]}))' "$1")
  curl -s -m 120 -X POST "$API/database/query" -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN_EZ" \
    -H "Content-Type: application/json" -d "$q"
}
rpc() { # rpc <fn> <json-args> <bearer>  → "<http_code>\n<body>"
  curl -s -m 60 -o /tmp/pm-rpc-body -w "%{http_code}" -X POST "$URL/rest/v1/rpc/$1" \
    -H "apikey: $ANON" -H "Authorization: Bearer $3" -H "Content-Type: application/json" -d "$2"
  echo; cat /tmp/pm-rpc-body; echo
}
code() { echo "$1" | head -1; }
body() { echo "$1" | tail -n +2; }

# Real accounts: admin-created, email-confirmed, password sign-in (the app's
# accounts are email-confirmed users since PR #6).
mkuser() { # mkuser <name> → prints "<id> <token>"
  local email="$1-$TAG@mrrobot.invalid" pw="Pw-$TAG-$1-xyz"
  local u; u=$(curl -s -m 60 -X POST "$URL/auth/v1/admin/users" -H "apikey: $SERVICE" -H "Authorization: Bearer $SERVICE" \
    -H "Content-Type: application/json" -d "{\"email\":\"$email\",\"password\":\"$pw\",\"email_confirm\":true}")
  local id; id=$(echo "$u" | J 'd.id')
  local t; t=$(curl -s -m 60 -X POST "$URL/auth/v1/token?grant_type=password" -H "apikey: $ANON" -H "Content-Type: application/json" \
    -d "{\"email\":\"$email\",\"password\":\"$pw\"}" | J 'd.access_token')
  echo "$id $t"
}
mkprofile() { # mkprofile <id> <token> <name>
  curl -s -m 60 -o /dev/null -w "%{http_code}" -X POST "$URL/rest/v1/profiles" -H "apikey: $ANON" -H "Authorization: Bearer $2" \
    -H "Content-Type: application/json" -H "Prefer: return=minimal" -d "{\"id\":\"$1\",\"name\":\"$3\",\"color\":\"#E8502A\"}"
}

U1=""; U2=""; U3=""; DONE=0
SLUG="zilker-test-$TAG"
cleanup() {
  echo "== cleanup"
  local ids=""; for u in $U1 $U2 $U3; do ids="$ids'$u',"; done; ids="${ids%,}"
  sql "delete from pings where scene_id in (select id from scenes where slug like '%$TAG')" >/dev/null || true
  if [ -n "$ids" ]; then
    sql "delete from pings where from_id in ($ids) or to_id in ($ids)" >/dev/null || true
    sql "delete from scene_members where user_id in ($ids)" >/dev/null || true
    sql "delete from scene_suggestions where user_id in ($ids)" >/dev/null || true
    sql "delete from school_suggestions where user_id in ($ids)" >/dev/null || true
  fi
  sql "delete from scene_members where scene_id in (select id from scenes where slug like '%$TAG')" >/dev/null || true
  sql "delete from scenes where slug like '%$TAG'" >/dev/null || true
  sql "delete from schools where slug like '%$TAG'" >/dev/null || true
  for u in $U1 $U2 $U3; do
    sql "delete from profiles where id = '$u'" >/dev/null || true
    curl -s -m 60 -o /dev/null -X DELETE "$URL/auth/v1/admin/users/$u" -H "apikey: $SERVICE" -H "Authorization: Bearer $SERVICE" || true
  done
  local left; left=$(sql "select (select count(*) from scenes where slug like '%$TAG') + (select count(*) from schools where slug like '%$TAG') as n" | J 'd[0].n')
  local users; users=$(sql "select count(*) as n from auth.users where email like '%$TAG@mrrobot.invalid'" | J 'd[0].n')
  echo "  leftover scenes=$left users=$users"
  echo "== $PASS passed, $FAIL failed"
  [ "$DONE" = 1 ] && [ "$FAIL" = 0 ] && [ "$left" = 0 ] && [ "$users" = 0 ] && echo "SCENES LIVE OK" || { echo "SCENES LIVE FAILED (done=$DONE)"; exit 1; }
}
trap cleanup EXIT

echo "== schema present"
T=$(sql "select string_agg(table_name, ',' order by table_name) as t from information_schema.tables where table_schema='public' and table_name in ('scenes','scene_members','scene_suggestions','zip_prefixes','schools')" | J 'd[0].t')
check "tables: scenes, scene_members, scene_suggestions, zip_prefixes (+ schools kept)" '[ "$T" = "scene_members,scene_suggestions,scenes,schools,zip_prefixes" ]' "got '$T'"
FNS=$(sql "select string_agg(distinct proname, ',' order by proname) as f from pg_proc where proname in ('create_scene','join_scene','leave_scene','set_scene_notifications','list_scenes','ping_scene','approve_scene','suggest_school','set_school','approve_school')" | J 'd[0].f')
check "rpcs + aliases exist" '[ "$FNS" = "approve_scene,approve_school,create_scene,join_scene,leave_scene,list_scenes,ping_scene,set_scene_notifications,set_school,suggest_school" ]' "got '$FNS'"
COL=$(sql "select data_type from information_schema.columns where table_name='pings' and column_name='scene_id'" | J 'd[0].data_type')
check "pings.scene_id exists (uuid)" '[ "$COL" = "uuid" ]' "got '$COL'"
FK=$(sql "select count(*) as n from pg_constraint where conname='profiles_school_fkey'" | J 'd[0].n')
check "profiles.school FK to schools dropped (mirror column)" '[ "$FK" = 0 ]' "got $FK"

echo "== migration: schools → scenes, profiles.school → scene_members"
M=$(sql "select (select count(*) from schools) as schools, (select count(*) from schools sc where not exists (select 1 from scenes s where s.slug = sc.slug)) as missing, (select count(*) from schools sc join scenes s on s.slug = sc.slug where s.pending <> sc.pending and not (sc.pending and s.member_count >= 3)) as wrong, (select count(*) from profiles where school is not null) as with_school, (select count(*) from profiles p join scenes s on s.slug = p.school join scene_members m on m.scene_id = s.id and m.user_id = p.id) as members, (select count(*) from scenes s where s.member_count <> (select count(*) from scene_members m where m.scene_id = s.id)) as stale")
echo "  $M"
check "every school row is a scene" '[ "$(echo "$M" | J 'd[0].missing')" = 0 ]' "$M"
check "pending state preserved" '[ "$(echo "$M" | J 'd[0].wrong')" = 0 ]' "$M"
check "every profile.school is a membership" '[ "$(echo "$M" | J 'd[0].with_school')" = "$(echo "$M" | J 'd[0].members')" ]' "$M"
check "member_count exact" '[ "$(echo "$M" | J 'd[0].stale')" = 0 ]' "$M"

echo "== users"
read -r U1 T1 <<<"$(mkuser u1)"; read -r U2 T2 <<<"$(mkuser u2)"; read -r U3 T3 <<<"$(mkuser u3)"
check "three email-confirmed users" '[ -n "$U1" ] && [ -n "$T1" ] && [ -n "$U2" ] && [ -n "$T2" ] && [ -n "$U3" ] && [ -n "$T3" ]' "u1=$U1 u2=$U2 u3=$U3"
P1=$(mkprofile "$U1" "$T1" "$TAG-1"); P2=$(mkprofile "$U2" "$T2" "$TAG-2"); P3=$(mkprofile "$U3" "$T3" "$TAG-3")
check "profiles inserted under RLS" '[ "$P1" = 201 ] && [ "$P2" = 201 ] && [ "$P3" = 201 ]' "http $P1 $P2 $P3"

echo "== create_scene as u1"
OUT=$(rpc create_scene "{\"p_name\":\"  Zilker   Test $TAG \",\"p_activity\":\"Pickleball\",\"p_place_hint\":\"Zilker Park\",\"p_zip\":\"78704\"}" "$T1")
check "returns 200 with the slug" '[ "$(code "$OUT")" = 200 ] && [ "$(body "$OUT")" = "\"$SLUG\"" ]' "http $(code "$OUT") body $(body "$OUT")"
ROW=$(sql "select pending, display_name, activity, city, region, member_count, created_by, approved_at from scenes where slug = '$SLUG'")
check "row pending, creator, member_count 1, zip → austin/tx" '[ "$(echo "$ROW" | J 'd[0].pending')" = true ] && [ "$(echo "$ROW" | J 'd[0].member_count')" = 1 ] && [ "$(echo "$ROW" | J 'd[0].city')" = austin ] && [ "$(echo "$ROW" | J 'd[0].created_by')" = "$U1" ]' "$ROW"
check "display_name keeps casing, collapses whitespace; activity lower-cased" '[ "$(echo "$ROW" | J 'd[0].display_name')" = "Zilker Test $TAG" ] && [ "$(echo "$ROW" | J 'd[0].activity')" = pickleball ]' "$ROW"
PS=$(sql "select school from profiles where id = '$U1'" | J 'd[0].school')
check "profiles.school mirror = new slug" '[ "$PS" = "$SLUG" ]' "got $PS"
OUT=$(rpc list_scenes '{}' "$T1"); C=$(code "$OUT"); V=$(body "$OUT" | J 'd.find(s=>s.slug==="'"$SLUG"'").joined')
check "list_scenes: creator sees own pending scene as joined" '[ "$C" = 200 ] && [ "$V" = true ]' "http $C joined=$V"
OUT=$(rpc list_scenes '{}' "$ANON"); C=$(code "$OUT"); V=$(body "$OUT" | J 'd.filter(s=>s.slug==="'"$SLUG"'").length')
check "list_scenes: anon does not see the pending scene" '[ "$C" = 200 ] && [ "$V" = 0 ]' "http $C rows=$V"
N=$(curl -s -m 60 "$URL/rest/v1/scenes?select=slug&slug=eq.$SLUG" -H "apikey: $ANON" -H "Authorization: Bearer $T2" | J 'd.length')
check "RLS: non-member cannot read the pending row" '[ "$N" = 0 ]' "got $N"

echo "== join → 3rd member auto-approves"
OUT=$(rpc join_scene "{\"p_slug\":\"$SLUG\"}" "$T2")
check "u2 joins (204)" '[ "$(code "$OUT")" = 204 ] || [ "$(code "$OUT")" = 200 ]' "http $(code "$OUT") $(body "$OUT")"
R=$(sql "select pending, member_count from scenes where slug = '$SLUG'")
check "member_count 2, still pending" '[ "$(echo "$R" | J 'd[0].member_count')" = 2 ] && [ "$(echo "$R" | J 'd[0].pending')" = true ]' "$R"
N=$(curl -s -m 60 "$URL/rest/v1/scene_members?select=user_id&scene_id=eq.$(sql "select id from scenes where slug='$SLUG'" | J 'd[0].id')" -H "apikey: $ANON" -H "Authorization: Bearer $T2" | J 'd.length')
check "RLS: member sees the scene's member list (2)" '[ "$N" = 2 ]' "got $N"
OUT=$(rpc join_scene "{\"p_slug\":\"$SLUG\"}" "$T3")
R=$(sql "select pending, member_count, approved_at from scenes where slug = '$SLUG'")
check "3rd join → member_count 3, pending=false, approved_at set" '[ "$(echo "$R" | J 'd[0].member_count')" = 3 ] && [ "$(echo "$R" | J 'd[0].pending')" = false ] && [ -n "$(echo "$R" | J 'd[0].approved_at')" ]' "$R"
N=$(curl -s -m 60 "$URL/rest/v1/scenes?select=slug&slug=eq.$SLUG" -H "apikey: $ANON" -H "Authorization: Bearer $ANON" | J 'd.length')
check "anon can now see the approved scene" '[ "$N" = 1 ]' "got $N"

echo "== mute + ping_scene"
OUT=$(rpc set_scene_notifications "{\"p_slug\":\"$SLUG\",\"p_enabled\":false}" "$T3")
check "u3 mutes the scene" '[ "$(code "$OUT")" = 204 ] || [ "$(code "$OUT")" = 200 ]' "http $(code "$OUT") $(body "$OUT")"
OUT=$(rpc ping_scene "{\"p_slug\":\"$SLUG\",\"p_msg\":\"u1 is at the courts\",\"p_verb\":\"is playing\"}" "$T1")
check "u1 pings the scene → 1 recipient (u2; u1 sender, u3 muted)" '[ "$(code "$OUT")" = 200 ] && [ "$(body "$OUT")" = 1 ]' "http $(code "$OUT") body $(body "$OUT")"
R=$(sql "select to_id, verb, msg from pings where scene_id = (select id from scenes where slug='$SLUG')")
check "pings row stamped with scene_id, to u2, verb/msg kept" '[ "$(echo "$R" | J 'd.length')" = 1 ] && [ "$(echo "$R" | J 'd[0].to_id')" = "$U2" ] && [ "$(echo "$R" | J 'd[0].verb')" = "is playing" ]' "$R"
N=$(curl -s -m 60 "$URL/rest/v1/pings?select=id,scene_id&to_id=eq.$U2" -H "apikey: $ANON" -H "Authorization: Bearer $T2" | J 'd.filter(p=>p.scene_id).length')
check "u2 reads the scene ping via RLS (scene_id visible to the client)" '[ "$N" = 1 ]' "got $N"
OUT=$(rpc ping_scene "{\"p_slug\":\"$SLUG\"}" "$T1")
check "second ping inside 10 min → 0 (throttled, no error)" '[ "$(code "$OUT")" = 200 ] && [ "$(body "$OUT")" = 0 ]' "http $(code "$OUT") body $(body "$OUT")"
OUT=$(rpc list_scenes '{"p_zip":"78701"}' "$T3"); V=$(body "$OUT" | J 'JSON.stringify((s=>s?[s.joined,s.notifications_enabled,s.pings_24h,s.near_rank]:null)(d.find(s=>s.slug==="'"$SLUG"'")))')
check "list_scenes: u3 sees joined=true, muted, pings_24h=1, near_rank=1 for zip 78701" '[ "$V" = "[true,false,1,1]" ]' "got $V"

echo "== validation + rate limit"
OUT=$(rpc create_scene '{"p_name":"other"}' "$T2"); check "reserved name rejected" '[ "$(code "$OUT")" != 200 ]' "http $(code "$OUT") $(body "$OUT")"
OUT=$(rpc create_scene '{"p_name":"x"}' "$T2"); check "1-char name rejected" '[ "$(code "$OUT")" != 200 ]' "http $(code "$OUT")"
OUT=$(rpc create_scene "{\"p_name\":\"Bad Zip $TAG\",\"p_zip\":\"1234\"}" "$T2"); check "4-digit zip rejected" '[ "$(code "$OUT")" != 200 ]' "http $(code "$OUT")"
OUT=$(rpc create_scene "{\"p_name\":\"Anon Scene $TAG\"}" "$ANON"); check "anon caller rejected" '[ "$(code "$OUT")" = 401 ] || [ "$(code "$OUT")" = 403 ] || [ "$(code "$OUT")" = 400 ]' "http $(code "$OUT")"
OUT=$(rpc create_scene "{\"p_name\":\"Rate Two $TAG\"}" "$T1"); C2=$(code "$OUT")
OUT=$(rpc create_scene "{\"p_name\":\"Rate Three $TAG\"}" "$T1"); C3=$(code "$OUT")
check "u1: 2nd and 3rd creates accepted" '[ "$C2" = 200 ] && [ "$C3" = 200 ]' "http $C2 $C3"
OUT=$(rpc create_scene "{\"p_name\":\"Rate Four $TAG\"}" "$T1")
check "u1: 4th create rejected with a rate-limit message" '[ "$(code "$OUT")" != 200 ] && body "$OUT" | grep -qi "rate limit"' "http $(code "$OUT") $(body "$OUT")"

echo "== legacy aliases (old client still loaded in a tab)"
OUT=$(rpc suggest_school "{\"p_name\":\"Legacy $TAG\"}" "$T2")
check "suggest_school returns the slug" '[ "$(code "$OUT")" = 200 ] && [ "$(body "$OUT")" = "\"legacy-$TAG\"" ]' "http $(code "$OUT") $(body "$OUT")"
R=$(sql "select (select count(*) from scenes where slug='legacy-$TAG' and pending) as sc, (select count(*) from schools where slug='legacy-$TAG') as sch, (select school from profiles where id='$U2') as mirror")
check "alias wrote a pending scene (not a school) and set the mirror" '[ "$(echo "$R" | J 'd[0].sc')" = 1 ] && [ "$(echo "$R" | J 'd[0].sch')" = 0 ] && [ "$(echo "$R" | J 'd[0].mirror')" = "legacy-$TAG" ]' "$R"
OUT=$(rpc set_school "{\"p_slug\":\"$SLUG\"}" "$T2")
R=$(sql "select school from profiles where id='$U2'" | J 'd[0].school')
check "set_school(slug) joins (mirror follows latest join)" '[ "$R" = "$SLUG" ]' "got $R"
OUT=$(rpc approve_school "{\"p_slug\":\"legacy-$TAG\"}" "$T2"); check "authenticated cannot approve via the alias" '[ "$(code "$OUT")" != 200 ] && [ "$(code "$OUT")" != 204 ]' "http $(code "$OUT")"
OUT=$(rpc approve_school "{\"p_slug\":\"legacy-$TAG\"}" "$SERVICE")
R=$(sql "select pending, approved_at from scenes where slug='legacy-$TAG'")
check "approve_school (service_role) approves the scene" '[ "$(echo "$R" | J 'd[0].pending')" = false ] && [ -n "$(echo "$R" | J 'd[0].approved_at')" ]' "$R"
SEEDED=$(curl -s -m 60 "$URL/rest/v1/schools?select=slug&pending=eq.false&order=slug" -H "apikey: $ANON" -H "Authorization: Bearer $ANON" | J 'd.map(x=>x.slug).join(",")')
for s in baylor texas-am ttu uh ut-austin; do
  check "old client read path: schools.$s still listed to anon" 'echo ",$SEEDED," | grep -q ",$s,"' "$SEEDED"
done
SEEDED2=$(curl -s -m 60 "$URL/rest/v1/rpc/list_scenes" -X POST -H "apikey: $ANON" -H "Authorization: Bearer $ANON" -H "Content-Type: application/json" -d '{}' | J 'd.map(x=>x.slug).join(",")')
for s in baylor texas-am ttu uh ut-austin; do
  check "new client: scene $s listed to anon" 'echo ",$SEEDED2," | grep -q ",$s,"' "$SEEDED2"
done

echo "== approve_scene from the SQL editor session (Ez's path) + leave"
R=$(sql "select approve_scene('rate-two-$TAG')")
P=$(sql "select pending from scenes where slug='rate-two-$TAG'" | J 'd[0].pending')
check "approve_scene works from a plain postgres session" '[ "$P" = false ]' "resp $R pending=$P"
R=$(sql "select approve_scene('no-such-scene-$TAG')"); check "approving an unknown slug raises" 'echo "$R" | grep -qi "unknown scene\|error"' "$R"
OUT=$(rpc leave_scene "{\"p_slug\":\"$SLUG\"}" "$T3")
R=$(sql "select member_count, pending from scenes where slug='$SLUG'")
check "leave → member_count 2, stays approved" '[ "$(echo "$R" | J 'd[0].member_count')" = 2 ] && [ "$(echo "$R" | J 'd[0].pending')" = false ]' "$R"
PS=$(sql "select school from profiles where id='$U3'" | J 'd[0].school')
check "mirror cleared when the last scene is left" '[ -z "$PS" ]' "got '$PS'"
DONE=1
