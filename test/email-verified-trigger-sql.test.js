'use strict';
// Static, self-contained checks over the email-required-signup migration. A
// profile inserted by an email-confirmed auth user must be born with
// email_verified = true (signup-verify runs before the profile row exists, so
// its `update profiles` is a no-op for brand-new accounts). Behavioural checks
// run in test/sql-dryrun.sh (docker) via test/email-verified-trigger.dryrun.sql.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('./helpers');

const REL = 'supabase/migrations/20260910_profiles_email_verified_from_auth.sql';
const FILE = path.join(ROOT, REL);

function load() {
  assert.ok(fs.existsSync(FILE), REL);
  const sql = fs.readFileSync(FILE, 'utf8');
  return { sql, code: sql.replace(/--.*$/gm, '').toLowerCase() };
}

test('trigger function: security definer, pinned search_path, derives the flag from auth.users.email_confirmed_at', () => {
  const { code } = load();
  assert.match(code, /create or replace function public\.profiles_email_verified_from_auth\(\)/);
  assert.match(code, /returns trigger/);
  assert.match(code, /security definer/);
  assert.match(code, /set search_path = public/);
  assert.match(code, /new\.email_verified\s*:=\s*exists\s*\(/, 'flag is computed, never taken from the row');
  assert.match(code, /from auth\.users \w+\s+where \w+\.id = new\.id\s+and \w+\.email_confirmed_at is not null/);
  assert.match(code, /return new;/);
});

test('before-insert trigger on profiles, dropped before (re)created', () => {
  const { code } = load();
  assert.match(code, /drop trigger if exists profiles_email_verified_from_auth on profiles/);
  assert.match(code, /create trigger profiles_email_verified_from_auth\s+before insert on profiles\s+for each row execute function public\.profiles_email_verified_from_auth\(\)/);
  assert.doesNotMatch(code, /before (insert or update|update)/, 'insert-only: link-email / sign-in still set the flag by explicit update');
});

test('migration is re-runnable and never destructive', () => {
  const { code } = load();
  assert.equal((code.match(/create function/g) || []).length, 0, 'use create or replace function');
  assert.doesNotMatch(code, /\b(drop table|truncate|delete from|alter table \w+ drop)\b/);
  assert.doesNotMatch(code, /email_otps/, 'no email_otps change: signup-send creates the auth user first, so OTPs stay keyed by user_id');
});

test('sql-dryrun.sh applies the migration twice and runs its behavioural checks', () => {
  const sh = fs.readFileSync(path.join(ROOT, 'test', 'sql-dryrun.sh'), 'utf8');
  assert.ok(sh.includes(REL), 'dry-run applies ' + REL);
  assert.ok(sh.includes('test/email-verified-trigger.dryrun.sql'), 'dry-run runs the behavioural checks');
  assert.ok(fs.existsSync(path.join(ROOT, 'test', 'email-verified-trigger.dryrun.sql')));
});
