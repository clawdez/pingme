#!/usr/bin/env bash
# Behavioural dry-run of the friends/schools migration against a throwaway
# Supabase Postgres container (never the live project).
#   1. apply schema.sql (base tables) — errors tolerated for realtime/publication bits
#   2. apply the migration twice (proves idempotency)
#   3. run test/friends-schools.dryrun.sql: RLS + RPC checks as real auth users
# Usage: bash test/sql-dryrun.sh   (needs docker; image override: PINGME_PG_IMAGE)
set -euo pipefail
cd "$(dirname "$0")/.."
IMG="${PINGME_PG_IMAGE:-public.ecr.aws/supabase/postgres:17.6.1.141}"
NAME="pm-sql-dryrun-$$"
MIG=supabase/migrations/20260907_friends_and_schools.sql
SEED=supabase/migrations/20260908_seed_texas_schools.sql

docker run -d --rm --name "$NAME" -e POSTGRES_PASSWORD=postgres "$IMG" >/dev/null
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT

# The image runs init scripts then restarts Postgres; wait for the restart
# ("init process complete") before touching the DB, then for a live socket.
for i in $(seq 1 120); do
  if docker logs "$NAME" 2>&1 | grep -q "init process complete"; then break; fi
  sleep 1
done
for i in $(seq 1 60); do
  if docker exec "$NAME" psql -U postgres -Atc 'select 1' >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$NAME" psql -U postgres -Atc 'select 1' >/dev/null

psql_strict() { docker exec -i "$NAME" psql -U postgres -v ON_ERROR_STOP=1 -q -f - ; }
psql_loose()  { docker exec -i "$NAME" psql -U postgres -q -f - ; }

echo "== base schema (schema.sql, lenient)"
psql_loose < schema.sql 2>&1 | grep -E "ERROR" | sort | uniq -c || true

echo "== migration: first apply"
psql_strict < "$MIG"
echo "== migration: second apply (idempotency)"
psql_strict < "$MIG"
echo "== seed: first apply"
psql_strict < "$SEED"
echo "== seed: second apply (idempotency)"
psql_strict < "$SEED"
n=$(docker exec "$NAME" psql -U postgres -Atc "select count(*) from schools")
[ "$n" = "5" ] || { echo "SEED FAIL: expected 5 schools, got $n"; exit 1; }
echo "== seed: 5 schools present"

echo "== behavioural checks"
psql_strict < test/friends-schools.dryrun.sql 2>&1 | { grep -E "NOTICE|ERROR|PASSED|FAIL" || true; }
echo "SQL DRY-RUN OK"
