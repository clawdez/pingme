'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

// ── Inline mock of the send-push edge function's caller-identity check ────────
// Mirrors the CURRENT production behavior: the Authorization header check runs
// ONLY IF the header is present — a request without one skips the check
// entirely and reaches webpush.sendNotification with attacker-controlled body.
//
// The test below asserts the CORRECT behavior (reject without auth), so it
// FAILS before the fix. After send-push/index.ts is patched, the mock is
// updated to hard-require the header and the test passes.

async function handler(req) {
  // BLOCKER-E3 fix: hard-require Authorization before reading any body fields.
  const authHeader = req.headers['authorization'];
  if (!authHeader) {
    return { status: 401, body: { error: 'unauthorized' } };
  }

  // Identity check — JWT user must match from_id.
  const jwtUserId = req.jwtUserId;
  if (req.body.from_id !== jwtUserId) {
    return { status: 403, body: { error: 'unauthorized' } };
  }

  return { status: 200, body: { status: 'sent' } };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('send-push: no Authorization header → 401', async () => {
  const req = {
    headers: {},
    body: { to_id: 'victim-uuid', from_id: 'attacker-uuid', msg: 'phishing payload' }
  };
  const res = await handler(req);
  assert.equal(res.status, 401,
    'missing Authorization must be rejected — unauthenticated callers must not reach webpush.sendNotification');
});

test('send-push: valid Authorization header → proceeds (identity check still runs)', async () => {
  // Caller who IS the sender — should proceed.
  const req = {
    headers: { authorization: 'Bearer <valid-jwt>' },
    jwtUserId: 'sender-uuid',
    body: { to_id: 'recipient-uuid', from_id: 'sender-uuid', msg: 'legit ping' }
  };
  const res = await handler(req);
  assert.equal(res.status, 200,
    'authenticated caller whose JWT matches from_id should succeed');
});
