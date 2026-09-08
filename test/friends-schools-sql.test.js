'use strict';
// Static, self-contained checks over the friends + schools migration. The live
// DB can't be reached from CI, so this proves the file's shape: idempotent
// DDL, RLS on every new table with party-scoped policies, RPC hardening.
// Behavioural checks against a real Postgres live in test/sql-dryrun.sh.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('./helpers');

const FILE = path.join(ROOT, 'supabase', 'migrations', '20260907_friends_and_schools.sql');
const sql = fs.readFileSync(FILE, 'utf8');
const code = sql.replace(/--.*$/gm, '').toLowerCase(); // comments stripped

test('creates schools + friendships idempotently with RLS enabled', () => {
  assert.match(code, /create table if not exists schools/);
  assert.match(code, /create table if not exists friendships/);
  assert.match(code, /alter table schools enable row level security/);
  assert.match(code, /alter table friendships enable row level security/);
});

test('all DDL is re-runnable: if-not-exists tables/indexes, create-or-replace functions, drop-before-create triggers', () => {
  for (const s of code.match(/create table\b[^(]*/g) || []) assert.match(s, /if not exists/, s);
  for (const s of code.match(/create (unique )?index\b[^(]*/g) || []) assert.match(s, /if not exists/, s);
  assert.equal((code.match(/create function/g) || []).length, 0, 'use create or replace function');
  for (const m of code.matchAll(/create trigger (\w+)/g)) {
    assert.ok(code.includes('drop trigger if exists ' + m[1]), 'trigger ' + m[1] + ' must be dropped first');
  }
  for (const s of code.match(/alter table \w+ add column\b[^;]*/g) || []) assert.match(s, /if not exists/, s);
  assert.match(code, /insert into schools[\s\S]*?on conflict \(slug\) do nothing/);
});

test('every policy is dropped before it is created', () => {
  const created = [...code.matchAll(/create policy "([^"]+)"\s+on (\w+)/g)];
  assert.ok(created.length >= 5, 'expected policies for schools + friendships');
  for (const [, name, tbl] of created) {
    assert.ok(code.includes(`drop policy if exists "${name}" on ${tbl}`), `policy "${name}" on ${tbl}`);
  }
});

test('friendships policies are party-scoped and only the recipient can accept', () => {
  const start = code.indexOf('create table if not exists friendships');
  const end = code.indexOf('create or replace function friendships_freeze_parties');
  const block = code.slice(start, end);
  const pols = [...block.matchAll(/create policy "[^"]+"[\s\S]*?;/g)].map(m => m[0]);
  assert.equal(pols.length, 4, 'select/insert/update/delete policies');
  for (const p of pols) {
    assert.doesNotMatch(p, /using\s*\(\s*true\s*\)/, 'no using(true) on friendships');
    assert.match(p, /auth\.uid\(\) = user_a or auth\.uid\(\) = user_b/, 'scoped to the two parties');
  }
  const upd = pols.find(p => /for update/.test(p));
  assert.match(upd, /using[\s\S]*auth\.uid\(\) <> requested_by/, 'requester cannot accept their own request');
  assert.match(upd, /with check[\s\S]*status in \('accepted', 'blocked'\)/);
  const ins = pols.find(p => /for insert/.test(p));
  assert.match(ins, /auth\.uid\(\) = requested_by/);
  assert.match(ins, /status = 'pending'/);
  // party columns frozen so an update can't rewrite the pair
  assert.match(code, /new\.user_a <> old\.user_a or new\.user_b <> old\.user_b or new\.requested_by <> old\.requested_by/);
});

test('friendship pair is stored canonically (least uuid first, one row per pair)', () => {
  assert.match(code, /primary key \(user_a, user_b\)/);
  assert.match(code, /check \(user_a < user_b\)/);
  assert.match(code, /check \(status in \('pending', 'accepted', 'blocked'\)\)/);
  assert.match(code, /revoke all on friendships from anon, public/);
});

test('schools: TTU seeded as launch cohort with Lubbock default city, readable by all', () => {
  assert.match(code, /\('ttu', 'texas tech university', '#[0-9a-f]{6}', 'lubbock'\)/);
  assert.match(code, /create policy "anyone can view schools"\s+on schools for select using \(true\)/);
  assert.match(code, /grant select on schools to anon, authenticated/);
  assert.doesNotMatch(code, /on schools for (insert|update|delete)/, 'schools are not client-writable');
});

test('profiles.school column is indexed, FK-backed and granted for read', () => {
  assert.match(code, /alter table profiles add column if not exists school text references schools\(slug\)/);
  assert.match(code, /create index if not exists idx_profiles_school on profiles\(school\)/);
  assert.match(code, /grant select \(school\) on profiles to anon, authenticated/);
});

test('every RPC is security definer with pinned search_path, anon revoked, authenticated granted', () => {
  const fns = ['set_school', 'send_friend_request', 'respond_friend_request', 'remove_friend',
    'list_friendships', 'search_players', 'ping_friends', 'broadcast_playing', 'are_friends'];
  for (const f of fns) {
    const i = code.indexOf('create or replace function ' + f + '(');
    assert.ok(i >= 0, f + ' defined');
    const body = code.slice(i, code.indexOf('$$;', i) + 3);
    assert.match(body, /security definer/, f + ' security definer');
    assert.match(body, /set search_path = public/, f + ' pinned search_path');
    assert.match(code, new RegExp('revoke all on function ' + f + '\\([^)]*\\) from public, anon'), f + ' revoked from anon');
    assert.match(code, new RegExp('grant\\s+execute on function ' + f + '\\([^)]*\\) to authenticated'), f + ' granted');
  }
});

test('mutating RPCs refuse anonymous callers', () => {
  for (const f of ['send_friend_request', 'respond_friend_request', 'remove_friend', 'ping_friends', 'broadcast_playing']) {
    const i = code.indexOf('create or replace function ' + f + '(');
    const body = code.slice(i, code.indexOf('$$;', i));
    assert.match(body, /if me is null then raise exception/, f);
  }
});

test('group ping only reaches accepted friends and bypasses the per-row rate limit safely', () => {
  const i = code.indexOf('create or replace function ping_friends(');
  const body = code.slice(i, code.indexOf('$$;', i));
  assert.match(body, /are_friends\(me, t\.id\)/, 'non-friends are dropped');
  assert.match(body, /t\.id <> me/, 'never pings self');
  assert.match(body, /set_config\('pingme\.skip_rate_limit', '1', true\)/, 'transaction-local skip flag');
  assert.match(body, /cardinality\(p_to\) > 50/, 'batch cap');
  assert.match(body, /count\(distinct created_at\)/, 'batch-level throttle');
  assert.match(body, /'hey i want to play'/, 'default line');
  // the trigger honours the flag but still limits plain inserts
  const t = code.indexOf('create or replace function check_ping_rate_limit(');
  const tb = code.slice(t, code.indexOf('$$;', t));
  assert.match(tb, /current_setting\('pingme\.skip_rate_limit', true\) = '1'/);
  assert.match(tb, /recent_count >= 5/);
});

test('broadcast is throttled to once per hour per user', () => {
  const i = code.indexOf('create or replace function broadcast_playing(');
  const body = code.slice(i, code.indexOf('$$;', i));
  assert.match(body, /last_friend_broadcast_at > now\(\) - interval '1 hour'/);
  assert.match(body, /return 0;/, 'throttled call is a no-op, not an error');
  assert.match(body, /f\.status = 'accepted'/);
  assert.match(code, /add column if not exists last_friend_broadcast_at timestamptz/);
});

test('search escapes ilike wildcards and never returns the caller', () => {
  const i = code.indexOf('create or replace function search_players(');
  const body = code.slice(i, code.indexOf('$$;', i));
  assert.match(body, /replace\(replace\(replace\(q, '\\', '\\\\'\), '%', '\\%'\), '_', '\\_'\)/);
  assert.match(body, /p\.id <> auth\.uid\(\)/);
  assert.match(body, /p_school is null or p\.school = lower\(trim\(p_school\)\)/);
});

test('no keys or secrets in the migration', () => {
  assert.doesNotMatch(sql, /eyJ[a-zA-Z0-9_-]{20,}/, 'JWT-looking string');
  assert.doesNotMatch(sql, /service_role|sk_live|supabase\.co/i);
});
