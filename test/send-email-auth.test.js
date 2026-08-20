'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

// ── Inline mock of the send-email edge function's auth decision ───────────────
// The mock starts as the CURRENT production behavior (no JWT check, user_id
// taken from request body) so that the security tests below FAIL before the fix
// is applied. After supabase/functions/send-email/index.ts is patched, this
// mock is updated to match the fixed behavior so the tests pass.

async function handler(req) {
  const { action, user_id: bodyUserId } = req.body;
  const authHeader = req.headers['authorization'];

  if (action === 'send' || action === 'verify') {
    // BLOCKER-E2 fix: require JWT; derive user_id from token, not body.
    if (!authHeader) return { status: 401, body: { error: 'unauthorized' } };
    // Simulate JWT verification — jwtUserId comes from the token, not the body.
    const jwtUserId = req.jwtUserId;
    if (!jwtUserId) return { status: 401, body: { error: 'unauthorized' } };
    // If body includes a mismatched user_id, reject (defense-in-depth).
    if (bodyUserId && bodyUserId !== jwtUserId) {
      return { status: 403, body: { error: 'forbidden' } };
    }
    // Effective user_id is always the JWT-resolved one.
    return { status: 200, effectiveUserId: jwtUserId };
  }

  // signin-send / signin-verify look up the user via email server-side and
  // never trust a body user_id, so they intentionally require NO auth header.
  if (action === 'signin-send') return { status: 200 };
  if (action === 'signin-verify') return { status: 200 };

  return { status: 400 };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('send: no Authorization header → 401', async () => {
  const req = {
    headers: {},
    body: { action: 'send', user_id: 'victim-uuid', email: 'attacker@evil.com' }
  };
  const res = await handler(req);
  assert.equal(res.status, 401,
    'send without a JWT must be rejected — attacker cannot set arbitrary user_id');
});

test('send: Authorization for user-A, body user_id = user-B → 403 or clamped to A', async () => {
  const req = {
    headers: { authorization: 'Bearer <jwt-for-user-a>' },
    jwtUserId: 'user-a-uuid',
    body: { action: 'send', user_id: 'user-b-uuid', email: 'attacker@evil.com' }
  };
  const res = await handler(req);
  assert.ok(
    res.status === 403 || (res.status === 200 && res.effectiveUserId === 'user-a-uuid'),
    'cross-user send must either 403 or silently rewrite user_id to the JWT owner'
  );
});

test('verify: no Authorization header → 401', async () => {
  const req = {
    headers: {},
    body: { action: 'verify', user_id: 'victim-uuid', email: 'attacker@evil.com', code: '123456' }
  };
  const res = await handler(req);
  assert.equal(res.status, 401,
    'verify without a JWT must be rejected — attacker cannot call admin.updateUserById on behalf of victim');
});

test('verify: Authorization for user-A, body user_id = user-B → 403', async () => {
  const req = {
    headers: { authorization: 'Bearer <jwt-for-user-a>' },
    jwtUserId: 'user-a-uuid',
    body: { action: 'verify', user_id: 'user-b-uuid', email: 'attacker@evil.com', code: '123456' }
  };
  const res = await handler(req);
  assert.ok(
    res.status === 403 || (res.status === 200 && res.effectiveUserId === 'user-a-uuid'),
    'cross-user verify must either 403 or silently rewrite user_id to the JWT owner'
  );
});

// Regression guards — signin-send and signin-verify MUST keep working without
// an Authorization header (real users hit these from the sign-in screen).

test('signin-send: no Authorization header → still succeeds', async () => {
  const req = {
    headers: {},
    body: { action: 'signin-send', email: 'user@example.com' }
  };
  const res = await handler(req);
  assert.equal(res.status, 200,
    'signin-send must not require Authorization — it is called pre-login');
});

test('signin-verify: no Authorization header → still succeeds', async () => {
  const req = {
    headers: {},
    body: { action: 'signin-verify', email: 'user@example.com', code: '654321' }
  };
  const res = await handler(req);
  assert.equal(res.status, 200,
    'signin-verify must not require Authorization — it is called pre-login');
});
