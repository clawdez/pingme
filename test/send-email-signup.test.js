'use strict';
// Runs the REAL send-email edge function under Deno (test/deno/send-email-harness.ts)
// with supabase-js / std-serve / fetch replaced by in-memory mocks, and turns
// each harness case into a node:test. Deno is required — this file fails
// loudly (never skips) if it is missing.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { ROOT } = require('./helpers');

const r = spawnSync('deno', [
  'run', '--quiet', '--no-lock', '--allow-read', '--allow-env',
  '--import-map=test/deno/import_map.json', 'test/deno/send-email-harness.ts',
], { cwd: ROOT, encoding: 'utf8' });
if (r.error) throw new Error('deno is required for the send-email behavioural tests: ' + r.error.message);
let results;
try { results = JSON.parse(r.stdout.trim().split('\n').pop()); }
catch (e) { throw new Error('send-email harness produced no result JSON\n--- stdout ---\n' + r.stdout + '\n--- stderr ---\n' + r.stderr); }
assert.ok(Array.isArray(results) && results.length >= 20, 'harness ran its cases');

for (const c of results) {
  test('send-email (deno): ' + c.name, () => { assert.ok(c.ok, c.error); });
}
