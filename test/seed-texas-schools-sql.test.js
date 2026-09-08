'use strict';
// Static checks over the Texas launch-cohort seed migration. Same pattern as
// friends-schools-sql.test.js: the live DB isn't reachable from CI, so prove
// the file's shape — idempotent insert, the 5 expected campuses, values that
// satisfy the schools table constraints from 20260907_friends_and_schools.sql.
// Behavioural apply (twice, count = 5) lives in test/sql-dryrun.sh.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('./helpers');

const FILE = path.join(ROOT, 'supabase', 'migrations', '20260908_seed_texas_schools.sql');

const EXPECTED = {
  'ttu':       { name: 'Texas Tech University',          city: 'lubbock' },
  'ut-austin': { name: 'University of Texas at Austin',  city: 'austin',          color: '#BF5700' },
  'texas-am':  { name: 'Texas A&M University',           city: 'college station', color: '#500000' },
  'uh':        { name: 'University of Houston',          city: 'houston',         color: '#C8102E' },
  'baylor':    { name: 'Baylor University',              city: 'waco',            color: '#154734' },
};

function rows() {
  const sql = fs.readFileSync(FILE, 'utf8').replace(/--.*$/gm, '');
  const out = {};
  for (const m of sql.matchAll(/\(\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*'([^']+)'\s*\)/g)) {
    out[m[1]] = { name: m[2], color: m[3], city: m[4] };
  }
  return { sql, out };
}

test('seed migration exists and is a single idempotent insert into schools', () => {
  assert.ok(fs.existsSync(FILE), 'supabase/migrations/20260908_seed_texas_schools.sql');
  const { sql } = rows();
  const code = sql.toLowerCase();
  assert.equal((code.match(/insert into schools/g) || []).length, 1, 'one insert statement');
  assert.match(code, /insert into schools \(slug, display_name, color, default_city\) values/);
  assert.match(code, /on conflict \(slug\) do nothing/);
  assert.doesNotMatch(code, /\b(update|delete|drop|alter|truncate)\b/, 'seed only — no DDL, no destructive statements');
});

test('seeds exactly the 5 Texas launch schools with the agreed slugs, names and cities', () => {
  const { out } = rows();
  assert.deepEqual(Object.keys(out).sort(), Object.keys(EXPECTED).sort());
  for (const [slug, e] of Object.entries(EXPECTED)) {
    assert.equal(out[slug].name, e.name, slug + ' display_name');
    assert.equal(out[slug].city, e.city, slug + ' default_city');
    if (e.color) assert.equal(out[slug].color.toUpperCase(), e.color, slug + ' color');
  }
});

test('every row satisfies the schools table check constraints', () => {
  const { out } = rows();
  for (const [slug, r] of Object.entries(out)) {
    assert.match(slug, /^[a-z0-9-]{2,32}$/, slug + ' slug pattern');
    assert.ok(r.name.length >= 2 && r.name.length <= 80, slug + ' display_name length');
    assert.match(r.color, /^#[0-9a-fA-F]{6}$/, slug + ' color hex');
    assert.equal(r.city, r.city.toLowerCase().trim(), slug + ' default_city is a lower-cased slug');
  }
});

test('ttu row matches the launch row already seeded by 20260907 (no-op on conflict)', () => {
  const base = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '20260907_friends_and_schools.sql'), 'utf8');
  const m = base.match(/\('ttu', '([^']+)', '([^']+)', '([^']+)'\)/);
  assert.ok(m, 'ttu row in base migration');
  const { out } = rows();
  assert.equal(out.ttu.name, m[1]);
  assert.equal(out.ttu.color.toUpperCase(), m[2].toUpperCase());
  assert.equal(out.ttu.city, m[3]);
});

test('no keys or secrets in the seed migration', () => {
  const { sql } = rows();
  assert.doesNotMatch(sql, /eyJ[a-zA-Z0-9_-]{20,}/);
  assert.doesNotMatch(sql, /service_role|sk_live|supabase\.co/i);
});
