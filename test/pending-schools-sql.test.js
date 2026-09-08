'use strict';
// Static, self-contained checks over the pending-schools migration
// ("Other → type your school" + approval). Same pattern as
// friends-schools-sql.test.js: the live DB isn't reachable from CI, so prove
// the file's shape — idempotent DDL, RLS scoping, RPC hardening. Behavioural
// checks run in test/sql-dryrun.sh (docker) and test/pending-schools-live.sh.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('./helpers');

const FILE = path.join(ROOT, 'supabase', 'migrations', '20260909_pending_schools.sql');

function load() {
  assert.ok(fs.existsSync(FILE), 'supabase/migrations/20260909_pending_schools.sql');
  const sql = fs.readFileSync(FILE, 'utf8');
  return { sql, code: sql.replace(/--.*$/gm, '').toLowerCase() };
}
function fnBody(code, name) {
  const i = code.indexOf('create or replace function ' + name + '(');
  assert.ok(i >= 0, name + ' defined');
  return code.slice(i, code.indexOf('$$;', i) + 3);
}

test('schools.pending column is added idempotently, defaulting to approved', () => {
  const { code } = load();
  assert.match(code, /alter table schools add column if not exists pending boolean not null default false/);
  assert.match(code, /grant select \(pending\) on schools to anon, authenticated/);
});

test('all DDL is re-runnable', () => {
  const { code } = load();
  for (const s of code.match(/create table\b[^(]*/g) || []) assert.match(s, /if not exists/, s);
  for (const s of code.match(/create (unique )?index\b[^(]*/g) || []) assert.match(s, /if not exists/, s);
  for (const s of code.match(/alter table \w+ add column\b[^;]*/g) || []) assert.match(s, /if not exists/, s);
  assert.equal((code.match(/create function/g) || []).length, 0, 'use create or replace function');
  const created = [...code.matchAll(/create policy "([^"]+)"\s+on (\w+)/g)];
  assert.ok(created.length >= 1, 'expected at least the schools select policy');
  for (const [, name, tbl] of created) {
    assert.ok(code.includes(`drop policy if exists "${name}" on ${tbl}`), `policy "${name}" on ${tbl}`);
  }
  assert.doesNotMatch(code, /\b(drop table|truncate|delete from schools|delete from profiles)\b/, 'never destructive');
});

test('schools read policy: approved rows for everyone, own pending row for the submitter', () => {
  const { code } = load();
  const m = code.match(/create policy "anyone can view schools"\s+on schools for select\s+using \(([\s\S]*?)\);/);
  assert.ok(m, 'replaces the "Anyone can view schools" policy');
  assert.match(m[1], /pending = false/);
  assert.match(m[1], /slug = /, 'own pending school visible via slug match');
  assert.doesNotMatch(m[1], /using\s*\(\s*true\s*\)/);
  assert.doesNotMatch(code, /on schools for (insert|update|delete)/, 'schools stay client-read-only');
});

test('suggestion audit table: RLS on, only service_role can read', () => {
  const { code } = load();
  assert.match(code, /create table if not exists school_suggestions \(/);
  assert.match(code, /school_suggestions[\s\S]*user_id\s+uuid not null references (auth\.users|profiles)\(id\) on delete cascade/);
  assert.match(code, /school_suggestions[\s\S]*created_at\s+timestamptz not null default now\(\)/);
  assert.match(code, /alter table school_suggestions enable row level security/);
  assert.match(code, /create index if not exists \w+ on school_suggestions\s*\(user_id, created_at/);
  assert.match(code, /revoke all on school_suggestions from anon, authenticated, public/);
  assert.match(code, /grant select on school_suggestions to service_role/);
  assert.doesNotMatch(code, /grant [^;]*on school_suggestions to (anon|authenticated)/);
});

test('suggest_school: security definer, auth required, normalised slug, reserved names, on-conflict join', () => {
  const { code } = load();
  const body = fnBody(code, 'suggest_school');
  assert.match(body, /returns text/);
  assert.match(body, /security definer/);
  assert.match(body, /set search_path = public/);
  assert.match(body, /if (me|auth\.uid\(\)) is null then raise exception/, 'anon rejected');
  assert.match(body, /char_length\(\w+\) (not )?between 2 and 80/, 'length check on trimmed input');
  assert.match(body, /regexp_replace\([\s\S]*'\[\^a-z0-9\]\+'[\s\S]*'-'[\s\S]*'g'\)/, 'non-alnum runs → -');
  assert.match(body, /btrim\([^;]*'-'\)/, 'leading/trailing dashes stripped');
  assert.match(body, /'\^\[a-z0-9-\]\{2,32\}\$'/, 'final slug must satisfy the schools.slug check');
  assert.match(body, /raise exception 'invalid school name'/);
  assert.match(body, /in \('other', 'none', 'admin', 'test'\)/, 'reserved slugs');
  assert.match(body, /insert into schools \(slug, display_name, pending\)[\s\S]*on conflict \(slug\) do nothing/);
  assert.match(body, /pending\)[\s\S]*values \([^;]*true\)/, 'new rows are pending');
  assert.match(body, /update profiles\s+set school = \w+[\s\S]*where id = (me|auth\.uid\(\))/, 'caller assigned');
  assert.match(body, /return \w+;/);
});

test('suggest_school rate limit: 3 per user per 24h, tracked in school_suggestions', () => {
  const { code } = load();
  const body = fnBody(code, 'suggest_school');
  assert.match(body, /select count\(\*\)[\s\S]*from school_suggestions[\s\S]*where user_id = (me|auth\.uid\(\))[\s\S]*created_at > now\(\) - interval '24 hours'/);
  assert.match(body, />= 3 then raise exception 'rate limit exceeded/);
  assert.match(body, /insert into school_suggestions \(user_id, slug\)/);
});

test('suggest_school grants: authenticated yes, anon/public no', () => {
  const { code } = load();
  assert.match(code, /revoke all on function suggest_school\(text\) from public, anon/);
  assert.match(code, /grant\s+execute on function suggest_school\(text\) to authenticated/);
});

test('approve_school: admin-only (service_role JWT or the postgres SQL-editor session), flips pending, raises on unknown slug', () => {
  const { code } = load();
  const body = fnBody(code, 'approve_school');
  assert.match(body, /returns void/);
  assert.match(body, /security definer/);
  assert.match(body, /set search_path = public/);
  assert.match(body, /auth\.role\(\)[^;]*'service_role'/, 'service_role JWT allowed');
  assert.match(body, /session_user[^;]*'postgres'/, 'SQL editor (postgres session) allowed — Ez\'s admin knob');
  assert.doesNotMatch(body, /current_user/, 'current_user is the definer inside security definer — must use session_user');
  assert.match(body, /update schools set pending = false where slug = /);
  assert.match(body, /if not found then raise exception/);
  assert.match(code, /revoke all on function approve_school\(text\) from public, anon, authenticated/);
  assert.match(code, /grant\s+execute on function approve_school\(text\) to service_role/);
  assert.doesNotMatch(code, /grant\s+execute on function approve_school\(text\) to authenticated/);
});

test('existing seeded schools are untouched (no update to their rows, no reseed)', () => {
  const { code } = load();
  assert.doesNotMatch(code, /update schools set pending = true/);
  assert.doesNotMatch(code, /insert into schools \(slug, display_name, color, default_city\) values/, 'seeding lives in 20260908');
});

test('no keys or secrets in the migration', () => {
  const { sql } = load();
  assert.doesNotMatch(sql, /eyJ[a-zA-Z0-9_-]{20,}/, 'JWT-looking string');
  assert.doesNotMatch(sql, /sk_live|supabase\.co/i);
});
