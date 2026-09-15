'use strict';
// Regression tests for the send-cooldown + navigation timing bug.
// Covers: setupScreenGen guards discard late responses after Back,
// cooldown persists across navigation so spam-resend is blocked,
// and failed sends clear the cooldown so the user can retry immediately.
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
    window.fetch = async (url, opts) => {
      const body = JSON.parse(opts.body);
      window.__fetch.push({ url, body, headers: opts.headers });
      const h = window.__handlers[body.action];
      const res = h ? (typeof h === 'function' ? h(body) : h) : { error: 'unknown action' };
      const status = res.__status || 200;
      return { ok: status < 400, status, json: async () => res };
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

/* ── sign-in: setupScreenGen guard ── */

test('signin: send then Back before response — late success does NOT overwrite welcome screen', async (t) => {
  const { win } = await loadSettled(t);
  // Make signin-send hang until we resolve it
  let resolveSend;
  win.eval(`
    window.__signinHang = new Promise(r => { window.__resolveSignin = r; });
    window.__handlers['signin-send'] = () => window.__signinHang;
  `);
  win.eval('showSetupEmail()');
  assert.ok(byId(win, 's-page-email'), 'on sign-in email screen');
  byId(win, 'setup-email').value = 'test@example.com';
  byId(win, 's-email-go').click();
  await tick();
  // Button should be disabled (sending)
  assert.equal(byId(win, 's-email-go').disabled, true, 'button disabled while sending');

  // User hits Back before the response arrives — goes to welcome
  byId(win, 's-email-back').click();
  await tick();
  // Should be on the welcome/setup screen now (s-page-email gone)
  const welcomeVisible = byId(win, 's1-in') || byId(win, 's-page-1');
  assert.ok(welcomeVisible, 'back to welcome screen');

  // Now resolve the hanging send — the late success should be discarded
  win.eval('window.__resolveSignin({ sent: true })');
  await tick(100);
  // The welcome screen should still be showing, NOT the OTP screen
  assert.ok(!byId(win, 'setup-otp'), 'late send success did NOT render OTP screen');
  assert.ok(!byId(win, 's-otp-go'), 'no verify button from stale response');
});

/* ── signup: setupScreenGen guard ── */

test('signup: send then Back before response — late success does NOT overwrite welcome screen', async (t) => {
  const { win } = await loadSettled(t);
  let resolveSend;
  win.eval(`
    window.__signupHang = new Promise(r => { window.__resolveSignup = r; });
    window.__handlers['signup-send'] = () => window.__signupHang;
  `);
  win.eval('showSetupSignupEmail()');
  assert.ok(byId(win, 's-page-signup'), 'on signup email screen');
  byId(win, 'setup-signup-email').value = 'test@example.com';
  byId(win, 's-signup-go').click();
  await tick();
  assert.equal(byId(win, 's-signup-go').disabled, true, 'button disabled while sending');

  // User hits Back before the response arrives
  byId(win, 's-signup-back').click();
  await tick();

  // Now resolve the hanging send
  win.eval('window.__resolveSignup({ sent: true })');
  await tick(100);
  // The signup OTP screen should NOT have appeared
  assert.ok(!byId(win, 's-page-signup-otp'), 'late send success did NOT render OTP screen');
});

/* ── signin: cooldown persists across navigation ── */

test('signin: send then Back before response then return to email — cannot re-send within cooldown', async (t) => {
  const { win } = await loadSettled(t);
  // Immediate success handler
  win.__handlers['signin-send'] = { sent: true };
  win.eval('showSetupEmail()');
  byId(win, 'setup-email').value = 'cool@example.com';
  byId(win, 's-email-go').click();
  await tick();
  // Send succeeded, now on OTP screen — go back
  assert.ok(byId(win, 'setup-otp') || byId(win, 's-otp-go'), 'reached OTP screen');
  // Navigate back to welcome
  byId(win, 's-otp-back').click();
  await tick();

  // Re-open the sign-in email screen
  win.eval('showSetupEmail()');
  byId(win, 'setup-email').value = 'cool@example.com';

  // Record fetch count before attempting resend
  const fetchCount = win.__fetch.length;
  byId(win, 's-email-go').click();
  await tick();

  // Should be blocked by cooldown — no new fetch, error shown
  assert.equal(win.__fetch.length, fetchCount, 'no new request sent during cooldown');
  assert.match(byId(win, 's-email-err').textContent, /already sent|wait/i, 'cooldown message shown');
});

/* ── signup: cooldown persists across navigation ── */

test('signup: send then Back before response then return to email — cannot re-send within cooldown', async (t) => {
  const { win } = await loadSettled(t);
  win.__handlers['signup-send'] = { sent: true };
  win.eval('showSetupSignupEmail()');
  byId(win, 'setup-signup-email').value = 'cool@example.com';
  byId(win, 's-signup-go').click();
  await tick();
  // Send succeeded, now on signup OTP screen — go back
  assert.ok(byId(win, 's-page-signup-otp'), 'reached signup OTP screen');
  byId(win, 's-otp-back').click();
  await tick();

  // Re-open the signup email screen
  win.eval('showSetupSignupEmail()');
  byId(win, 'setup-signup-email').value = 'cool@example.com';

  const fetchCount = win.__fetch.length;
  byId(win, 's-signup-go').click();
  await tick();

  assert.equal(win.__fetch.length, fetchCount, 'no new request sent during cooldown');
  assert.match(byId(win, 's-signup-err').textContent, /already sent|wait/i, 'cooldown message shown');
});

/* ── signin: failed send clears cooldown so user can retry ── */

test('signin: send fails — cooldown is cleared so user can retry immediately', async (t) => {
  const { win } = await loadSettled(t);
  // First send fails
  win.__handlers['signin-send'] = { __status: 503, code: 'email_unavailable' };
  win.eval('showSetupEmail()');
  byId(win, 'setup-email').value = 'retry@example.com';
  byId(win, 's-email-go').click();
  await tick();
  // Should show error, button re-enabled
  assert.equal(byId(win, 's-email-go').disabled, false, 'button re-enabled after failure');
  assert.ok(byId(win, 's-email-err').textContent.length > 0, 'error shown');

  // Cooldown should be cleared — user can retry immediately
  const cooldown = win.eval('emailSendCooldowns.get("retry@example.com")');
  assert.equal(cooldown, undefined, 'cooldown cleared after failure');

  // Now make it succeed and verify a retry works
  win.__handlers['signin-send'] = { sent: true };
  byId(win, 's-email-go').click();
  await tick();
  assert.ok(byId(win, 'setup-otp') || byId(win, 's-otp-go'), 'retry succeeded — on OTP screen');
});

/* ── signup: failed send clears cooldown so user can retry ── */

test('signup: send fails — cooldown is cleared so user can retry immediately', async (t) => {
  const { win } = await loadSettled(t);
  win.__handlers['signup-send'] = { __status: 503, code: 'email_unavailable' };
  win.eval('showSetupSignupEmail()');
  byId(win, 'setup-signup-email').value = 'retry@example.com';
  byId(win, 's-signup-go').click();
  await tick();
  assert.equal(byId(win, 's-signup-go').disabled, false, 'button re-enabled after failure');

  const cooldown = win.eval('emailSendCooldowns.get("retry@example.com")');
  assert.equal(cooldown, undefined, 'cooldown cleared after failure');

  // Retry with success
  win.__handlers['signup-send'] = { sent: true };
  byId(win, 's-signup-go').click();
  await tick();
  assert.ok(byId(win, 's-page-signup-otp'), 'retry succeeded — on OTP screen');
});

/* ── signin: cooldown set before await prevents spam during in-flight request ── */

test('signin: cooldown is set immediately on send (before await), blocking concurrent clicks', async (t) => {
  const { win } = await loadSettled(t);
  win.eval(`
    window.__signinHang2 = new Promise(r => { window.__resolveSignin2 = r; });
    window.__handlers['signin-send'] = () => window.__signinHang2;
  `);
  win.eval('showSetupEmail()');
  byId(win, 'setup-email').value = 'spam@example.com';
  byId(win, 's-email-go').click();
  await tick();

  // While request is in-flight, cooldown should already be set
  const cooldown = win.eval('emailSendCooldowns.get("spam@example.com")');
  assert.ok(cooldown && cooldown > Date.now(), 'cooldown set before response arrives');

  // Cleanup
  win.eval('window.__resolveSignin2({ sent: true })');
  await tick();
});

/* ── signup: cooldown set before await prevents spam during in-flight request ── */

test('signup: cooldown is set immediately on send (before await), blocking concurrent clicks', async (t) => {
  const { win } = await loadSettled(t);
  win.eval(`
    window.__signupHang2 = new Promise(r => { window.__resolveSignup2 = r; });
    window.__handlers['signup-send'] = () => window.__signupHang2;
  `);
  win.eval('showSetupSignupEmail()');
  byId(win, 'setup-signup-email').value = 'spam@example.com';
  byId(win, 's-signup-go').click();
  await tick();

  const cooldown = win.eval('emailSendCooldowns.get("spam@example.com")');
  assert.ok(cooldown && cooldown > Date.now(), 'cooldown set before response arrives');

  // Cleanup
  win.eval('window.__resolveSignup2({ sent: true })');
  await tick();
});
