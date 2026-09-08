// Pins every shipped artifact to the live Supabase project. Guards against a
// half-migrated client (app.js on one project, CSP / DB trigger on another).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LIVE_REF = 'yuqahobbcwibekzvitec';
const DEAD_REF = 'jjgamvhvdqqjcizvpowk';
const LIVE_URL = `https://${LIVE_REF}.supabase.co`;
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('app.js SUPABASE_URL points at the live project', () => {
  const m = read('app.js').match(/const SUPABASE_URL = '([^']+)'/);
  assert.ok(m, 'SUPABASE_URL constant missing');
  assert.strictEqual(m[1], LIVE_URL);
});

test('app.js SUPABASE_ANON is an anon JWT issued for the live project', () => {
  const m = read('app.js').match(/const SUPABASE_ANON = '([^']+)'/);
  assert.ok(m, 'SUPABASE_ANON constant missing');
  const parts = m[1].split('.');
  assert.strictEqual(parts.length, 3, 'anon key is not a JWT');
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  assert.strictEqual(payload.ref, LIVE_REF);
  assert.strictEqual(payload.role, 'anon');
});

test('vercel.json CSP connect-src allows the live project over https and wss only', () => {
  const cfg = JSON.parse(read('vercel.json'));
  const csp = cfg.headers.flatMap(h => h.headers).find(h => h.key === 'Content-Security-Policy').value;
  const connect = csp.split(';').map(s => s.trim()).find(s => s.startsWith('connect-src'));
  assert.ok(connect.includes(`https://${LIVE_REF}.supabase.co`), 'https live host missing');
  assert.ok(connect.includes(`wss://${LIVE_REF}.supabase.co`), 'wss live host missing');
  assert.ok(!csp.includes(DEAD_REF), 'dead project still in CSP');
});

test('push webhook trigger targets the same project as the client', () => {
  const m = read('supabase/migrations/20260429_push_webhook.sql').match(/project_url text := '([^']+)'/);
  assert.ok(m, 'project_url missing');
  assert.strictEqual(m[1], LIVE_URL);
});

test('no shipped source file references the dead project', () => {
  const shipped = [
    'app.js', 'matches.js', 'sw.js', 'index.html', 'vercel.json', 'manifest.json',
    ...fs.readdirSync(ROOT).filter(f => f.endsWith('.sql')),
    ...fs.readdirSync(path.join(ROOT, 'supabase/migrations')).map(f => 'supabase/migrations/' + f),
    'supabase/functions/send-email/index.ts', 'supabase/functions/send-push/index.ts',
  ];
  const offenders = shipped.filter(f => read(f).includes(DEAD_REF));
  assert.deepStrictEqual(offenders, []);
});
