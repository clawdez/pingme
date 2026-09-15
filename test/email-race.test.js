'use strict';
// Regression tests for the email-change race condition on signin/signup send.
// Repro: user sends for email A, edits to email B before A resolves, sends
// for B. Whichever response arrives last must not clobber the OTP screen
// with the wrong email. Covers both resolution orders (A-then-B, B-then-A)
// and mixed success/failure outcomes, for both signin and signup.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./helpers');

const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));
const byId = (win, id) => win.document.getElementById(id);

async function loadSettled(t) {
  const app = loadApp(t);
  await tick(350);
  app.win.eval(`
    window.__fetch = []; window.__handlers = {}; window.__verifyOtp = []; window.__anon = 0; window.__db = [];
    window.__session = null; window.__profileRow = null; window.__confirmed = true;
    // Per-email deferred promises: window.__pending[action][email] = { promise, resolve }
    window.__pending = {};
    window.__deferFor = (action, email) => {
      window.__pending[action] = window.__pending[action] || {};
      let resolveFn;
      const p = new Promise(r => { resolveFn = r; });
      window.__pending[action][email] = { promise: p, resolve: resolveFn };
      return p;
    };
    window.__resolveFor = (action, email, value) => {
      window.__pending[action][email].resolve(value);
    };
    window.fetch = async (url, opts) => {
      const body = JSON.parse(opts.body);
      window.__fetch.push({ url, body, headers: opts.headers });
      const h = window.__handlers[body.action];
      const res = h ? (typeof h === 'function' ? h(body) : h) : { error: 'unknown action' };
      const resolved = res && typeof res.then === 'function' ? await res : res;
      const status = resolved.__status || 200;
      return { ok: status < 400, status, json: async () => resolved };
    };
    function __from(tbl) {
      const calls = [];
      const h = { get(_, k) {
        if (k === 'then' || k === 'catch' || k === 'finally') { const p = Promise.resolve(window.__fromResult(tbl, calls)); return p[k].bind(p); }
        return (...args) => { calls.push({ m: k, args }); return new Proxy({}, h); };
      } };
      return new Proxy({}, h);
    }
    window.__fromResult = (tbl, calls) => {
      window.__db.push({ tbl, calls });
      const first = calls[0] && calls[0].m;
      if (tbl === 'profiles' && first === 'insert') return { data: Object.assign({}, calls[0].args[0], { email_verified: !!window.__confirmed }), error: null };
      if (tbl === 'profiles' && first === 'update') return { data: Object.assign({}, window.__profileRow || {}, calls[0].args[0]), error: null };
      if (calls.some(c => c.m === 'single')) return { data: tbl === 'profiles' ? window.__profileRow : null, error: null };
      return { data: [], error: null };
    };
    sb = {
      from: __from,
      rpc: () => Promise.resolve({ data: null, error: null }),
      auth: {
        getSession: async () => ({ data: { session: window.__session } }),
        onAuthStateChange: (cb) => { window.__authCb = cb; return { data: { subscription: { unsubscribe() {} } } }; },
        verifyOtp: async (args) => { window.__verifyOtp.push(args); return window.__verifyOtpResult || { data: { session: {} }, error: null }; },
        signInAnonymously: async () => { window.__anon++; return { data: { user: { id: 'anon-1' } }, error: null }; },
        refreshSession: async () => ({ data: {}, error: null }),
      },
      channel: () => ({ on() { return this; }, subscribe() { return this; } }),
      removeChannel() {}
    };
    bindAuthListener();
  `);
  return app;
}

function otpSubtext(win) {
  const el = win.document.querySelector('.setup-check-sub');
  return el ? el.textContent : null;
}

/* ── signin: A-then-B (stale success resolves first) ── */

test('signin: send A, edit to B, send B, A resolves first — OTP screen shows B, not A', async (t) => {
  const { win } = await loadSettled(t);
  win.eval(`window.__handlers['signin-send'] = (body) => window.__deferFor('signin-send', body.email);`);
  win.eval('showSetupEmail()');

  byId(win, 'setup-email').value = 'first@example.test';
  byId(win, 's-email-go').click();
  await tick();

  byId(win, 'setup-email').value = 'second@example.test';
  byId(win, 'setup-email').dispatchEvent(new win.Event('input'));
  await tick();
  byId(win, 's-email-go').click();
  await tick();

  // A resolves first (success) — must be discarded
  win.eval(`window.__resolveFor('signin-send', 'first@example.test', { sent: true })`);
  await tick(50);
  assert.ok(!otpSubtext(win) || !otpSubtext(win).includes('first@example.test'), 'stale A success did not render OTP for first@');

  // B resolves — should render OTP for second@
  win.eval(`window.__resolveFor('signin-send', 'second@example.test', { sent: true })`);
  await tick(50);
  assert.ok(otpSubtext(win) && otpSubtext(win).includes('second@example.test'), 'OTP screen shows second@ email');
});

/* ── signin: B-then-A (correct resolves first, stale must not override) ── */

test('signin: send A, edit to B, send B, B resolves first then A resolves late — OTP screen stays on B', async (t) => {
  const { win } = await loadSettled(t);
  win.eval(`window.__handlers['signin-send'] = (body) => window.__deferFor('signin-send', body.email);`);
  win.eval('showSetupEmail()');

  byId(win, 'setup-email').value = 'first@example.test';
  byId(win, 's-email-go').click();
  await tick();

  byId(win, 'setup-email').value = 'second@example.test';
  byId(win, 'setup-email').dispatchEvent(new win.Event('input'));
  await tick();
  byId(win, 's-email-go').click();
  await tick();

  // B resolves first (success)
  win.eval(`window.__resolveFor('signin-send', 'second@example.test', { sent: true })`);
  await tick(50);
  assert.ok(otpSubtext(win) && otpSubtext(win).includes('second@example.test'), 'OTP screen shows second@ email');

  // A resolves late (success) — must not clobber the already-shown OTP screen
  win.eval(`window.__resolveFor('signin-send', 'first@example.test', { sent: true })`);
  await tick(50);
  assert.ok(otpSubtext(win) && otpSubtext(win).includes('second@example.test'), 'OTP screen still shows second@ email after late A resolution');
});

/* ── signin: A fails, B succeeds ── */

test('signin: send A, edit to B, send B — A fails late, B succeeds — no error flash, OTP shows B', async (t) => {
  const { win } = await loadSettled(t);
  win.eval(`window.__handlers['signin-send'] = (body) => window.__deferFor('signin-send', body.email);`);
  win.eval('showSetupEmail()');

  byId(win, 'setup-email').value = 'first@example.test';
  byId(win, 's-email-go').click();
  await tick();

  byId(win, 'setup-email').value = 'second@example.test';
  byId(win, 'setup-email').dispatchEvent(new win.Event('input'));
  await tick();
  byId(win, 's-email-go').click();
  await tick();

  win.eval(`window.__resolveFor('signin-send', 'second@example.test', { sent: true })`);
  await tick(50);
  assert.ok(otpSubtext(win) && otpSubtext(win).includes('second@example.test'), 'OTP screen shows second@ email');

  // A fails late — must not surface an error or revert the screen
  win.eval(`window.__resolveFor('signin-send', 'first@example.test', { __status: 503, code: 'email_unavailable' })`);
  await tick(50);
  assert.ok(otpSubtext(win) && otpSubtext(win).includes('second@example.test'), 'OTP screen for second@ untouched by stale A failure');
});

/* ── signin: both fail — only current (B) error surfaces ── */

test('signin: send A, edit to B, send B — both fail — error shown is for B, screen usable', async (t) => {
  const { win } = await loadSettled(t);
  win.eval(`window.__handlers['signin-send'] = (body) => window.__deferFor('signin-send', body.email);`);
  win.eval('showSetupEmail()');

  byId(win, 'setup-email').value = 'first@example.test';
  byId(win, 's-email-go').click();
  await tick();

  byId(win, 'setup-email').value = 'second@example.test';
  byId(win, 'setup-email').dispatchEvent(new win.Event('input'));
  await tick();
  byId(win, 's-email-go').click();
  await tick();

  win.eval(`window.__resolveFor('signin-send', 'first@example.test', { __status: 503, code: 'email_unavailable' })`);
  await tick(50);
  // Stale A failure must not touch the (still in-flight, for B) button/error state
  assert.equal(byId(win, 's-email-go').disabled, true, 'button still disabled — B still in flight');

  win.eval(`window.__resolveFor('signin-send', 'second@example.test', { __status: 503, code: 'email_unavailable' })`);
  await tick(50);
  assert.equal(byId(win, 's-email-go').disabled, false, 'button re-enabled after B fails');
  assert.ok(byId(win, 's-email-err').textContent.length > 0, 'error shown for B');
});

/* ── signup: A-then-B ── */

test('signup: send A, edit to B, send B, A resolves first — OTP screen shows B, not A', async (t) => {
  const { win } = await loadSettled(t);
  win.eval(`window.__handlers['signup-send'] = (body) => window.__deferFor('signup-send', body.email);`);
  win.eval('showSetupSignupEmail()');

  byId(win, 'setup-signup-email').value = 'first@example.test';
  byId(win, 's-signup-go').click();
  await tick();

  byId(win, 'setup-signup-email').value = 'second@example.test';
  byId(win, 'setup-signup-email').dispatchEvent(new win.Event('input'));
  await tick();
  byId(win, 's-signup-go').click();
  await tick();

  win.eval(`window.__resolveFor('signup-send', 'first@example.test', { sent: true })`);
  await tick(50);
  assert.ok(!otpSubtext(win) || !otpSubtext(win).includes('first@example.test'), 'stale A success did not render OTP for first@');

  win.eval(`window.__resolveFor('signup-send', 'second@example.test', { sent: true })`);
  await tick(50);
  assert.ok(otpSubtext(win) && otpSubtext(win).includes('second@example.test'), 'OTP screen shows second@ email');
});

/* ── signup: B-then-A ── */

test('signup: send A, edit to B, send B, B resolves first then A resolves late — OTP screen stays on B', async (t) => {
  const { win } = await loadSettled(t);
  win.eval(`window.__handlers['signup-send'] = (body) => window.__deferFor('signup-send', body.email);`);
  win.eval('showSetupSignupEmail()');

  byId(win, 'setup-signup-email').value = 'first@example.test';
  byId(win, 's-signup-go').click();
  await tick();

  byId(win, 'setup-signup-email').value = 'second@example.test';
  byId(win, 'setup-signup-email').dispatchEvent(new win.Event('input'));
  await tick();
  byId(win, 's-signup-go').click();
  await tick();

  win.eval(`window.__resolveFor('signup-send', 'second@example.test', { sent: true })`);
  await tick(50);
  assert.ok(otpSubtext(win) && otpSubtext(win).includes('second@example.test'), 'OTP screen shows second@ email');

  win.eval(`window.__resolveFor('signup-send', 'first@example.test', { sent: true })`);
  await tick(50);
  assert.ok(otpSubtext(win) && otpSubtext(win).includes('second@example.test'), 'OTP screen still shows second@ email after late A resolution');
});

/* ── signup: A fails, B succeeds ── */

test('signup: send A, edit to B, send B — A fails late, B succeeds — no error flash, OTP shows B', async (t) => {
  const { win } = await loadSettled(t);
  win.eval(`window.__handlers['signup-send'] = (body) => window.__deferFor('signup-send', body.email);`);
  win.eval('showSetupSignupEmail()');

  byId(win, 'setup-signup-email').value = 'first@example.test';
  byId(win, 's-signup-go').click();
  await tick();

  byId(win, 'setup-signup-email').value = 'second@example.test';
  byId(win, 'setup-signup-email').dispatchEvent(new win.Event('input'));
  await tick();
  byId(win, 's-signup-go').click();
  await tick();

  win.eval(`window.__resolveFor('signup-send', 'second@example.test', { sent: true })`);
  await tick(50);
  assert.ok(otpSubtext(win) && otpSubtext(win).includes('second@example.test'), 'OTP screen shows second@ email');

  win.eval(`window.__resolveFor('signup-send', 'first@example.test', { __status: 503, code: 'email_unavailable' })`);
  await tick(50);
  assert.ok(otpSubtext(win) && otpSubtext(win).includes('second@example.test'), 'OTP screen for second@ untouched by stale A failure');
});

/* ── signup: both fail — only current (B) error surfaces ── */

test('signup: send A, edit to B, send B — both fail — error shown is for B, screen usable', async (t) => {
  const { win } = await loadSettled(t);
  win.eval(`window.__handlers['signup-send'] = (body) => window.__deferFor('signup-send', body.email);`);
  win.eval('showSetupSignupEmail()');

  byId(win, 'setup-signup-email').value = 'first@example.test';
  byId(win, 's-signup-go').click();
  await tick();

  byId(win, 'setup-signup-email').value = 'second@example.test';
  byId(win, 'setup-signup-email').dispatchEvent(new win.Event('input'));
  await tick();
  byId(win, 's-signup-go').click();
  await tick();

  win.eval(`window.__resolveFor('signup-send', 'first@example.test', { __status: 503, code: 'email_unavailable' })`);
  await tick(50);
  assert.equal(byId(win, 's-signup-go').disabled, true, 'button still disabled — B still in flight');

  win.eval(`window.__resolveFor('signup-send', 'second@example.test', { __status: 503, code: 'email_unavailable' })`);
  await tick(50);
  assert.equal(byId(win, 's-signup-go').disabled, false, 'button re-enabled after B fails');
  assert.ok(byId(win, 's-signup-err').textContent.length > 0, 'error shown for B');
});
