'use strict';
// Client-side coverage for the check-status security fix (899fbd2): the
// server now kills the signin/signup branch of check-status entirely
// (400, no user lookup — email_otps could enumerate an event's guest list
// by email). These tests pin two things:
//   1. The client never wastes a request on the dead signin/signup branch —
//      checkVerificationStatus() short-circuits client-side instead of
//      round-tripping to get a 400 back.
//   2. The one remaining recovery path (an authenticated user re-checking
//      their own link-email verification) still works end to end.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./helpers');

const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));

async function loadSettled(t) {
  const app = loadApp(t);
  await tick(350);
  return app;
}

test('checkVerificationStatus(signin): resolves signin_required without hitting the network', async (t) => {
  const { win } = await loadSettled(t);
  win.eval(`
    window.__fetchCalls = [];
    window.fetch = async (url, opts) => { window.__fetchCalls.push(url); return { ok: true, status: 200, json: async () => ({}) }; };
  `);
  const result = await win.eval(`checkVerificationStatus('signin', 'a@example.com')`);
  assert.equal(result.code, 'signin_required');
  const calls = win.eval('window.__fetchCalls.length');
  assert.equal(calls, 0, 'signin flow must not call the killed check-status endpoint');
});

test('checkVerificationStatus(signup): resolves signin_required without hitting the network', async (t) => {
  const { win } = await loadSettled(t);
  win.eval(`
    window.__fetchCalls = [];
    window.fetch = async (url, opts) => { window.__fetchCalls.push(url); return { ok: true, status: 200, json: async () => ({}) }; };
  `);
  const result = await win.eval(`checkVerificationStatus('signup', 'a@example.com')`);
  assert.equal(result.code, 'signin_required');
  const calls = win.eval('window.__fetchCalls.length');
  assert.equal(calls, 0, 'signup flow must not call the killed check-status endpoint');
});

test('checkVerificationStatus(link): still calls the server with the bearer token and returns its status', async (t) => {
  const { win } = await loadSettled(t);
  win.eval(`
    window.__fetchCalls = [];
    const __mockJwtPayload = btoa(JSON.stringify({ sub: 'u1', exp: Math.floor(Date.now()/1000) + 3600 }));
    sb = {
      auth: {
        getSession: async () => ({ data: { session: {
          access_token: 'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.' + __mockJwtPayload + '.fake'
        } } }),
        refreshSession: async () => ({ data: {}, error: null }),
      }
    };
    window.fetch = async (url, opts) => {
      window.__fetchCalls.push({ url, headers: opts.headers, body: JSON.parse(opts.body) });
      return { ok: true, status: 200, json: async () => ({ code: 'verification_pending' }) };
    };
  `);
  const result = await win.eval(`checkVerificationStatus('link', 'a@example.com')`);
  assert.equal(result.code, 'verification_pending');
  const call = win.eval('window.__fetchCalls[0]');
  assert.equal(win.eval('window.__fetchCalls.length'), 1, 'link flow must call check-status exactly once');
  assert.match(call.headers.Authorization, /^Bearer eyJ/, 'link flow must send the user bearer token');
  assert.equal(call.body.flow, 'link');
});

test('checkVerificationStatus(link): expired session surfaces session_expired without a network call', async (t) => {
  const { win } = await loadSettled(t);
  win.eval(`
    window.__fetchCalls = [];
    sb = {
      auth: {
        getSession: async () => ({ data: { session: null } }),
      }
    };
    window.fetch = async (url, opts) => { window.__fetchCalls.push(url); return { ok: true, status: 200, json: async () => ({}) }; };
  `);
  const result = await win.eval(`checkVerificationStatus('link', 'a@example.com')`);
  assert.equal(result.code, 'session_expired');
  assert.equal(win.eval('window.__fetchCalls.length'), 0);
});

test('showVerificationPending: signin recovery uses session-await, not dead check-status button', async (t) => {
  const { win } = await loadSettled(t);
  win.eval(`
    window.__fetchCalls = [];
    window.fetch = async (url, opts) => { window.__fetchCalls.push(url); return { ok: true, status: 200, json: async () => ({}) }; };
    window.__onVerifiedCalled = false;
    window.__authCallback = null;
    sb = {
      auth: {
        onAuthStateChange: (cb) => {
          window.__authCallback = cb;
          return { data: { subscription: { unsubscribe: () => {} } } };
        }
      }
    };
    const btn = document.createElement('button');
    btn.id = 'test-verify-btn';
    document.body.appendChild(btn);
    const errNode = document.createElement('div');
    errNode.id = 'test-err-node';
    document.body.appendChild(errNode);
    const recoveryCtx = { flow: 'signin', email: 'a@example.com', onVerified: (s) => { window.__onVerifiedCalled = true; window.__verifiedStatus = s; } };
    window.__pending = showVerificationPending({ code: 'verification_pending' }, btn, errNode, null, recoveryCtx);
  `);
  assert.equal(win.eval('window.__pending'), true);
  const checkBtn = win.document.querySelector('.verification-check-status');
  assert.equal(checkBtn, null, 'signin flow must NOT render a check-status button');
  const waitEl = win.document.querySelector('.verification-session-wait');
  assert.ok(waitEl, 'signin flow must render a session-await listener');
  assert.equal(win.eval('window.__fetchCalls.length'), 0, 'no network calls during session-await setup');
  assert.ok(win.eval('typeof window.__authCallback === "function"'), 'onAuthStateChange listener must be registered');

  // Simulate correct session arriving
  await win.eval(`window.__authCallback('SIGNED_IN', { user: { email: 'a@example.com' } })`);
  await tick(50);
  assert.equal(win.eval('window.__onVerifiedCalled'), true, 'onVerified must fire on matching session');
  const errText = win.document.getElementById('test-err-node').textContent;
  assert.match(errText, /signed in as a@example\.com/i, 'must confirm the verified email');
});

test('showVerificationPending: signin recovery rejects mismatched email', async (t) => {
  const { win } = await loadSettled(t);
  win.eval(`
    window.__onVerifiedCalled = false;
    window.__authCallback = null;
    sb = {
      auth: {
        onAuthStateChange: (cb) => {
          window.__authCallback = cb;
          return { data: { subscription: { unsubscribe: () => {} } } };
        }
      }
    };
    const btn = document.createElement('button');
    btn.id = 'test-verify-btn-m';
    document.body.appendChild(btn);
    const errNode = document.createElement('div');
    errNode.id = 'test-err-node-m';
    document.body.appendChild(errNode);
    const recoveryCtx = { flow: 'signin', email: 'a@example.com', onVerified: () => { window.__onVerifiedCalled = true; } };
    showVerificationPending({ code: 'transport_unknown' }, btn, errNode, null, recoveryCtx);
  `);
  await win.eval(`window.__authCallback('SIGNED_IN', { user: { email: 'wrong@example.com' } })`);
  await tick(50);
  assert.equal(win.eval('window.__onVerifiedCalled'), false, 'onVerified must NOT fire for mismatched email');
  const waitText = win.document.querySelector('.verification-session-wait').textContent;
  assert.match(waitText, /expected a@example\.com/i, 'must explain the email mismatch');
});

test('showVerificationPending: signup recovery uses session-await, unlocks resend after timeout', async (t) => {
  const { win } = await loadSettled(t);
  win.eval(`
    window.__authCallback = null;
    sb = {
      auth: {
        onAuthStateChange: (cb) => {
          window.__authCallback = cb;
          return { data: { subscription: { unsubscribe: () => {} } } };
        }
      }
    };
    const btn = document.createElement('button');
    btn.id = 'test-verify-btn-2';
    document.body.appendChild(btn);
    const errNode = document.createElement('div');
    errNode.id = 'test-err-node-2';
    document.body.appendChild(errNode);
    const resendBtn = document.createElement('button');
    resendBtn.id = 'test-resend-btn';
    document.body.appendChild(resendBtn);
    const recoveryCtx = { flow: 'signup', email: 'b@example.com', onVerified: () => {} };
    showVerificationPending({ code: 'busy' }, btn, errNode, resendBtn, recoveryCtx);
  `);
  const checkBtn = win.document.querySelector('.verification-check-status');
  assert.equal(checkBtn, null, 'signup flow must NOT render a check-status button');
  const waitEl = win.document.querySelector('.verification-session-wait');
  assert.ok(waitEl, 'signup flow must render a session-await listener');
  const resendBtn = win.document.getElementById('test-resend-btn');
  assert.equal(resendBtn.disabled, true, 'resend starts disabled');
  assert.equal(resendBtn.dataset.verificationPending, 'true', 'resend marked pending');
});
