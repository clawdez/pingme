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

test('showVerificationPending: signin recovery "check status" click shows sign-in-normally guidance, not a raw 400', async (t) => {
  const { win } = await loadSettled(t);
  win.eval(`
    window.__fetchCalls = [];
    window.fetch = async (url, opts) => { window.__fetchCalls.push(url); return { ok: true, status: 200, json: async () => ({}) }; };
    window.__onVerifiedCalled = false;
    const btn = document.createElement('button');
    btn.id = 'test-verify-btn';
    document.body.appendChild(btn);
    const errNode = document.createElement('div');
    errNode.id = 'test-err-node';
    document.body.appendChild(errNode);
    const recoveryCtx = { flow: 'signin', email: 'a@example.com', onVerified: () => { window.__onVerifiedCalled = true; } };
    window.__pending = showVerificationPending({ code: 'verification_pending' }, btn, errNode, null, recoveryCtx);
  `);
  assert.equal(win.eval('window.__pending'), true);
  const checkBtn = win.document.querySelector('.verification-check-status');
  assert.ok(checkBtn, 'check-status button should render for a recovery context');

  checkBtn.click();
  await tick(50);

  assert.equal(win.eval('window.__fetchCalls.length'), 0, 'signin recovery check must never hit the dead endpoint');
  assert.equal(win.eval('window.__onVerifiedCalled'), false);
  const errText = win.document.getElementById('test-err-node').textContent;
  assert.match(errText, /sign in normally/i, 'must direct the user to sign in normally, not show a raw server error');
  assert.doesNotMatch(errText, /requires authenticated link flow/i, 'must not leak the raw server error string');
  assert.equal(checkBtn.style.display, 'none', 'dead-end recovery button should hide itself');
});

test('showVerificationPending: signup recovery "check status" click also resolves gracefully', async (t) => {
  const { win } = await loadSettled(t);
  win.eval(`
    window.__fetchCalls = [];
    window.fetch = async (url, opts) => { window.__fetchCalls.push(url); return { ok: true, status: 200, json: async () => ({}) }; };
    const btn = document.createElement('button');
    btn.id = 'test-verify-btn-2';
    document.body.appendChild(btn);
    const errNode = document.createElement('div');
    errNode.id = 'test-err-node-2';
    document.body.appendChild(errNode);
    const recoveryCtx = { flow: 'signup', email: 'a@example.com', onVerified: () => {} };
    showVerificationPending({ code: 'busy' }, btn, errNode, null, recoveryCtx);
  `);
  const checkBtn = win.document.querySelectorAll('.verification-check-status')[0];
  checkBtn.click();
  await tick(50);
  assert.equal(win.eval('window.__fetchCalls.length'), 0);
  const errText = win.document.getElementById('test-err-node-2').textContent;
  assert.match(errText, /sign in normally/i);
});
