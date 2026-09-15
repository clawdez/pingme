'use strict';
// Static, self-contained checks over the schools → scenes migration. Same
// pattern as pending-schools-sql.test.js: the live DB isn't reachable from CI,
// so prove the file's shape — idempotent DDL, RLS scoping, RPC hardening, the
// data copy from schools/profiles, and the one-release aliases. Behavioural
// checks run in test/sql-dryrun.sh (docker) and test/scenes-live.sh.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('./helpers');

const FILE = path.join(ROOT, 'supabase', 'migrations', '20260911_scenes_from_schools.sql');

function load() {
  assert.ok(fs.existsSync(FILE), 'supabase/migrations/20260911_scenes_from_schools.sql');
  const sql = fs.readFileSync(FILE, 'utf8');
  return { sql, code: sql.replace(/--.*$/gm, '').toLowerCase() };
}
function fnBody(code, name) {
  const i = code.indexOf('create or replace function ' + name + '(');
  assert.ok(i >= 0, name + ' defined');
  return code.slice(i, code.indexOf('$$;', i) + 3);
}
function tableDef(code, name) {
  const m = code.match(new RegExp('create table if not exists ' + name + ' \\(([\\s\\S]*?)\\);'));
  assert.ok(m, name + ' table');
  return m[1];
}

/* ── tables ── */

test('scenes table: uuid id, unique slug, pending by default, member_count, approved_at, place fields', () => {
  const { code } = load();
  const t = tableDef(code, 'scenes');
  assert.match(t, /id\s+uuid primary key default gen_random_uuid\(\)/);
  assert.match(t, /slug\s+text unique not null check \(slug ~ '\^\[a-z0-9-\]\{2,32\}\$'\)/);
  assert.match(t, /display_name\s+text not null check \(char_length\(display_name\) between 2 and 80\)/);
  for (const col of ['activity', 'place_hint', 'zip', 'city', 'region']) assert.match(t, new RegExp('\\b' + col + '\\s+text'), col);
  assert.match(t, /created_by\s+uuid references auth\.users\(id\)/);
  assert.match(t, /pending\s+boolean not null default true/);
  assert.match(t, /member_count\s+int not null default 0/);
  assert.match(t, /approved_at\s+timestamptz/);
  assert.match(t, /created_at\s+timestamptz not null default now\(\)/);
  assert.match(code, /create index if not exists scenes_slug_idx on scenes\(slug\)/);
  assert.match(code, /create index if not exists scenes_zip_idx on scenes\(zip\) where zip is not null/);
  assert.match(code, /create index if not exists scenes_city_idx on scenes\(city\) where city is not null/);
});

test('scene_members table: composite key, cascade both ways, notifications on by default', () => {
  const { code } = load();
  const t = tableDef(code, 'scene_members');
  assert.match(t, /scene_id\s+uuid not null references scenes\(id\) on delete cascade/);
  assert.match(t, /user_id\s+uuid not null references auth\.users\(id\) on delete cascade/);
  assert.match(t, /joined_at\s+timestamptz not null default now\(\)/);
  assert.match(t, /notifications_enabled\s+boolean not null default true/);
  assert.match(t, /primary key \(scene_id, user_id\)/);
  assert.match(code, /create index if not exists scene_members_user_idx on scene_members\(user_id\)/);
});

test('pings gain a nullable scene_id so scene pings can be traced and trended', () => {
  const { code } = load();
  assert.match(code, /alter table pings add column if not exists scene_id uuid references scenes\(id\) on delete set null/);
  assert.match(code, /create index if not exists pings_scene_created_idx on pings\(scene_id, created_at desc\) where scene_id is not null/);
});

test('all DDL is re-runnable and never destructive', () => {
  const { code } = load();
  for (const s of code.match(/create table\b[^(]*/g) || []) assert.match(s, /if not exists/, s);
  for (const s of code.match(/create (unique )?index\b[^(]*/g) || []) assert.match(s, /if not exists/, s);
  for (const s of code.match(/alter table \w+ add column\b[^;]*/g) || []) assert.match(s, /if not exists/, s);
  for (const s of code.match(/alter table \w+ drop constraint\b[^;]*/g) || []) assert.match(s, /if exists/, s);
  assert.equal((code.match(/create function/g) || []).length, 0, 'use create or replace function');
  for (const s of code.match(/create trigger (\w+)/g) || []) {
    const name = s.split(' ')[2];
    assert.ok(code.includes('drop trigger if exists ' + name), 'trigger ' + name + ' dropped before create');
  }
  const created = [...code.matchAll(/create policy "([^"]+)"\s+on (\w+)/g)];
  assert.ok(created.length >= 3, 'expected policies on scenes, scene_members, zip_prefixes');
  for (const [, name, tbl] of created) {
    assert.ok(code.includes(`drop policy if exists "${name}" on ${tbl}`), `policy "${name}" on ${tbl}`);
  }
  assert.doesNotMatch(code, /\b(drop table|truncate|delete from schools|delete from profiles|delete from scenes)\b/, 'never destructive');
  assert.doesNotMatch(code, /drop function/, 'old RPC names stay callable (aliases), nothing is dropped');
});

/* ── migration of existing data ── */

test('every schools row is copied into scenes with the same slug and pending state (schools kept)', () => {
  const { code, sql } = load();
  const m = code.match(/insert into scenes \(slug, display_name, color, city, pending, approved_at\)\s+select[\s\S]*?from schools[\s\S]*?on conflict \(slug\) do nothing/);
  assert.ok(m, 'copy schools → scenes, keyed on slug');
  assert.match(m[0], /s\.slug, s\.display_name, s\.color, s\.default_city, s\.pending/);
  assert.match(m[0], /case when s\.pending then null else now\(\) end/, 'approved rows get approved_at');
  assert.doesNotMatch(code, /drop table if exists schools/);
  assert.match(sql, /deprecated/i, 'schools deprecation noted for the follow-up drop');
});

test('every profile.school membership is copied into scene_members', () => {
  const { code } = load();
  const m = code.match(/insert into scene_members \(scene_id, user_id\)\s+select s\.id, p\.id\s+from profiles p\s+join scenes s on s\.slug = p\.school\s+where p\.school is not null\s+on conflict do nothing/);
  assert.ok(m, 'profiles.school → scene_members');
});

test('school_suggestions rate-limit history carries over to scene_suggestions', () => {
  const { code } = load();
  assert.match(code, /create table if not exists scene_suggestions \(/);
  assert.match(code, /insert into scene_suggestions \(user_id, slug, created_at\)\s+select [\s\S]*?from school_suggestions[\s\S]*?not exists/);
  assert.match(code, /revoke all on scene_suggestions from anon, authenticated, public/);
  assert.match(code, /grant select on scene_suggestions to service_role/);
});

test('profiles.school becomes a plain mirror column: FK to schools dropped, column kept', () => {
  const { code, sql } = load();
  assert.match(code, /alter table profiles drop constraint if exists profiles_school_fkey/);
  assert.doesNotMatch(code, /alter table profiles drop column/);
  assert.match(sql, /mirror/i, 'documented as the most-recently-joined scene mirror');
});

/* ── member_count + auto-approve trigger ── */

test('scene_members trigger keeps member_count exact and auto-approves at 3 members', () => {
  const { code } = load();
  const body = fnBody(code, 'scene_members_sync');
  assert.match(body, /returns trigger/);
  assert.match(body, /update scenes[\s\S]*set member_count = \(select count\(\*\) from scene_members/, 'recount, never +1/-1 drift');
  assert.match(body, /member_count >= 3/);
  assert.match(body, /pending = false/);
  assert.match(body, /approved_at = now\(\)/);
  assert.match(code, /create trigger scene_members_sync\s+after insert or delete on scene_members\s+for each row execute function scene_members_sync\(\)/);
});

/* ── RLS ── */

test('scenes read policy: approved rows for everyone, pending rows only for the creator and members', () => {
  const { code } = load();
  assert.match(code, /alter table scenes enable row level security/);
  const m = code.match(/create policy "anyone can view approved scenes"\s+on scenes for select\s+using \(([\s\S]*?)\);/);
  assert.ok(m, 'scenes select policy');
  assert.match(m[1], /pending = false/);
  assert.match(m[1], /created_by = auth\.uid\(\)/);
  assert.match(m[1], /is_scene_member\(id\)/);
  assert.doesNotMatch(code, /on scenes for (insert|update|delete)/, 'scenes stay client-read-only (RPCs write)');
  assert.match(code, /grant select on scenes to anon, authenticated/);
});

test('scene_members read policy: own rows + members of my scenes, via a security-definer helper (no self-recursion)', () => {
  const { code } = load();
  assert.match(code, /alter table scene_members enable row level security/);
  const m = code.match(/create policy "members see their scenes' members"\s+on scene_members for select\s+using \(([\s\S]*?)\);/);
  assert.ok(m, 'scene_members select policy');
  assert.match(m[1], /user_id = auth\.uid\(\)/);
  assert.match(m[1], /scene_id in \(select my_scene_ids\(\)\)/);
  const helper = fnBody(code, 'my_scene_ids');
  assert.match(helper, /returns setof uuid/);
  assert.match(helper, /security definer/);
  assert.match(helper, /stable/);
  assert.match(fnBody(code, 'is_scene_member'), /security definer/);
  assert.doesNotMatch(code, /on scene_members for (insert|update|delete)/);
  assert.match(code, /revoke all on scene_members from anon, public/);
  assert.match(code, /grant select on scene_members to authenticated/);
});

/* ── RPCs ── */

test('create_scene: auth required, normalised slug, reserved names, on-conflict join, creator auto-joined, pending', () => {
  const { code } = load();
  const body = fnBody(code, 'create_scene');
  assert.match(body, /create or replace function create_scene\(p_name text, p_activity text default null, p_place_hint text default null, p_zip text default null\)/);
  assert.match(body, /returns text/);
  assert.match(body, /security definer/);
  assert.match(body, /set search_path = public/);
  assert.match(body, /if (me|auth\.uid\(\)) is null then raise exception/, 'anon rejected');
  assert.match(body, /char_length\(\w+\) not between 2 and 80/, 'name length on trimmed input');
  assert.match(body, /_pm_scene_slug\(/, 'shared slug normaliser');
  assert.match(body, /insert into scenes \(slug, display_name, activity, place_hint, zip, city, region, created_by, pending\)[\s\S]*on conflict \(slug\) do nothing/);
  assert.match(body, /pending\)[\s\S]*values \([^;]*true\)/, 'new rows are pending');
  assert.match(body, /insert into scene_members \(scene_id, user_id, joined_at\) values \(\w+, me, clock_timestamp\(\)\) on conflict do nothing/, 'creator auto-joined, wall-clock stamped');
  assert.match(body, /_pm_sync_primary_scene\(me\)/, 'profiles.school mirror updated');
  assert.match(body, /return \w+;/);
  const slug = fnBody(code, '_pm_scene_slug');
  assert.match(slug, /regexp_replace\([\s\S]*'\[\^a-z0-9\]\+'[\s\S]*'-'[\s\S]*'g'\)/, 'non-alnum runs → -');
  assert.match(slug, /left\(\w+, 32\)/, 'truncated at 32');
  assert.match(slug, /btrim\([^;]*'-'\)/, 'outer dashes stripped (also after truncation)');
  assert.match(slug, /'\^\[a-z0-9-\]\{2,32\}\$'/);
  assert.match(slug, /in \('other', 'none', 'admin', 'test', 'scenes', 'scene'\)/, 'reserved slugs');
  assert.match(slug, /raise exception 'invalid scene name'/);
});

test('create_scene rate limit: 3 per user per 24h, tracked in scene_suggestions', () => {
  const { code } = load();
  const body = fnBody(code, 'create_scene');
  assert.match(body, /select count\(\*\)[\s\S]*from scene_suggestions[\s\S]*where user_id = me[\s\S]*created_at > now\(\) - interval '24 hours'/);
  assert.match(body, />= 3 then raise exception 'rate limit exceeded/);
  assert.match(body, /insert into scene_suggestions \(user_id, slug\)/);
});

test('create_scene resolves zip → city/region through the zip_prefixes reference table', () => {
  const { code } = load();
  assert.match(code, /create table if not exists zip_prefixes \(/);
  assert.match(code, /prefix\s+text primary key check \(prefix ~ '\^\[0-9\]\{3\}\$'\)/);
  assert.match(code, /insert into zip_prefixes \(prefix, city, region\) values[\s\S]*\('787', 'austin', 'tx'\)[\s\S]*\('794', 'lubbock', 'tx'\)[\s\S]*on conflict \(prefix\) do nothing/);
  assert.match(code, /grant select on zip_prefixes to anon, authenticated/);
  const body = fnBody(code, 'create_scene');
  assert.match(body, /p_zip[\s\S]*'\^\[0-9\]\{5\}\$'/, 'zip validated as 5 digits');
  assert.match(body, /from zip_prefixes[\s\S]*left\(\w+, 3\)/, 'resolved by 3-digit prefix');
});

test('join_scene / leave_scene: auth required, membership rows only, mirror kept in sync', () => {
  const { code } = load();
  const j = fnBody(code, 'join_scene');
  assert.match(j, /create or replace function join_scene\(p_slug text\)/);
  assert.match(j, /returns void/);
  assert.match(j, /security definer/);
  assert.match(j, /if me is null then raise exception/);
  assert.match(j, /raise exception 'unknown scene'/);
  assert.match(j, /insert into scene_members \(scene_id, user_id, joined_at\) values \(\w+, me, clock_timestamp\(\)\) on conflict do nothing/, 'wall-clock stamped so the mirror always follows the latest join');
  assert.match(j, /_pm_sync_primary_scene\(me\)/);
  const l = fnBody(code, 'leave_scene');
  assert.match(l, /create or replace function leave_scene\(p_slug text\)/);
  assert.match(l, /delete from scene_members[\s\S]*where[\s\S]*user_id = me/);
  assert.match(l, /_pm_sync_primary_scene\(me\)/);
  const m = fnBody(code, '_pm_sync_primary_scene');
  assert.match(m, /update profiles[\s\S]*set school = \([\s\S]*from scene_members[\s\S]*order by [\s\S]*joined_at desc[\s\S]*limit 1\s*\)/, 'school column mirrors the most recently joined scene (null when none)');
});

test('set_scene_notifications: per-scene mute on the caller\'s own membership only', () => {
  const { code } = load();
  const body = fnBody(code, 'set_scene_notifications');
  assert.match(body, /create or replace function set_scene_notifications\(p_slug text, p_enabled boolean\)/);
  assert.match(body, /update scene_members[\s\S]*set notifications_enabled = coalesce\(p_enabled, true\)[\s\S]*user_id = me/);
  assert.match(body, /if not found then raise exception 'not a member'/);
});

test('ping_scene: fans out to members minus sender minus muted, stamps scene_id, throttled, bypasses per-row limit safely', () => {
  const { code } = load();
  const body = fnBody(code, 'ping_scene');
  assert.match(body, /create or replace function ping_scene\(p_slug text, p_msg text default null, p_verb text default 'is playing'\)/);
  assert.match(body, /returns int/);
  assert.match(body, /security definer/);
  assert.match(body, /if me is null then raise exception/);
  assert.match(body, /p_verb not in \('is playing', 'is down to play'\)/, 'verb whitelist (never system)');
  assert.match(body, /raise exception 'join the scene first'/, 'must be a member to ping it');
  assert.match(body, /interval '10 minutes'[\s\S]*return 0/, 'per-scene throttle is a no-op, not an error');
  assert.match(body, /set_config\('pingme\.skip_rate_limit', '1', true\)/);
  assert.match(body, /insert into pings \(from_id, to_id, verb, msg, unread, scene_id\)[\s\S]*from scene_members m[\s\S]*m\.user_id <> me[\s\S]*m\.notifications_enabled/);
  assert.match(body, /get diagnostics sent = row_count/);
});

test('list_scenes: visibility applied inside, joined/mute flags, 24h ping counts, zip proximity rank', () => {
  const { code } = load();
  const body = fnBody(code, 'list_scenes');
  assert.match(body, /create or replace function list_scenes\(p_zip text default null, p_q text default null\)/);
  assert.match(body, /returns table \([\s\S]*joined\s+boolean[\s\S]*notifications_enabled\s+boolean[\s\S]*pings_24h\s+int[\s\S]*last_ping_at\s+timestamptz[\s\S]*near_rank\s+int/);
  assert.match(body, /security definer/);
  assert.match(body, /s\.pending = false or s\.created_by = auth\.uid\(\) or/, 'pending rows only for creator/members');
  assert.match(body, /interval '24 hours'/);
  assert.match(body, /left\(s\.zip, 3\)/, 'zip3 prefix proximity');
  assert.match(code, /grant\s+execute on function list_scenes\(text, text\) to anon, authenticated/);
});

test('approve_scene: admin-only (service_role JWT or postgres session), sets approved_at, raises on unknown slug', () => {
  const { code } = load();
  const body = fnBody(code, 'approve_scene');
  assert.match(body, /auth\.role\(\)[^;]*'service_role'/);
  assert.match(body, /session_user[^;]*'postgres'/);
  assert.doesNotMatch(body, /current_user/);
  assert.match(body, /update scenes set pending = false, approved_at = coalesce\(approved_at, now\(\)\) where slug = /);
  assert.match(body, /if not found then raise exception 'unknown scene'/);
  assert.match(code, /revoke all on function approve_scene\(text\) from public, anon, authenticated/);
  assert.match(code, /grant\s+execute on function approve_scene\(text\) to service_role/);
});

test('grants: every user RPC is authenticated-only; anon/public revoked', () => {
  const { code } = load();
  for (const sig of ['create_scene(text, text, text, text)', 'join_scene(text)', 'leave_scene(text)', 'set_scene_notifications(text, boolean)', 'ping_scene(text, text, text)']) {
    const esc = sig.replace(/[()]/g, '\\$&');
    assert.match(code, new RegExp('revoke all on function ' + esc + ' from public, anon'), 'revoke ' + sig);
    assert.match(code, new RegExp('grant\\s+execute on function ' + esc + ' to authenticated'), 'grant ' + sig);
  }
  for (const name of ['create_scene', 'join_scene', 'leave_scene', 'set_scene_notifications', 'ping_scene', 'list_scenes', 'approve_scene', '_pm_sync_primary_scene', 'suggest_school', 'set_school', 'approve_school']) {
    assert.match(fnBody(code, name), /set search_path = public/, name + ' pins search_path');
  }
});

/* ── one-release aliases ── */

test('suggest_school / set_school / approve_school stay callable as thin aliases over the scene RPCs', () => {
  const { code, sql } = load();
  const s = fnBody(code, 'suggest_school');
  assert.match(s, /create or replace function suggest_school\(p_name text\)\s+returns text/);
  assert.match(s, /return create_scene\(p_name\)/);
  assert.doesNotMatch(s, /insert into schools/, 'writes land in scenes, never schools');
  const st = fnBody(code, 'set_school');
  assert.match(st, /create or replace function set_school\(p_slug text\)\s+returns void/);
  assert.match(st, /perform join_scene\(p_slug\)/);
  assert.match(st, /update profiles set school = lower\(trim\(p_slug\)\) where id = me/, 'set_school(slug) always makes that slug the mirror (old-client semantics)');
  assert.match(st, /perform leave_scene\(/, 'set_school(null) = leave the mirrored scene');
  const a = fnBody(code, 'approve_school');
  assert.match(a, /perform approve_scene\(p_slug\)/);
  assert.match(a, /update schools set pending = false/, 'legacy table kept consistent for old clients');
  assert.match(sql, /one release/i, 'alias lifetime documented');
  assert.match(code, /grant\s+execute on function suggest_school\(text\) to authenticated/);
  assert.match(code, /grant\s+execute on function set_school\(text\) to authenticated/);
  assert.match(code, /grant\s+execute on function approve_school\(text\) to service_role/);
});

test('rollback recipe is documented and no keys or secrets are in the migration', () => {
  const { sql } = load();
  assert.match(sql, /rollback/i);
  assert.doesNotMatch(sql, /eyJ[a-zA-Z0-9_-]{20,}/, 'JWT-looking string');
  assert.doesNotMatch(sql, /sk_live|sbp_|re_[a-z0-9]{10,}|supabase\.co/i);
});
