// Behavioural harness for supabase/functions/send-email/index.ts. Runs the REAL
// function under Deno with std `serve` and supabase-js swapped for in-memory
// mocks via test/deno/import_map.json, and global fetch intercepted for GoTrue
// admin lookups + Resend. Prints one JSON array of {name, ok, error} on stdout;
// test/send-email-signup.test.js turns each entry into a node:test case.
import { db, resetDb } from './mocks/supabase.ts';

const SUPABASE_URL = 'https://test-project.supabase.co';
Deno.env.set('SUPABASE_URL', SUPABASE_URL);
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'service-key');
Deno.env.set('SUPABASE_ANON_KEY', 'anon-key');
Deno.env.set('RESEND_API_KEY', 'resend-key');

globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.startsWith('https://api.resend.com/emails')) {
    const body = JSON.parse(init?.body || '{}');
    db.log.push({ resend: body });
    if (db.resendFail) return new Response(JSON.stringify({ message: 'invalid key' }), { status: 401 });
    return new Response(JSON.stringify({ id: 'email-id' }), { status: 200 });
  }
  if (url.startsWith(SUPABASE_URL + '/auth/v1/admin/users')) {
    const filter = new URL(url).searchParams.get('filter') || '';
    const users = db.users.filter((u) => String(u.email || '').includes(filter));
    return new Response(JSON.stringify({ users }), { status: 200 });
  }
  throw new Error('unexpected fetch ' + url);
}) as any;

await import('../../supabase/functions/send-email/index.ts');
const handler = (globalThis as any).__handler as (req: Request) => Promise<Response>;

async function call(body: any, headers: Record<string, string> = {}) {
  const res = await handler(new Request('https://test-project.supabase.co/functions/v1/send-email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Origin': 'https://usepingme.com', ...headers },
    body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() };
}
function seedUser(email: string | null, confirmed: boolean, extra: any = {}) {
  const u = { id: crypto.randomUUID(), email, email_confirmed_at: confirmed ? '2026-01-01T00:00:00.000Z' : null,
    is_anonymous: !email, created_at: '2026-01-01T00:00:00.000Z', ...extra };
  db.users.push(u);
  return u;
}
const otpRows = () => db.tables.email_otps;
const resendCalls = () => db.log.filter((l) => l.resend).map((l) => l.resend);
const adminCalls = (name: string) => db.log.filter((l) => l.admin === name);

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
function eq(a: any, b: any, msg = '') { if (a !== b) throw new Error(msg + ' expected ' + JSON.stringify(b) + ' got ' + JSON.stringify(a)); }
function ok(c: any, msg = 'assertion failed') { if (!c) throw new Error(msg); }
function match(s: any, re: RegExp, msg = '') { if (!re.test(String(s))) throw new Error(msg + ' expected ' + JSON.stringify(s) + ' to match ' + re); }
async function it(name: string, fn: () => Promise<void>) {
  resetDb();
  try { await fn(); results.push({ name, ok: true }); }
  catch (e: any) { results.push({ name, ok: false, error: String(e?.stack || e) }); }
}

/* ── signup-send ── */

await it('signup-send: new email → unconfirmed auth user, OTP keyed by that user, code emailed, 200 sent', async () => {
  const r = await call({ action: 'signup-send', email: 'new@example.com' });
  eq(r.status, 200, 'status'); eq(r.body.sent, true, 'sent');
  ok(!('user_id' in r.body) && !('code' in r.body), 'response must not leak user id or code');
  eq(db.users.length, 1, 'one auth user created');
  eq(db.users[0].email, 'new@example.com'); eq(db.users[0].email_confirmed_at, null, 'not confirmed yet');
  const cu = adminCalls('createUser'); eq(cu.length, 1, 'createUser calls');
  eq(cu[0].attrs.email_confirm, false, 'createUser email_confirm');
  eq(otpRows().length, 1, 'otp rows'); const row = otpRows()[0];
  eq(row.user_id, db.users[0].id, 'otp keyed by the new user'); eq(row.email, 'new@example.com');
  match(row.code, /^\d{6}$/, 'code'); eq(row.attempts, 0);
  ok(new Date(row.expires_at).getTime() > Date.now() + 9 * 60000, 'expires ~10 min out');
  const sent = resendCalls(); eq(sent.length, 1, 'one email'); eq(sent[0].to, 'new@example.com');
  ok(sent[0].html.includes(row.code), 'email carries the code');
  match(sent[0].subject, /pingme/i);
});

await it('signup-send: email is trimmed + lower-cased before lookup/create', async () => {
  const r = await call({ action: 'signup-send', email: '  New.Person@Example.COM ' });
  eq(r.status, 200); eq(db.users.length, 1); eq(db.users[0].email, 'new.person@example.com');
  eq(otpRows()[0].email, 'new.person@example.com'); eq(resendCalls()[0].to, 'new.person@example.com');
});

await it('signup-send: invalid email format → 400, nothing created, nothing sent', async () => {
  for (const bad of ['', 'nope', 'a@b', 'a b@c.com', '@c.com', 'a@.com', 'a@c.', 'x'.repeat(250) + '@e.com', 42, null]) {
    const r = await call({ action: 'signup-send', email: bad });
    eq(r.status, 400, 'status for ' + JSON.stringify(bad)); match(r.body.error, /valid email/, 'error for ' + JSON.stringify(bad));
  }
  const r = await call({ action: 'signup-send' });
  eq(r.status, 400, 'missing email');
  eq(db.users.length, 0, 'no users'); eq(otpRows().length, 0, 'no otps'); eq(resendCalls().length, 0, 'no email');
});

await it('signup-send: already-verified email → already_registered error, no new user, no email', async () => {
  seedUser('taken@example.com', true);
  const r = await call({ action: 'signup-send', email: 'Taken@Example.com' });
  eq(r.status, 200); eq(r.body.ok, false); eq(r.body.code, 'already_registered');
  match(r.body.error, /already registered/); match(r.body.error, /sign in/);
  eq(db.users.length, 1, 'no new user'); eq(adminCalls('createUser').length, 0);
  eq(otpRows().length, 0, 'no otp'); eq(resendCalls().length, 0, 'no email');
});

await it('signup-send: existing unconfirmed user (abandoned signup) is reused, not duplicated', async () => {
  const u = seedUser('again@example.com', false);
  const r = await call({ action: 'signup-send', email: 'again@example.com' });
  eq(r.status, 200); eq(r.body.sent, true);
  eq(adminCalls('createUser').length, 0, 'no createUser'); eq(db.users.length, 1);
  eq(otpRows().length, 1); eq(otpRows()[0].user_id, u.id, 'otp keyed by the existing user');
  eq(resendCalls().length, 1);
});

await it('signup-send: second request within a minute → 429, single email', async () => {
  const a = await call({ action: 'signup-send', email: 'fast@example.com' }); eq(a.status, 200);
  const b = await call({ action: 'signup-send', email: 'fast@example.com' });
  eq(b.status, 429); match(b.body.error, /wait/); eq(resendCalls().length, 1);
});

await it('signup-send: Resend failure → 500 email failed', async () => {
  db.resendFail = true;
  const r = await call({ action: 'signup-send', email: 'down@example.com' });
  eq(r.status, 500); match(r.body.error, /email failed/);
});

/* ── signup-verify ── */

async function startSignup(email: string) {
  const r = await call({ action: 'signup-send', email });
  eq(r.status, 200, 'signup-send precondition');
  const row = otpRows().find((x) => x.email === email)!;
  db.log.length = 0;
  return { code: row.code, user: db.users.find((u) => u.email === email)! };
}

await it('signup-verify: correct code → email confirmed, magiclink token_hash returned, otp deleted', async () => {
  const { code, user } = await startSignup('happy@example.com');
  const r = await call({ action: 'signup-verify', email: 'Happy@Example.com', code });
  eq(r.status, 200, 'status'); eq(r.body.verified, true, 'verified');
  eq(r.body.token_hash, 'hash-magiclink-' + user.id, 'token_hash from generateLink(magiclink)');
  ok(user.email_confirmed_at, 'email confirmed');
  const upd = adminCalls('updateUserById'); eq(upd.length, 1); eq(upd[0].id, user.id); eq(upd[0].attrs.email_confirm, true);
  const gl = adminCalls('generateLink'); eq(gl.length, 1); eq(gl[0].attrs.type, 'magiclink'); eq(gl[0].attrs.email, 'happy@example.com');
  eq(otpRows().length, 0, 'otp cleaned up');
  ok(db.log.some((l) => l.table === 'profiles' && l.op === 'update' && l.payload?.email_verified === true), 'profiles.email_verified flagged (no-op until the profile exists)');
});

await it('signup-verify: wrong code → invalid code, attempt counted, user stays unconfirmed, no session', async () => {
  const { code, user } = await startSignup('wrong@example.com');
  const bad = code === '000000' ? '111111' : '000000';
  const r = await call({ action: 'signup-verify', email: 'wrong@example.com', code: bad });
  eq(r.status, 200); eq(r.body.ok, false); match(r.body.error, /invalid code/);
  ok(!r.body.token_hash, 'no token'); eq(user.email_confirmed_at, null, 'still unconfirmed');
  eq(otpRows()[0].attempts, 1, 'attempt counted'); eq(adminCalls('generateLink').length, 0);
});

await it('signup-verify: malformed code (not 6 digits) → invalid, nothing consumed', async () => {
  const { user } = await startSignup('fmt@example.com');
  for (const bad of ['', '12345', 'abcdef', null, 123456]) {
    const r = await call({ action: 'signup-verify', email: 'fmt@example.com', code: bad });
    eq(r.status, 200, 'status for ' + JSON.stringify(bad)); eq(r.body.ok, false); match(r.body.error, /invalid/);
    ok(!r.body.token_hash);
  }
  eq(user.email_confirmed_at, null); eq(otpRows().length, 1, 'row kept');
});

await it('signup-verify: expired code → invalid or expired, no session', async () => {
  const { code, user } = await startSignup('late@example.com');
  otpRows()[0].expires_at = new Date(Date.now() - 1000).toISOString();
  const r = await call({ action: 'signup-verify', email: 'late@example.com', code });
  eq(r.status, 200); eq(r.body.ok, false); match(r.body.error, /invalid or expired/);
  ok(!r.body.token_hash); eq(user.email_confirmed_at, null); eq(adminCalls('generateLink').length, 0);
});

await it('signup-verify: unknown email → invalid or expired (no enumeration), no session', async () => {
  const r = await call({ action: 'signup-verify', email: 'ghost@example.com', code: '123456' });
  eq(r.status, 200); eq(r.body.ok, false); match(r.body.error, /invalid or expired/); ok(!r.body.token_hash);
});

await it("signup-verify: another user's code cannot verify a different email", async () => {
  const a = await startSignup('alice@example.com');
  await new Promise((r) => setTimeout(r, 5));
  const b = await startSignup('bob@example.com');
  const r = await call({ action: 'signup-verify', email: 'bob@example.com', code: a.code === b.code ? '999999' : a.code });
  eq(r.body.ok, false); ok(!r.body.token_hash); eq(b.user.email_confirmed_at, null);
});

await it('signup-verify: 5 failed attempts → locked out, row deleted', async () => {
  const { code } = await startSignup('lock@example.com');
  otpRows()[0].attempts = 5;
  const r = await call({ action: 'signup-verify', email: 'lock@example.com', code });
  eq(r.body.ok, false); match(r.body.error, /too many attempts/); eq(otpRows().length, 0, 'row deleted');
});

await it('signup-verify: already-confirmed account cannot be re-verified through signup', async () => {
  const u = seedUser('done@example.com', true);
  db.tables.email_otps.push({ id: 'x', user_id: u.id, email: 'done@example.com', code: '123456', attempts: 0,
    expires_at: new Date(Date.now() + 600000).toISOString(), created_at: new Date().toISOString() });
  const r = await call({ action: 'signup-verify', email: 'done@example.com', code: '123456' });
  eq(r.body.ok, false); ok(!r.body.token_hash, 'signup-verify must not mint a session for a registered account');
});

/* ── regressions on the untouched actions (real function, not a mock) ── */

await it('send: no Authorization → 401 (link-email guard intact)', async () => {
  const r = await call({ action: 'send', email: 'a@example.com', user_id: 'victim' });
  eq(r.status, 401);
});

await it('send: anon-key bearer (no user) → 401', async () => {
  const r = await call({ action: 'send', email: 'a@example.com' }, { Authorization: 'Bearer anon-key' });
  eq(r.status, 401);
});

await it('send: user JWT → OTP stored for the JWT user, body user_id ignored', async () => {
  const me = seedUser(null, false); db.tokens['tok-me'] = me;
  const r = await call({ action: 'send', email: 'link@example.com', user_id: 'victim' }, { Authorization: 'Bearer tok-me' });
  eq(r.status, 200); eq(r.body.sent, true); eq(otpRows()[0].user_id, me.id); eq(resendCalls().length, 1);
});

await it('verify: user JWT + right code → email linked + confirmed', async () => {
  const me = seedUser(null, false); db.tokens['tok-me'] = me;
  await call({ action: 'send', email: 'link@example.com' }, { Authorization: 'Bearer tok-me' });
  const code = otpRows()[0].code;
  const r = await call({ action: 'verify', email: 'link@example.com', code }, { Authorization: 'Bearer tok-me' });
  eq(r.status, 200); eq(r.body.verified, true); eq(me.email, 'link@example.com'); ok(me.email_confirmed_at);
});

await it('verify: no Authorization → 401', async () => {
  const r = await call({ action: 'verify', email: 'a@example.com', code: '123456', user_id: 'victim' });
  eq(r.status, 401);
});

await it('signin-send: unknown email → generic message, no email sent', async () => {
  const r = await call({ action: 'signin-send', email: 'nobody@example.com' });
  eq(r.status, 200); eq(r.body.ok, false); match(r.body.error, /if that email exists/); eq(resendCalls().length, 0);
});

await it('signin-send + signin-verify: verified account gets a magiclink token_hash', async () => {
  const u = seedUser('back@example.com', true);
  const a = await call({ action: 'signin-send', email: 'back@example.com' });
  eq(a.status, 200); eq(a.body.sent, true); eq(resendCalls().length, 1);
  const code = otpRows()[0].code;
  const b = await call({ action: 'signin-verify', email: 'back@example.com', code });
  eq(b.status, 200); eq(b.body.verified, true); eq(b.body.token_hash, 'hash-magiclink-' + u.id); eq(otpRows().length, 0);
});

await it('unknown action → 400', async () => {
  const r = await call({ action: 'nope' });
  eq(r.status, 400);
});

for (const status of [400, 401, 403, 429, 500, 503]) {
  await it('signin-send: provider rejection ' + status + ' must not report sent', async () => {
    seedUser('reject@example.com', true);
    const before = globalThis.fetch;
    globalThis.fetch = async (input, init) => String(input).startsWith('https://api.resend.com/emails')
      ? new Response('provider rejected', { status }) : before(input, init);
    try {
      const r = await call({ action: 'signin-send', email: 'reject@example.com' });
      eq(r.status, 503);
      eq(r.body.code, 'email_unavailable');
      ok(!r.body.sent, 'must not show sent');
    } finally { globalThis.fetch = before; }
  });
}

console.log(JSON.stringify(results));
